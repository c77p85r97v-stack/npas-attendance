// 打刻修正申請（旧 npasSubmitCorrection）
// スタッフは「申請」だけできる。記録の変更は管理者の承認で行う（admin.js）。
import { json, readJson, HttpError } from '../lib/http.js';
import { requireStaff, assertSelf } from '../lib/auth.js';
import { validateAttendance } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { staffLabel } from '../lib/audit.js';

export const REASON_MAX = 300;

/** 旧 npasRecord_ と同じ形式（変更前JSON） */
export function recordSnapshot(r) {
  return {
    id: String(r.id),
    staffId: String(r.staff_id),
    name: r.staff_name,
    date: r.work_date,
    start: r.start_time,
    end: r.end_time,
    breakMin: Number(r.break_min) || 0,
    task: r.task || '',
    allowance: r.allowance == null ? '' : Number(r.allowance) || 0,
    hours: Number(r.hours) || 0,
    method: r.method || '',
  };
}

export async function submitCorrection(env, request) {
  const u = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(u, body.staffId);
  const why = String(body.reason || '').trim();
  if (!why || why.length > REASON_MAX) throw new HttpError(400, '修正理由を1～300文字で入力してください');
  const v = validateAttendance(body.input);

  const r = await env.DB.prepare('SELECT * FROM attendance WHERE id = ? AND staff_id = ?')
    .bind(String(body.recordId || ''), u.id)
    .first();
  if (!r) throw new HttpError(404, '対象の勤務記録が見つかりません');
  const before = recordSnapshot(r);
  const after = {
    date: v.date,
    start: v.start,
    end: v.end,
    breakMin: v.br,
    task: v.task,
    allowance: v.allowance == null ? '' : v.allowance,
    hours: v.hours,
  };
  const id = uuid();
  const at = nowIso();
  // 「申請中」は1記録につき1件だけ（一意インデックスでDBが保証）
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO correction_requests
         (id, requested_at, staff_id, staff_name, record_id, before_json, after_json, reason, status, admin_memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '申請中', '')
       ON CONFLICT DO NOTHING`
    ).bind(id, at, u.id, u.name, before.id, JSON.stringify(before), JSON.stringify(after), why),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '打刻修正申請', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM correction_requests WHERE id = ?)`
    ).bind(at, before.id, staffLabel(u), JSON.stringify(before), JSON.stringify({ ...after, reason: why, requestId: id }), id),
  ]);
  if (!ins.meta || ins.meta.changes !== 1) throw new HttpError(409, 'この記録には審査待ちの申請があります');
  return json({ requestId: id, status: '申請中' });
}


/**
 * 勤怠記録の削除申請。スタッフは申請だけ。管理者が承認すると記録が削除される。
 * 「申請中」は修正・削除を合わせて1記録につき1件まで。
 */
export async function submitDeletion(env, request) {
  const u = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(u, body.staffId);
  const why = String(body.reason || '').trim();
  if (!why || why.length > REASON_MAX) throw new HttpError(400, '削除の理由を1～300文字で入力してください');
  const r = await env.DB.prepare('SELECT * FROM attendance WHERE id = ? AND staff_id = ?')
    .bind(String(body.recordId || ''), u.id)
    .first();
  if (!r) throw new HttpError(404, '対象の勤務記録が見つかりません');
  const before = recordSnapshot(r);
  const id = uuid();
  const at = nowIso();
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO correction_requests
         (id, requested_at, staff_id, staff_name, record_id, before_json, after_json, reason, status, admin_memo, kind)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, '申請中', '', '削除')
       ON CONFLICT DO NOTHING`
    ).bind(id, at, u.id, u.name, before.id, JSON.stringify(before), why),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '削除申請', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM correction_requests WHERE id = ?)`
    ).bind(at, before.id, staffLabel(u), JSON.stringify(before), JSON.stringify({ reason: why, requestId: id }), id),
  ]);
  if (!ins.meta || ins.meta.changes !== 1) throw new HttpError(409, 'この記録には審査待ちの申請があります');
  return json({ requestId: id, status: '申請中' });
}
