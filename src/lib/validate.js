// 勤怠の入力チェックと勤務時間の計算。
// 旧コード.gs の date_ / time_ / minutes_ / validate_ と同じ動きにしています。

import { HttpError } from './http.js';

export function checkDate(s) {
  s = String(s ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, '日付が不正です');
  const [y, m, d] = s.split('-').map(Number);
  // タイムゾーンの影響を受けないよう UTC で実在チェックする
  const x = new Date(Date.UTC(y, m - 1, d));
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) {
    throw new HttpError(400, '存在しない日付です');
  }
  return s;
}

export function checkTime(s) {
  s = String(s ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, '時刻が不正です');
  return s;
}

export function checkMonth(s) {
  s = String(s ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new HttpError(400, '年月が不正です');
  return s;
}

/** 出勤→退勤の分数。退勤が出勤より前なら翌日退勤として扱う。 */
export function minutesBetween(a, b) {
  const f = t => {
    const x = t.split(':').map(Number);
    return x[0] * 60 + x[1];
  };
  let v = f(b) - f(a);
  if (v < 0) v += 1440;
  return v;
}

export const ALLOWANCE_MAX = 1000000;
export const TASK_MAX = 200;

/**
 * 旧 validate_ と同じ規則で入力を検証する。
 * 戻り値の allowance は空欄なら null（旧シートでは空文字）。
 */
export function validateAttendance(input, { requireTask = false } = {}) {
  input = input || {};
  const date = checkDate(String(input.date || ''));
  const start = checkTime(String(input.start || ''));
  const end = checkTime(String(input.end || ''));
  const br = Number(input.breakMin || 0);
  const allowance = input.allowance === '' || input.allowance == null ? null : Number(input.allowance);

  if (!Number.isInteger(br) || br < 0 || br >= 1440) {
    throw new HttpError(400, '休憩時間を確認してください');
  }
  if (allowance !== null && (!Number.isFinite(allowance) || allowance < 0 || allowance > ALLOWANCE_MAX)) {
    throw new HttpError(400, '手当を確認してください');
  }
  const mins = minutesBetween(start, end) - br;
  if (mins <= 0) throw new HttpError(400, '出退勤時刻と休憩時間を確認してください');
  const task = String(input.task || '').trim().slice(0, TASK_MAX);
  // スタッフが入力する申請では業務内容を必須にする（管理者の修正・旧データの移行は空欄も可）
  if (requireTask && !task) throw new HttpError(400, '業務内容を入力してください');

  return {
    date,
    start,
    end,
    br,
    allowance,
    task,
    hours: Math.round((mins / 60) * 100) / 100,
  };
}

/** 対象月の [開始日, 翌月1日) を返す。インデックスで範囲検索するため。 */
export function monthRange(month) {
  checkMonth(month);
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}
