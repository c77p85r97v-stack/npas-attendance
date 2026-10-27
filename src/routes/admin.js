// 管理者用API：修正申請の承認、スタッフ・PIN管理、勤怠記録の直接修正、操作履歴
import { json, readJson, HttpError } from '../lib/http.js';
import { adminLogin, destroySession, clearCookie, ADMIN_COOKIE, requireAdmin, pepper } from '../lib/auth.js';
import { hashSecret, randomPin, uuid, safeEqual, verifySecret } from '../lib/crypto.js';
import { validateAttendance, checkMonth } from '../lib/validate.js';
import { nowIso } from '../lib/time.js';
import { auditStmt, adminLabel } from '../lib/audit.js';
import { recordSnapshot } from './corrections.js';
import { insertAttendanceStmt, recordJson, fetchMonthEntries } from './attendance.js';

// ---------- ログイン ----------
export async function login(env, request) {
  const body = await readJson(request);
  const { admin, cookie } = await adminLogin(env, body.loginId, body.password);
  return json({ ok: true, admin }, 200, { 'Set-Cookie': cookie });
}
export async function logout(env, request) {
  await destroySession(env, request, 'admin');
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ADMIN_COOKIE) });
}
export async function me(env, request) {
  return json({ admin: await requireAdmin(env, request), environment: env.ENVIRONMENT || 'development' });
}

// ---------- 打刻修正申請 ----------
export async function listCorrections(env, request) {
  await requireAdmin(env, request);
  const status = new URL(request.url).searchParams.get('status') || '申請中';
  const stmt =
    status === 'all'
      ? env.DB.prepare('SELECT * FROM correction_requests ORDER BY requested_at DESC LIMIT 300')
      : env.DB.prepare('SELECT * FROM correction_requests WHERE status = ? ORDER BY requested_at').bind(status);
  const { results } = await stmt.all();
  return json({
    requests: results.map(r => ({
      id: r.id,
      requestedAt: r.requested_at,
      staffId: r.staff_id,
      name: r.staff_name,
      recordId: r.record_id,
      before: safeParse(r.before_json),
      after: safeParse(r.after_json),
      reason: r.reason,
      status: r.status,
      processedAt: r.processed_at,
      processedBy: r.processed_by,
      memo: r.admin_memo,
    })),
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function memoOf(body) {
  const memo = String(body.memo || '').trim();
  if (memo.length > 300) throw new HttpError(400, '管理者メモは300文字以内で入力してください');
  return memo;
}

const SAME_AS = `work_date = ? AND start_time = ? AND end_time = ? AND break_min = ? AND task = ? AND allowance IS ? AND hours = ?`;
const sameBinds = x => [x.date, x.start, x.end, Number(x.breakMin), x.task || '', x.allowance === '' || x.allowance == null ? null : Number(x.allowance), Number(x.hours)];

export async function approveCorrection(env, request, id) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const memo = memoOf(body);
  const req = await env.DB.prepare('SELECT * FROM correction_requests WHERE id = ?').bind(id).first();
  if (!req) throw new HttpError(404, '申請が見つかりません');
  if (req.status !== '申請中') throw new HttpError(409, `この申請は処理済みです（${req.status}）`);
  const before = safeParse(req.before_json);
  const afterRaw = safeParse(req.after_json);
  if (!before || !afterRaw) throw new HttpError(400, '申請データを読み取れません');
  // 承認時点でもう一度、勤怠計算の規則で検証する
  const v = validateAttendance(afterRaw);
  const after = { date: v.date, start: v.start, end: v.end, breakMin: v.br, task: v.task, allowance: v.allowance == null ? '' : v.allowance, hours: v.hours };
  const current = await env.DB.prepare('SELECT * FROM attendance WHERE id = ?').bind(req.record_id).first();
  if (!current) throw new HttpError(404, '対象の勤務記録が見つかりません');
  const at = nowIso();
  const who = adminLabel(admin);
  // 申請後に記録が変更されていないこと（変更前と一致）を条件に更新する
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE attendance
          SET work_date = ?, start_time = ?, end_time = ?, break_min = ?, task = ?, allowance = ?, hours = ?, updated_at = ?
        WHERE id = ? AND ${SAME_AS}
          AND EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = '申請中')`
    ).bind(v.date, v.start, v.end, v.br, v.task, v.allowance, v.hours, at, req.record_id, ...sameBinds(before), id),
    env.DB.prepare(
      `UPDATE correction_requests SET status = '承認', processed_at = ?, processed_by = ?, admin_memo = ?
        WHERE id = ? AND status = '申請中'
          AND EXISTS (SELECT 1 FROM attendance WHERE id = ? AND ${SAME_AS})`
    ).bind(at, who, memo, id, req.record_id, ...sameBinds(after)),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '打刻修正承認', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = '承認' AND processed_at = ?)`
    ).bind(at, req.record_id, who, JSON.stringify(recordSnapshot(current)), JSON.stringify({ ...after, requestId: id, memo }), id, at),
  ]);
  if (!res[1].meta || res[1].meta.changes !== 1) {
    throw new HttpError(409, '申請後に勤務記録が変更されています。この申請は却下し、必要なら再申請を依頼してください');
  }
  return json({ ok: true, status: '承認', recordChanged: res[0].meta.changes === 1 });
}

