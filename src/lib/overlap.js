// 勤務時間帯の重なりの判定（一括申請・通常申請・打刻・修正申請で共通）
// 勤務時間帯を「2000-01-01 からの通算分」で表す（日付をまたぐ勤務も1本の時間帯になる）。
// 例：10/31 22:00〜02:00 → 10/31 22:00 から 11/1 02:00 まで。
// 時間帯が接するだけ（13:00〜17:00 と 17:00〜19:00）は重なりとみなさない。
import { minutesBetween } from './validate.js';

const START_MIN = `(CAST(substr(a.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.start_time, 4, 2) AS INTEGER))`;
const END_MIN = `(CAST(substr(a.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.end_time, 4, 2) AS INTEGER))`;
const DAY_MIN = `(CAST(julianday(a.work_date) - julianday('2000-01-01') AS INTEGER) * 1440)`;
export const ABS_START = `(${DAY_MIN} + ${START_MIN})`;
export const ABS_END = `(${DAY_MIN} + ${START_MIN} + ((${END_MIN} - ${START_MIN} + 1440) % 1440))`;

export function absSpan(date, start, end) {
  const [y, m, d] = date.split('-').map(Number);
  const day = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2000, 0, 1)) / 86400000);
  const [h, mi] = start.split(':').map(Number);
  const s = day * 1440 + h * 60 + mi;
  return { start: s, end: s + minutesBetween(start, end) };
}

/**
 * 「a」という名前の attendance 行が、指定の時間帯と重なる条件（SQL の一部）。
 * 引数の順：staffId, date, date, spanStart, spanEnd
 */
export const OVERLAP_SQL = `a.staff_id = ? AND a.work_date BETWEEN date(?, '-1 day') AND date(?, '+1 day') AND ${ABS_START} < ? AND ? < ${ABS_END}`;
export const overlapBinds = (staffId, date, span) => [staffId, date, date, span.end, span.start];

/** 重なる記録を1件探す（excludeId の記録は除く） */
export async function findOverlap(env, staffId, date, start, end, excludeId = null) {
  const span = absSpan(date, start, end);
  return env.DB.prepare(
    `SELECT a.id, a.work_date, a.start_time, a.end_time FROM attendance a
      WHERE ${OVERLAP_SQL} AND a.id <> ? ORDER BY a.work_date, a.start_time LIMIT 1`
  )
    .bind(...overlapBinds(staffId, date, span), excludeId || '')
    .first();
}

export function overlapMessage(c) {
  const when = c ? `（${c.work_date.slice(5).replace('-', '/')} ${c.start_time}〜${c.end_time}）` : '';
  return `勤務時間が重なる記録が既にあります${when}`;
}
