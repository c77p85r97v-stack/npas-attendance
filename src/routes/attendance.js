// 通常の勤怠申請（旧 saveAttendance）と勤務履歴（旧 getHistory）
import { json, readJson, HttpError } from '../lib/http.js';
import { requireStaff, assertSelf } from '../lib/auth.js';
import { validateAttendance, checkMonth, monthRange } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { auditStmt, staffLabel } from '../lib/audit.js';
import { OVERLAP_SQL, overlapBinds, absSpan, findOverlap, overlapMessage } from '../lib/overlap.js';

export function checkRequestId(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) throw new HttpError(400, '送信データの形式が不正です');
  return s;
}

/**
 * 勤怠記録1件を追加する文（row_order は末尾）。
 * noOverlap: true なら、同じ人の勤務時間帯と重なる記録があるときは追加しない（判定と追加が1つの文なので同時送信でも確実）。
 */
export function insertAttendanceStmt(env, rec, { noOverlap = false } = {}) {
  const guard = noOverlap ? `AND NOT EXISTS (SELECT 1 FROM attendance a WHERE ${OVERLAP_SQL})` : '';
  const stmt = env.DB.prepare(
    `INSERT INTO attendance
       (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours,
        method, row_order, client_request_id, source, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(row_order), 0) + 1 FROM attendance), ?, 'app', ?, ?
      WHERE 1 ${guard}
     ON CONFLICT DO NOTHING`
  );
  const binds = [
    rec.id,
    rec.staffId,
    rec.staffName,
    rec.date,
    rec.start,
    rec.end,
    rec.br,
    rec.task,
    rec.allowance,
    rec.hours,
    rec.method,
    rec.requestId ?? null,
    rec.at,
    rec.at,
  ];
  if (noOverlap) binds.push(...overlapBinds(rec.staffId, rec.date, absSpan(rec.date, rec.start, rec.end)));
  return stmt.bind(...binds);
}

/** 再送された申請（同じ requestId）なら、最初に保存した記録を返す */
export async function findByRequestId(env, staffId, requestId) {
  if (!requestId) return null;
  const r = await env.DB.prepare('SELECT id, staff_id, work_date, hours FROM attendance WHERE client_request_id = ?')
    .bind(requestId)
    .first();
  if (!r) return null;
  if (String(r.staff_id) !== staffId) throw new HttpError(409, '送信データが重複しています。画面を更新してください');
  return { id: r.id, hours: r.hours, workDate: r.work_date, summaryUpdated: false, duplicate: true };
}

export async function saveAttendance(env, request) {
  const u = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(u, body.staffId);
  const v = validateAttendance(body);
  const requestId = checkRequestId(body.requestId);

  const dup = await findByRequestId(env, u.id, requestId);
  if (dup) return json(dup);

  const id = uuid();
  const at = nowIso();
  const rec = { id, staffId: u.id, staffName: u.name, ...v, method: 'manual', requestId, at };
  await env.DB.batch([
    insertAttendanceStmt(env, rec, { noOverlap: true }),
    auditStmt(env, {
      action: '勤怠申請',
      recordId: id,
      operator: staffLabel(u),
      after: recordJson(rec),
      onlyIfRecordId: id,
    }),
  ]);
  const saved = await env.DB.prepare('SELECT id FROM attendance WHERE id = ?').bind(id).first();
  if (!saved) {
    // 同時に同じ requestId で送られた場合：先に保存された方を返す
    const again = await findByRequestId(env, u.id, requestId);
    if (again) return json(again);
    const clash = await findOverlap(env, u.id, v.date, v.start, v.end);
    if (clash) throw new HttpError(409, overlapMessage(clash) + '。時刻を確認してください');
    throw new HttpError(500, '保存を確認できませんでした。勤務履歴を確認してから再度お試しください');
  }
  // 集計は保存とは別処理（集計は取得時に計算するため、ここでは更新不要）
  return json({ id, hours: v.hours, workDate: v.date, summaryUpdated: false });
}

export function recordJson(rec) {
  return {
    date: rec.date,
    start: rec.start,
    end: rec.end,
    breakMin: rec.br,
    task: rec.task,
    allowance: rec.allowance == null ? '' : rec.allowance,
    hours: rec.hours,
  };
}

/** DBの行 → 画面に返す形式（旧 getHistory と同じ項目名） */
export function rowToEntry(r) {
  return {
    id: String(r.id),
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

export async function fetchMonthEntries(env, staffId, month) {
  const [from, to] = monthRange(month);
  const { results } = await env.DB.prepare(
    `SELECT id, work_date, start_time, end_time, break_min, task, allowance, hours, method
       FROM attendance
      WHERE staff_id = ? AND work_date >= ? AND work_date < ?
      ORDER BY row_order`
  )
    .bind(staffId, from, to)
    .all();
  return results.map(rowToEntry);
}

export async function getHistory(env, request) {
  const u = await requireStaff(env, request);
  const url = new URL(request.url);
  assertSelf(u, url.searchParams.get('staffId'));
  const month = checkMonth(url.searchParams.get('month'));
  const entries = await fetchMonthEntries(env, u.id, month);
  const totalHours = Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100;
  return json({ entries, totalHours });
}