export async function rejectCorrection(env, request, id) {
  const admin = await requireAdmin(env, request);
  const memo = memoOf(await readJson(request));
  const at = nowIso();
  const who = adminLabel(admin);
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE correction_requests SET status = '却下', processed_at = ?, processed_by = ?, admin_memo = ?
        WHERE id = ? AND status = '申請中'`
    ).bind(at, who, memo, id),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '打刻修正却下', record_id, ?, '', ? FROM correction_requests WHERE id = ? AND status = '却下' AND processed_at = ?`
    ).bind(at, who, JSON.stringify({ requestId: id, memo }), id, at),
  ]);
  if (!upd.meta || upd.meta.changes !== 1) throw new HttpError(409, '申請が見つからないか、すでに処理済みです');
  return json({ ok: true, status: '却下' });
}

// ---------- スタッフ・PIN ----------
export async function listStaffAdmin(env, request) {
  await requireAdmin(env, request);
  const now = nowIso();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.nick, s.grade, s.active, s.pin_hash IS NOT NULL AS has_pin, s.pin_updated_at,
            s.locked_until, (c.staff_id IS NOT NULL) AS clocked_in, c.started_at
       FROM staff s LEFT JOIN clock_sessions c ON c.staff_id = s.id ORDER BY s.rowid`
  ).all();
  return json({
    staff: results.map(r => ({
      id: String(r.id),
      name: r.name,
      nick: r.nick,
      grade: String(r.grade),
      active: !!r.active,
      hasPin: !!r.has_pin,
      pinUpdatedAt: r.pin_updated_at,
      locked: !!(r.locked_until && r.locked_until > now),
      clockedIn: !!r.clocked_in,
      clockStartedAt: r.started_at,
    })),
  });
}

function staffInput(body) {
  const name = String(body.name || '').trim();
  const nick = String(body.nick || '').trim();
  const grade = String(body.grade ?? '').trim();
  if (!name || name.length > 50) throw new HttpError(400, '氏名を1〜50文字で入力してください');
  if (nick.length > 50) throw new HttpError(400, 'ニックネームは50文字以内で入力してください');
  if (!/^[1-9]$/.test(grade)) throw new HttpError(400, '学年を1〜9の数字で入力してください');
  return { name, nick, grade, active: body.active === false || body.active === 'false' ? 0 : 1 };
}

export async function saveStaff(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const v = staffInput(body);
  const at = nowIso();
  const who = adminLabel(admin);
  if (body.id) {
    const id = String(body.id);
    const old = await env.DB.prepare('SELECT id, name, nick, grade, active FROM staff WHERE id = ?').bind(id).first();
    if (!old) throw new HttpError(404, 'スタッフが見つかりません');
    // スタッフIDは変更しない（記録との対応を保つ）
    await env.DB.batch([
      env.DB.prepare('UPDATE staff SET name = ?, nick = ?, grade = ?, active = ?, updated_at = ? WHERE id = ?').bind(v.name, v.nick, v.grade, v.active, at, id),
      auditStmt(env, { action: 'スタッフ更新', recordId: id, operator: who, before: old, after: { id, ...v } }),
    ]);
    return json({ ok: true, id });
  }
  // 新規：旧 importNPASStaff32 と同じ「S + 3桁」の空き番号
  const { results } = await env.DB.prepare('SELECT id FROM staff').all();
  const used = new Set(results.map(r => String(r.id)));
  let n = 1;
  let id;
  do id = 'S' + String(n++).padStart(3, '0');
  while (used.has(id));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO staff (id, name, nick, grade, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, v.name, v.nick, v.grade, v.active, at, at),
    auditStmt(env, { action: 'スタッフ追加', recordId: id, operator: who, after: { id, ...v } }),
  ]);
  return json({ ok: true, id });
}

/** PINを発行（再発行）。表示されるのはこの1回だけ。 */
export async function issuePin(env, request, staffId) {
  const admin = await requireAdmin(env, request);
  const s = await env.DB.prepare('SELECT id, name, nick, grade FROM staff WHERE id = ?').bind(staffId).first();
  if (!s) throw new HttpError(404, 'スタッフが見つかりません');
  const pin = randomPin(6);
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE staff SET pin_hash = ?, pin_updated_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(await hashSecret(pin, pepper(env)), at, s.id),
    // 発行したスタッフのログイン中セッションは無効にする
    env.DB.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?").bind(s.id),
    auditStmt(env, { action: 'PIN発行', recordId: s.id, operator: adminLabel(admin) }), // PIN自体は記録しない
  ]);
  return json({ id: String(s.id), name: s.name, nick: s.nick, grade: String(s.grade), pin });
}

/**
 * PIN未設定の有効スタッフに発行する。
 * ハッシュ計算はCPUを使うため、無料プランの制限（1リクエスト10ms）に収まるよう
 * 1回に少人数ずつ処理する。管理画面が「残り0人」になるまで自動で繰り返す。
 */
export async function issueMissingPins(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const limit = Math.min(Math.max(Number(body.limit) || 2, 1), 20);
  const { results } = await env.DB.prepare(
    'SELECT id, name, nick, grade FROM staff WHERE active = 1 AND pin_hash IS NULL ORDER BY rowid LIMIT ?'
  ).bind(limit).all();
  if (!results.length) return json({ issued: [], remaining: 0 });
  const at = nowIso();
  const p = pepper(env);
  const issued = [];
  const rows = [];
  for (const s of results) {
    const pin = randomPin(6);
    rows.push({ id: String(s.id), hash: await hashSecret(pin, p) });
    issued.push({ id: String(s.id), name: s.name, nick: s.nick, grade: String(s.grade), pin });
  }
  // 1文でまとめて更新（無料プランの問い合わせ回数制限に配慮）
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE staff SET pin_hash = (SELECT json_extract(j.value, '$.hash') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = staff.id),
              pin_updated_at = ?2, failed_logins = 0, locked_until = NULL
        WHERE pin_hash IS NULL AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`
    ).bind(JSON.stringify(rows), at),
    auditStmt(env, { action: 'PIN一括発行', recordId: issued.map(s => s.id).join(','), operator: adminLabel(admin) }),
  ]);
  const rest = await env.DB.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND pin_hash IS NULL').first();
  return json({ issued, remaining: Number(rest.n) });
}

