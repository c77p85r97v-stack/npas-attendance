// 一括勤怠申請（旧 npasSaveBulkAttendance）
// 勤務時間帯が少しでも重なる記録が既にある人はスキップ（上書きしない）。
// 時間帯が接するだけ（例：13:00〜17:00 と 17:00〜19:00）は重なりとみなさない。
// 判定と登録は1つのSQL文で行うため、同時に申請されても重複登録されない。
import { json, readJson, HttpError } from '../lib/http.js';
import { requireStaff, assertSelf } from '../lib/auth.js';
import { validateAttendance, minutesBetween } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { staffLabel } from '../lib/audit.js';

export const BULK_MAX = 100;

// 勤務時間帯を「2000-01-01 からの通算分」で表す（日付をまたぐ勤務も1本の時間帯になる）
// 例：10/31 22:00〜02:00 → 10/31 22:00 から 11/1 02:00 まで
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

export async function saveBulk(env, request) {
  const startedAt = Date.now();
  const operator = await requireStaff(env, request);
  const body = await readJson(request);
  assertSelf(operator, body.operatorId);

  if (env.BULK_POLICY === 'disabled') throw new HttpError(403, '一括勤怠申請は現在利用できません。管理者に連絡してください');

  const staffIds = body.staffIds;
  if (!Array.isArray(staffIds) || staffIds.length === 0 || staffIds.length > BULK_MAX) {
    throw new HttpError(400, '申請するスタッフを1〜100名選択してください');
  }
  const ids = staffIds.map(String);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, 'スタッフの選択に重複または不正な値があります');
  }
  const v = validateAttendance(body);

  // 有効なスタッフかどうかを1回の問い合わせで確認
  const { results: found } = await env.DB.prepare(
    'SELECT id, name FROM staff WHERE active = 1 AND id IN (SELECT value FROM json_each(?))'
  )
    .bind(JSON.stringify(ids))
    .all();
  const byId = new Map(found.map(r => [String(r.id), r]));
  if (ids.some(id => !byId.has(id))) {
    throw new HttpError(400, '名簿にないスタッフが選択されています。画面を更新してください');
  }

  const at = nowIso();
  const span = absSpan(v.date, v.start, v.end);
  const rows = ids.map(id => ({ id: uuid(), sid: id, name: byId.get(id).name }));
  const t0 = Date.now();
  // 1文で「重複していない人だけ登録」し、登録できた人を RETURNING で受け取る
  const { results: inserted } = await env.DB.prepare(
    `INSERT INTO attendance
       (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours,
        method, row_order, client_request_id, source, created_at, updated_at)
     SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.sid'), json_extract(j.value, '$.name'),
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'bulk-manual',
            (SELECT COALESCE(MAX(row_order), 0) FROM attendance) + j.key + 1,
            NULL, 'app', ?8, ?8
       FROM json_each(?9) AS j
      WHERE NOT EXISTS (
        SELECT 1 FROM attendance a
         WHERE a.staff_id = json_extract(j.value, '$.sid')
           AND a.work_date BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
           AND ${ABS_START} < ?11 AND ?10 < ${ABS_END})
     RETURNING id, staff_id`
  )
    .bind(v.date, v.start, v.end, v.br, v.task, v.allowance, v.hours, at, JSON.stringify(rows), span.start, span.end)
    .all();
  const writeMs = Date.now() - t0;

  const savedIds = new Set(inserted.map(r => String(r.staff_id)));
  const saved = [];
  const skipped = [];
  const skippedIds = rows.filter(r => !savedIds.has(r.sid)).map(r => r.sid);
  // スキップした人について、重なった既存の記録を理由として示す
  const clash = new Map();
  if (skippedIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT a.staff_id, a.work_date, a.start_time, a.end_time FROM attendance a
        WHERE a.staff_id IN (SELECT value FROM json_each(?1))
          AND a.work_date BETWEEN date(?2, '-1 day') AND date(?2, '+1 day')
          AND ${ABS_START} < ?4 AND ?3 < ${ABS_END}
        ORDER BY a.work_date, a.start_time`
    )
      .bind(JSON.stringify(skippedIds), v.date, span.start, span.end)
      .all();
    for (const c of results) if (!clash.has(String(c.staff_id))) clash.set(String(c.staff_id), c);
  }
  for (const r of rows) {
    if (savedIds.has(r.sid)) {
      saved.push({ id: r.sid, name: r.name, recordId: r.id });
      continue;
    }
    const c = clash.get(r.sid);
    const when = c ? `（${c.work_date.slice(5).replace('-', '/')} ${c.start_time}〜${c.end_time}）` : '';
    skipped.push({ id: r.sid, name: r.name, reason: `勤務時間が重なる記録が既にあります${when}` });
  }

  // 代表者の操作履歴。失敗しても保存済みの勤怠は取り消さない（旧仕様と同じ）
  let auditWarning = '';
  if (saved.length) {
    try {
      await env.DB.prepare(
        'INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          nowIso(),
          '一括勤怠申請',
          saved.map(s => s.recordId).join(','),
          staffLabel(operator),
          '',
          JSON.stringify({
            date: v.date,
            start: v.start,
            end: v.end,
            breakMin: v.br,
            task: v.task,
            allowance: v.allowance == null ? '' : v.allowance,
            staff: saved.map(s => ({ id: s.id, name: s.name })),
            skipped: skipped.map(s => s.id),
          })
        )
        .run();
    } catch (e) {
      auditWarning = '勤怠は保存されましたが、代表者の操作履歴を記録できませんでした。管理者に確認してください。';
      console.error('N-PAS 一括申請の監査履歴エラー:', e && e.message);
    }
  }
  console.log(
    'NPAS bulk timing: ' + JSON.stringify({ totalMs: Date.now() - startedAt, writeMs, saved: saved.length, skipped: skipped.length })
  );
  return json({ saved, skipped, workDate: v.date, operator: operator.name, auditWarning, summaryUpdated: false });
}
