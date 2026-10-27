// 認証・認可
// ・スタッフ：名前を選択 ＋ PIN（4〜6桁）。名前の選択だけでは本人確認として扱わない。
// ・管理者：ログインID ＋ パスワード（スタッフとは別アカウント）
// ・ログイン後は HttpOnly Cookie のセッションで本人を特定する。
//   リクエストに含まれるスタッフIDは信用せず、必ずセッションのスタッフIDを使う。

import { HttpError } from './http.js';
import { randomToken, sha256Hex, verifySecret, hashSecret } from './crypto.js';
import { nowIso } from './time.js';

export const STAFF_COOKIE = 'npas_sid';
export const ADMIN_COOKIE = 'npas_admin';
const STAFF_TTL_MS = 12 * 60 * 60 * 1000; // 12時間
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000; // 8時間
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60 * 1000; // 15分

export function pepper(env) {
  if (env.PIN_PEPPER && String(env.PIN_PEPPER).length >= 16) return String(env.PIN_PEPPER);
  if (env.ENVIRONMENT === 'production') {
    throw new HttpError(500, 'サーバー設定が未完了です（PIN_PEPPER）。管理者に連絡してください。');
  }
  return 'npas-local-development-pepper';
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieHeader(name, value, maxAgeSec) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function clearCookie(name) {
  return cookieHeader(name, '', 0);
}

async function createSession(env, kind, subjectId) {
  const token = randomToken();
  const now = Date.now();
  const ttl = kind === 'admin' ? ADMIN_TTL_MS : STAFF_TTL_MS;
  const iso = nowIso(new Date(now));
  await env.DB.batch([
    // 期限切れのセッションを掃除
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(iso),
    env.DB.prepare(
      'INSERT INTO sessions (token_hash, kind, subject_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(await sha256Hex(token), kind, subjectId, nowIso(new Date(now + ttl)), iso),
  ]);
  return cookieHeader(kind === 'admin' ? ADMIN_COOKIE : STAFF_COOKIE, token, Math.floor(ttl / 1000));
}

export async function destroySession(env, request, kind) {
  const token = readCookie(request, kind === 'admin' ? ADMIN_COOKIE : STAFF_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

function lockedMessage(kind) {
  return kind === 'admin'
    ? 'パスワードを続けて間違えたため、15分間ログインできません'
    : 'PINを続けて間違えたため、15分間ログインできません。しばらく待ってからもう一度お試しください';
}

/** 失敗回数の記録（一定回数でロック）。成功時はリセット。 */
async function recordLoginResult(env, table, id, ok) {
  if (ok) {
    await env.DB.prepare(`UPDATE ${table} SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(id).run();
    return;
  }
  const lockUntil = nowIso(new Date(Date.now() + LOCK_MS));
  await env.DB.prepare(
    `UPDATE ${table}
       SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
     WHERE id = ?`
  )
    .bind(MAX_FAILED, lockUntil, id)
    .run();
}

function isLocked(row) {
  return row.locked_until && row.locked_until > nowIso();
}

/**
 * スタッフのログイン方式。
 *  'name' … 名前を選ぶだけ（旧システムと同じ。本人確認はしない）
 *  'pin'  … 名前 ＋ PIN
 * 設定 AUTH_MODE で切り替える（未設定なら安全側の 'pin'）。
 */
export function authMode(env) {
  return env.AUTH_MODE === 'name' ? 'name' : 'pin';
}

export async function staffLogin(env, staffId, pin) {
  staffId = String(staffId || '');
  pin = String(pin ?? '');
  if (!staffId) throw new HttpError(400, '名前を選択してね');
  if (authMode(env) === 'name') {
    const u = await env.DB.prepare('SELECT id, name, nick, grade FROM staff WHERE id = ? AND active = 1').bind(staffId).first();
    if (!u) throw new HttpError(401, 'スタッフが見つかりません。名簿を確認してください');
    const cookie = await createSession(env, 'staff', u.id);
    return { user: { id: u.id, name: u.name, nick: u.nick, grade: u.grade }, cookie };
  }
  if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'PINは4〜6桁の数字で入力してください');
  const u = await env.DB.prepare(
    'SELECT id, name, nick, grade, pin_hash, failed_logins, locked_until FROM staff WHERE id = ? AND active = 1'
  )
    .bind(staffId)
    .first();
  if (!u) throw new HttpError(401, 'スタッフが見つかりません。名簿を確認してください');
  if (isLocked(u)) throw new HttpError(429, lockedMessage('staff'));
  if (!u.pin_hash) throw new HttpError(403, 'PINが未設定です。管理者にPINの発行を依頼してください');
  // 失敗回数が上限に達してロック期間が過ぎた場合は数え直す
  if (u.failed_logins >= MAX_FAILED) {
    await env.DB.prepare('UPDATE staff SET failed_logins = 0 WHERE id = ?').bind(u.id).run();
  }
  const ok = await verifySecret(pin, u.pin_hash, pepper(env));
  await recordLoginResult(env, 'staff', u.id, ok);
  if (!ok) throw new HttpError(401, '名前またはPINが正しくありません');
  const cookie = await createSession(env, 'staff', u.id);
  return { user: { id: u.id, name: u.name, nick: u.nick, grade: u.grade }, cookie };
}

export async function adminLogin(env, loginId, password) {
  loginId = String(loginId || '').trim();
  password = String(password ?? '');
  if (!loginId || !password) throw new HttpError(400, 'ログインIDとパスワードを入力してください');
  const a = await env.DB.prepare(
    'SELECT id, login_id, name, password_hash, failed_logins, locked_until FROM admins WHERE login_id = ?'
  )
    .bind(loginId)
    .first();
  if (!a) {
    // 存在しないIDでも処理時間をそろえる
    await verifySecret(password, 'pbkdf2$20000$00$00', pepper(env));
    throw new HttpError(401, 'ログインIDまたはパスワードが正しくありません');
  }
  // テスト用管理者は、テスト用の道具が有効な環境（本番以外）でだけ使える
  if (a.id === 'test-admin' && !(env.ENVIRONMENT !== 'production' && env.ALLOW_TEST_TOOLS === 'true')) {
    throw new HttpError(401, 'ログインIDまたはパスワードが正しくありません');
  }
  if (isLocked(a)) throw new HttpError(429, lockedMessage('admin'));
  if (a.failed_logins >= MAX_FAILED) {
    await env.DB.prepare('UPDATE admins SET failed_logins = 0 WHERE id = ?').bind(a.id).run();
  }
  const ok = await verifySecret(password, a.password_hash, pepper(env));
  await recordLoginResult(env, 'admins', a.id, ok);
  if (!ok) throw new HttpError(401, 'ログインIDまたはパスワードが正しくありません');
  const cookie = await createSession(env, 'admin', a.id);
  return { admin: { id: a.id, loginId: a.login_id, name: a.name }, cookie };
}

/** ログイン中のスタッフを返す。未ログインなら 401。 */
export async function requireStaff(env, request) {
  const token = readCookie(request, STAFF_COOKIE);
  if (!token) throw new HttpError(401, 'ログインしてください（もう一度名前とPINを入力してください）');
  const u = await env.DB.prepare(
    `SELECT st.id, st.name, st.nick, st.grade
       FROM sessions s JOIN staff st ON st.id = s.subject_id
      WHERE s.token_hash = ? AND s.kind = 'staff' AND s.expires_at > ? AND st.active = 1`
  )
    .bind(await sha256Hex(token), nowIso())
    .first();
  if (!u) throw new HttpError(401, 'ログインの有効期限が切れました。ログアウトしてもう一度ログインしてください');
  return { id: String(u.id), name: u.name, nick: u.nick, grade: String(u.grade) };
}

export async function requireAdmin(env, request) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) throw new HttpError(401, '管理者としてログインしてください');
  const a = await env.DB.prepare(
    `SELECT a.id, a.login_id, a.name
       FROM sessions s JOIN admins a ON a.id = s.subject_id
      WHERE s.token_hash = ? AND s.kind = 'admin' AND s.expires_at > ?`
  )
    .bind(await sha256Hex(token), nowIso())
    .first();
  if (!a) throw new HttpError(401, '管理者ログインの有効期限が切れました。もう一度ログインしてください');
  if (a.id === 'test-admin' && !(env.ENVIRONMENT !== 'production' && env.ALLOW_TEST_TOOLS === 'true')) {
    throw new HttpError(401, '管理者としてログインしてください');
  }
  return { id: a.id, loginId: a.login_id, name: a.name };
}

/** スタッフ側から送られたスタッフIDがログイン本人と違う場合は拒否する */
export function assertSelf(user, claimedId) {
  if (claimedId != null && claimedId !== '' && String(claimedId) !== user.id) {
    throw new HttpError(403, 'ログイン中のスタッフ以外の記録は操作できません');
  }
}

export { hashSecret };
