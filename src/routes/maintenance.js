// 運用のための機能：テスト記録の初期化・バックアップ（管理者のみ）
// バックアップの保存先は動かす場所によって違うため、env.BACKUPS（Vercel 版で用意）を通して行う。
// Cloudflare 版では env.BACKUPS がないため、D1 の Time Travel（自動の復元機能）を使う。
import { json, readJson, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { adminLabel } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';

const CONFIRM_WORD = '初期化';

/** 消す前の件数 */
async function counts(env) {
  const [a, c, l, k] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM attendance'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM correction_requests'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM clock_sessions'),
  ]);
  return { attendance: a.results[0].n, requests: c.results[0].n, audit: l.results[0].n, clockedIn: k.results[0].n };
}

export async function resetPreview(env, request) {
  await requireAdmin(env, request);
  return json({ counts: await counts(env), backups: !!env.BACKUPS });
}

/**
 * テスト記録の初期化（旧 npasResetTestHistory と同じ考え方）
 * ・残す：スタッフ名簿、管理者、設定
 * ・消す：勤怠記録、修正・削除申請、出勤中の状態、操作履歴、スタッフのログイン状態
 * ・消す前に必ずバックアップを作る（作れなければ何も消さない）
 */
export async function resetHistory(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  if (String(body.confirm || '') !== CONFIRM_WORD) {
    throw new HttpError(400, `確認のため「${CONFIRM_WORD}」と入力してください`);
  }
  const before = await counts(env);
  let backup = null;
  if (env.BACKUPS) {
    backup = await env.BACKUPS.create('before-reset'); // 失敗したら例外になり、ここで止まる
  }
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM correction_requests'),
    env.DB.prepare('DELETE FROM clock_sessions'),
    env.DB.prepare('DELETE FROM attendance'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare("DELETE FROM sessions WHERE kind = 'staff'"),
    env.DB.prepare(
      "INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, 'テスト記録の初期化', '', ?, ?, ?)"
    ).bind(at, adminLabel(admin), JSON.stringify(before), JSON.stringify({ backup: backup ? backup.name : 'D1 Time Travel' })),
  ]);
  return json({
    ok: true,
    deleted: before,
    backup: backup ? backup.name : null,
    message: backup
      ? `初期化しました。初期化前の状態はバックアップ「${backup.name}」に保存してあります。`
      : '初期化しました。初期化前の状態には、Cloudflare D1 の Time Travel で戻せます（README 7章）。',
  });
}

export async function listBackups(env, request) {
  await requireAdmin(env, request);
  if (!env.BACKUPS) return json({ supported: false, backups: [] });
  return json({ supported: true, backups: await env.BACKUPS.list() });
}

export async function createBackup(env, request) {
  const admin = await requireAdmin(env, request);
  if (!env.BACKUPS) throw new HttpError(404, 'この環境では D1 の Time Travel を使ってください');
  const b = await env.BACKUPS.create('manual');
  await env.DB.prepare(
    "INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, 'バックアップ作成', ?, ?, '', '')"
  )
    .bind(nowIso(), b.name, adminLabel(admin))
    .run();
  return json({ ok: true, backup: b });
}

export async function downloadBackup(env, request) {
  await requireAdmin(env, request);
  if (!env.BACKUPS) throw new HttpError(404, 'この環境ではバックアップ機能を使えません');
  const name = String(new URL(request.url).searchParams.get('name') || '');
  const bytes = await env.BACKUPS.read(name);
  if (!bytes) throw new HttpError(404, 'バックアップが見つかりません');
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}.sqlite"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** バックアップから復元（復元前の状態も自動でバックアップする） */
export async function restoreBackup(env, request) {
  const admin = await requireAdmin(env, request);
  if (!env.BACKUPS) throw new HttpError(404, 'この環境では D1 の Time Travel を使ってください');
  const body = await readJson(request);
  if (String(body.confirm || '') !== '復元') throw new HttpError(400, '確認のため「復元」と入力してください');
  const name = String(body.name || '');
  if (!(await env.BACKUPS.read(name))) throw new HttpError(404, 'バックアップが見つかりません');
  const safety = await env.BACKUPS.create('before-restore');
  await env.BACKUPS.restore(name, { operator: adminLabel(admin) });
  return json({ ok: true, restored: name, backup: safety.name, message: `「${name}」の状態に戻しました。戻す前の状態は「${safety.name}」に保存してあります。` });
}

/** 毎日の自動バックアップ（Vercel Cron から呼ばれる。CRON_SECRET で保護） */
export async function cronBackup(env, request) {
  const secret = String(env.CRON_SECRET || '');
  const auth = request.headers.get('Authorization') || '';
  if (secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) throw new HttpError(401, '認証が必要です');
  if (!env.BACKUPS) throw new HttpError(404, 'この環境ではバックアップ機能を使えません');
  const b = await env.BACKUPS.create('daily');
  const removed = await env.BACKUPS.prune({ keepDaily: 30 });
  return json({ ok: true, backup: b.name, removed });
}