export async function unlockStaff(env, request, staffId) {
  const admin = await requireAdmin(env, request);
  const [r] = await env.DB.batch([
    env.DB.prepare('UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(staffId),
    auditStmt(env, { action: 'ログインロック解除', recordId: staffId, operator: adminLabel(admin) }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, 'スタッフが見つかりません');
  return json({ ok: true });
}

/** 出勤中のまま24時間を超えた場合などに、管理者が出勤状態を取り消す */
export async function cancelClock(env, request, staffId) {
  const admin = await requireAdmin(env, request);
  const s = await env.DB.prepare('SELECT * FROM clock_sessions WHERE staff_id = ?').bind(staffId).first();
  if (!s) throw new HttpError(404, 'このスタッフは出勤中ではありません');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM clock_sessions WHERE staff_id = ? AND session_id = ?').bind(staffId, s.session_id),
    auditStmt(env, { action: '出勤状態の取消', recordId: s.session_id, operator: adminLabel(admin), before: { staffId, startedAt: s.started_at } }),
  ]);
  return json({ ok: true });
}

// ---------- 勤怠記録の直接追加・修正・削除（管理者のみ） ----------
export async function listRecords(env, request) {
  await requireAdmin(env, request);
  const url = new URL(request.url);
  const month = checkMonth(url.searchParams.get('month'));
  const staffId = String(url.searchParams.get('staffId') || '');
  return json({ entries: await fetchMonthEntries(env, staffId, month) });
}

function reasonOf(body) {
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 300) throw new HttpError(400, '理由を1～300文字で入力してください');
  return reason;
}

