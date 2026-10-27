// 出勤状態の取得・出勤打刻・退勤打刻（旧 clockStatus / clockIn / clockOut）
import { json, readJson, HttpError } from '../lib/http.js';
import { requireStaff, assertSelf } from '../lib/auth.js';
import { validateAttendance } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { jstDate, jstTime, nowIso } from '../lib/time.js';
import { auditStmt, staffLabel } from '../lib/audit.js';
import { checkRequestId, findByRequestId, recordJson } from './attendance.js';
import { findOverlap, overlapMessage } from '../lib/overlap.js';

const DAY_MS = 86400000;

export async function clockStatus(env, request) {
  const u = await requireStaff(env, request);
  assertSelf(u, new URL(request.url).searchParams.get('staffId'));
  const s = await env.DB.prepare('SELECT started_at FROM clock_sessions WHERE staff_id = ?').bind(u.id).first();
  return json({ active: !!s, startedAt: s ? s.started_at : null });
}

export async function clockIn(env, request, now = new Date()) {
  const u = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(u, body.staffId);
  const sessionId = uuid();
  // staff_id が主キーなので、同時に2回押されても1件しか入らない（二重出勤の防止）
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO clock_sessions (staff_id, session_id, started_at) VALUES (?, ?, ?) ON CONFLICT(staff_id) DO NOTHING'
    ).bind(u.id, sessionId, nowIso(now)),
    env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, '出勤打刻', ?, ?, '', ? WHERE EXISTS (SELECT 1 FROM clock_sessions WHERE session_id = ?)`
    ).bind(nowIso(now), sessionId, staffLabel(u), JSON.stringify({ startedAt: nowIso(now) }), sessionId),
  ]);
  if (!ins.meta || ins.meta.changes !== 1) throw new HttpError(409, 'すでに出勤打刻済みです');
  return json({ time: jstTime(now) });
}

export async function clockOut(env, request, now = new Date()) {
  const u = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(u, body.staffId);
  const requestId = checkRequestId(body.requestId);

  // 通信エラー後の再送：前回の退勤が保存済みならその結果を返す（二重登録しない）
  const dup = await findByRequestId(env, u.id, requestId);
  if (dup) return json(dup);

  const s = await env.DB.prepare('SELECT session_id, started_at FROM clock_sessions WHERE staff_id = ?')
    .bind(u.id)
    .first();
  if (!s) throw new HttpError(400, '先に出勤してください');
  const a = new Date(s.started_at);
  if (now - a >= DAY_MS) throw new HttpError(400, '24時間以上の勤務は管理者に連絡してください');

  const v = validateAttendance({
    date: jstDate(a),
    start: jstTime(a),
    end: jstTime(now),
    breakMin: body.breakMin,
    task: body.task,
    allowance: body.allowance,
  });

  const id = s.session_id; // 出勤ごとに1つの記録IDに固定 → 同時に退勤しても1件だけ
  const at = nowIso(now);
  const rec = { id, staffId: u.id, staffName: u.name, ...v, method: 'clock', requestId, at };
  // 1つのトランザクションで「勤怠記録の保存」と「出勤中の解除」を行う。
  // 解除は、記録が保存されている場合だけ実行される。
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attendance
         (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours,
          method, row_order, client_request_id, source, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clock', (SELECT COALESCE(MAX(row_order), 0) + 1 FROM attendance), ?, 'app', ?, ?
        WHERE EXISTS (SELECT 1 FROM clock_sessions WHERE staff_id = ? AND session_id = ?)
       ON CONFLICT DO NOTHING`
    ).bind(id, u.id, u.name, v.date, v.start, v.end, v.br, v.task, v.allowance, v.hours, requestId, at, at, u.id, id),
    env.DB.prepare(
      `DELETE FROM clock_sessions
        WHERE staff_id = ? AND session_id = ? AND EXISTS (SELECT 1 FROM attendance WHERE id = ?)`
    ).bind(u.id, id, id),
    auditStmt(env, { action: '退勤打刻', recordId: id, operator: staffLabel(u), after: recordJson(rec), onlyIfRecordId: id }),
  ]);

  if (!ins.meta || ins.meta.changes !== 1) {
    // 別の通信で同じ出勤の退勤が先に保存された場合
    const r = await env.DB.prepare('SELECT id, work_date, hours FROM attendance WHERE id = ? AND staff_id = ?')
      .bind(id, u.id)
      .first();
    if (r) return json({ id: r.id, hours: r.hours, workDate: r.work_date, summaryUpdated: false, duplicate: true });
    throw new HttpError(409, '退勤を保存できませんでした。出勤状況を確認してください');
  }
  // 打刻は実際の時刻なので保存は止めない。ほかの記録と重なっていれば知らせる。
  const clash = await findOverlap(env, u.id, v.date, v.start, v.end, id);
  const warning = clash ? overlapMessage(clash) + '。打刻修正か削除申請で直してください' : '';
  return json({ id, hours: v.hours, workDate: v.date, summaryUpdated: false, warning });
}