export async function addRecord(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const reason = reasonOf(body);
  const s = await env.DB.prepare('SELECT id, name FROM staff WHERE id = ?').bind(String(body.staffId || '')).first();
  if (!s) throw new HttpError(404, 'スタッフが見つかりません');
  const v = validateAttendance(body);
  const id = uuid();
  const at = nowIso();
  const rec = { id, staffId: String(s.id), staffName: s.name, ...v, method: 'admin', requestId: null, at };
  await env.DB.batch([
    insertAttendanceStmt(env, rec),
    auditStmt(env, { action: '管理者による勤怠追加', recordId: id, operator: adminLabel(admin), after: { ...recordJson(rec), staffId: rec.staffId, reason }, onlyIfRecordId: id }),
  ]);
  return json({ ok: true, id, hours: v.hours });
}

export async function updateRecord(env, request, id) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const reason = reasonOf(body);
  const cur = await env.DB.prepare('SELECT * FROM attendance WHERE id = ?').bind(id).first();
  if (!cur) throw new HttpError(404, '対象の勤務記録が見つかりません');
  const v = validateAttendance(body);
  const before = recordSnapshot(cur);
  const at = nowIso();
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE attendance SET work_date = ?, start_time = ?, end_time = ?, break_min = ?, task = ?, allowance = ?, hours = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`
    ).bind(v.date, v.start, v.end, v.br, v.task, v.allowance, v.hours, at, id, cur.updated_at),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '管理者による勤怠修正', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attendance WHERE id = ? AND updated_at = ?)`
    ).bind(at, id, adminLabel(admin), JSON.stringify(before), JSON.stringify({ ...recordJson({ ...v }), reason }), id, at),
  ]);
  if (!upd.meta.changes) throw new HttpError(409, 'ほかの操作で記録が更新されました。画面を更新してからやり直してください');
  return json({ ok: true, hours: v.hours });
}

export async function deleteRecord(env, request, id) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const reason = reasonOf(body);
  const cur = await env.DB.prepare('SELECT * FROM attendance WHERE id = ?').bind(id).first();
  if (!cur) throw new HttpError(404, '対象の勤務記録が見つかりません');
  const pending = await env.DB.prepare("SELECT 1 FROM correction_requests WHERE record_id = ? AND status = '申請中'").bind(id).first();
  if (pending) throw new HttpError(409, 'この記録には審査待ちの修正申請があります。先に申請を処理してください');
  // 削除前の内容は操作履歴に全て残す（復元できるように）。削除できた場合だけ記録する。
  const before = JSON.stringify({ ...recordSnapshot(cur), rowOrder: cur.row_order, updatedAt: cur.updated_at });
  const [del] = await env.DB.batch([
    env.DB.prepare('DELETE FROM attendance WHERE id = ? AND updated_at = ?').bind(id, cur.updated_at),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '管理者による勤怠削除', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM attendance WHERE id = ?)`
    ).bind(nowIso(), id, adminLabel(admin), before, JSON.stringify({ reason }), id),
  ]);
  if (!del.meta.changes) throw new HttpError(409, 'ほかの操作で記録が更新されました。画面を更新してからやり直してください');
  return json({ ok: true });
}

// ---------- 操作履歴 ----------
export async function listAudit(env, request) {
  await requireAdmin(env, request);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
  const beforeId = Number(url.searchParams.get('beforeId')) || null;
  const stmt = beforeId
    ? env.DB.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').bind(beforeId, limit)
    : env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').bind(limit);
  const { results } = await stmt.all();
  return json({
    logs: results.map(r => ({ id: r.id, at: r.at, action: r.action, recordId: r.record_id, operator: r.operator, before: r.before_json, after: r.after_json })),
  });
}

// ---------- 管理者アカウント ----------
function passwordOf(v) {
  const pw = String(v ?? '');
  if (pw.length < 10 || pw.length > 200) throw new HttpError(400, 'パスワードは10文字以上にしてください');
  return pw;
}
function loginIdOf(v) {
  const id = String(v || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(id)) throw new HttpError(400, 'ログインIDは半角英数字（3〜40文字）で入力してください');
  return id;
}

/** 最初の管理者がまだいないか（初期設定が必要か） */
export async function setupStatus(env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE id <> 'test-admin'").first('n');
  return json({ needsSetup: Number(n) === 0, tokenConfigured: !!(env.ADMIN_SETUP_TOKEN && String(env.ADMIN_SETUP_TOKEN).length >= 16) });
}

/**
 * 最初の管理者を作る。サーバーに設定した ADMIN_SETUP_TOKEN（秘密の合言葉）が必要。
 * 管理者が1人でもいれば使えない。
 */
export async function setupFirstAdmin(env, request) {
  const body = await readJson(request);
  const token = String(env.ADMIN_SETUP_TOKEN || '');
  if (token.length < 16) throw new HttpError(403, '初期設定用の合言葉（ADMIN_SETUP_TOKEN）がサーバーに設定されていません');
  if (!safeEqual(String(body.setupToken || ''), token)) throw new HttpError(403, '初期設定用の合言葉が違います');
  const loginId = loginIdOf(body.loginId);
  const name = String(body.name || '').trim();
  if (!name || name.length > 50) throw new HttpError(400, '名前を1〜50文字で入力してください');
  const hash = await hashSecret(passwordOf(body.password), pepper(env));
  const id = uuid();
  const at = nowIso();
  // 「管理者が0人のときだけ」追加する（同時に実行されても1人だけ）
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admins (id, login_id, name, password_hash, created_at)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins WHERE id <> 'test-admin')`
    ).bind(id, loginId, name, hash, at),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '管理者の初期設定', ?, ?, '', '' WHERE EXISTS (SELECT 1 FROM admins WHERE id = ?)`
    ).bind(at, id, `管理者:${name} (${loginId})`, id),
  ]);
  if (!ins.meta.changes) throw new HttpError(409, '初期設定はすでに完了しています');
  return json({ ok: true });
}

export async function listAdmins(env, request) {
  await requireAdmin(env, request);
  const { results } = await env.DB.prepare("SELECT id, login_id, name, created_at FROM admins WHERE id <> 'test-admin' ORDER BY created_at").all();
  return json({ admins: results.map(a => ({ id: a.id, loginId: a.login_id, name: a.name, createdAt: a.created_at })) });
}

export async function addAdmin(env, request) {
  const me = await requireAdmin(env, request);
  const body = await readJson(request);
  const loginId = loginIdOf(body.loginId);
  const name = String(body.name || '').trim();
  if (!name || name.length > 50) throw new HttpError(400, '名前を1〜50文字で入力してください');
  const hash = await hashSecret(passwordOf(body.password), pepper(env));
  const id = uuid();
  const [ins] = await env.DB.batch([
    env.DB.prepare('INSERT INTO admins (id, login_id, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(id, loginId, name, hash, nowIso()),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '管理者の追加', ?, ?, '', ? WHERE EXISTS (SELECT 1 FROM admins WHERE id = ?)`
    ).bind(nowIso(), id, adminLabel(me), JSON.stringify({ loginId, name }), id),
  ]);
  if (!ins.meta.changes) throw new HttpError(409, 'そのログインIDはすでに使われています');
  return json({ ok: true, id });
}

export async function changeOwnPassword(env, request) {
  const me = await requireAdmin(env, request);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT password_hash FROM admins WHERE id = ?').bind(me.id).first();
  if (!row || !(await verifySecret(String(body.current ?? ''), row.password_hash, pepper(env)))) {
    throw new HttpError(400, '今のパスワードが違います');
  }
  const hash = await hashSecret(passwordOf(body.password), pepper(env));
  await env.DB.batch([
    env.DB.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').bind(hash, me.id),
    auditStmt(env, { action: '管理者パスワード変更', recordId: me.id, operator: adminLabel(me) }),
  ]);
  return json({ ok: true });
}
