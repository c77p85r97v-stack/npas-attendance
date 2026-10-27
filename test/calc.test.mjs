// 勤怠計算・入力検証のテスト（旧 validate_ と同じ結果になること）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAttendance, checkDate, checkTime, minutesBetween, monthRange } from '../src/lib/validate.js';
import { jstDate, jstTime } from '../src/lib/time.js';

const ok = o => validateAttendance({ date: '2026-10-05', start: '10:00', end: '15:00', breakMin: 0, ...o });
const ng = (o, msg) => assert.throws(() => ok(o), e => e.message === msg, msg);

test('日付：YYYY-MM-DD 形式で実在する日付だけ受け付ける', () => {
  assert.equal(checkDate('2026-10-05'), '2026-10-05');
  assert.equal(checkDate('2024-02-29'), '2024-02-29'); // うるう年
  assert.throws(() => checkDate('2025-02-29'), /存在しない日付です/);
  assert.throws(() => checkDate('2026-04-31'), /存在しない日付です/);
  assert.throws(() => checkDate('2026-13-01'), /存在しない日付です/);
  assert.throws(() => checkDate('2026-00-10'), /存在しない日付です/);
  assert.throws(() => checkDate('2026/10/05'), /日付が不正です/);
  assert.throws(() => checkDate('2026-1-5'), /日付が不正です/);
  assert.throws(() => checkDate(''), /日付が不正です/);
  assert.throws(() => checkDate("2026-10-05' OR 1=1"), /日付が不正です/);
});

test('時刻：HH:mm の24時間表記だけ受け付ける', () => {
  for (const t of ['00:00', '09:05', '23:59', '12:30']) assert.equal(checkTime(t), t);
  for (const t of ['24:00', '9:05', '12:60', '12:5', '12:30:00', 'ab:cd', '', '-1:00']) {
    assert.throws(() => checkTime(t), /時刻が不正です/, t);
  }
});

test('勤務時間：出勤〜退勤から休憩を引き、時間単位で小数第2位に丸める', () => {
  assert.equal(ok({}).hours, 5);
  assert.equal(ok({ breakMin: 60 }).hours, 4);
  assert.equal(ok({ start: '10:00', end: '10:20' }).hours, 0.33); // 20分 = 0.333…
  assert.equal(ok({ start: '10:00', end: '10:40' }).hours, 0.67); // 40分 = 0.666…
  assert.equal(ok({ start: '10:00', end: '10:01' }).hours, 0.02); // 1分 = 0.0166…
  assert.equal(ok({ start: '09:00', end: '17:45', breakMin: 45 }).hours, 8);
});

test('日付をまたぐ勤務：退勤が出勤より前なら翌日退勤として計算する', () => {
  assert.equal(minutesBetween('22:00', '02:00'), 240);
  assert.equal(ok({ start: '22:00', end: '02:00' }).hours, 4);
  assert.equal(ok({ start: '23:59', end: '00:00' }).hours, 0.02); // 1分
  assert.equal(ok({ start: '00:00', end: '23:59' }).hours, 23.98);
  assert.equal(ok({ start: '10:01', end: '10:00' }).hours, 23.98); // ほぼ24時間（翌日）
  assert.equal(ok({ start: '18:00', end: '06:00', breakMin: 60 }).hours, 11);
  // 勤務日は出勤日のまま
  assert.equal(ok({ start: '22:00', end: '02:00' }).date, '2026-10-05');
});

test('実勤務時間が0以下なら拒否する', () => {
  ng({ start: '10:00', end: '10:00' }, '出退勤時刻と休憩時間を確認してください');
  ng({ start: '10:00', end: '11:00', breakMin: 60 }, '出退勤時刻と休憩時間を確認してください');
  ng({ start: '10:00', end: '11:00', breakMin: 61 }, '出退勤時刻と休憩時間を確認してください');
  assert.equal(ok({ start: '10:00', end: '11:00', breakMin: 59 }).hours, 0.02);
});

test('休憩時間：0以上1440未満の整数', () => {
  assert.equal(ok({ breakMin: '' }).br, 0); // 空欄は0（旧仕様）
  assert.equal(ok({ breakMin: undefined }).br, 0);
  assert.equal(ok({ breakMin: '30' }).br, 30);
  ng({ breakMin: -1 }, '休憩時間を確認してください');
  ng({ breakMin: 1.5 }, '休憩時間を確認してください');
  ng({ breakMin: 'abc' }, '休憩時間を確認してください');
  ng({ breakMin: 1440 }, '休憩時間を確認してください');
  ng({ start: '00:00', end: '23:59', breakMin: 1439 }, '出退勤時刻と休憩時間を確認してください');
});

test('手当：空欄可・0以上・上限100万円・不正値は拒否', () => {
  assert.equal(ok({ allowance: '' }).allowance, null);
  assert.equal(ok({ allowance: null }).allowance, null);
  assert.equal(ok({ allowance: '0' }).allowance, 0);
  assert.equal(ok({ allowance: '1500' }).allowance, 1500);
  assert.equal(ok({ allowance: 1000000 }).allowance, 1000000);
  ng({ allowance: '1000001' }, '手当を確認してください');
  ng({ allowance: '-1' }, '手当を確認してください');
  ng({ allowance: 'abc' }, '手当を確認してください');
  ng({ allowance: 'Infinity' }, '手当を確認してください');
});

test('業務内容：前後の空白を除き、200文字まで', () => {
  assert.equal(ok({ task: '  受付  ' }).task, '受付');
  assert.equal(ok({ task: 'あ'.repeat(250) }).task.length, 200);
  assert.equal(ok({ task: undefined }).task, '');
});

test('月の範囲：月末・年末をまたいでも正しい', () => {
  assert.deepEqual(monthRange('2026-10'), ['2026-10-01', '2026-11-01']);
  assert.deepEqual(monthRange('2026-12'), ['2026-12-01', '2027-01-01']);
  assert.throws(() => monthRange('2026-13'), /年月が不正です/);
});

test('日本時間への変換（サーバーはUTC）', () => {
  // 2026-10-05 23:30 JST = 14:30 UTC
  const d = new Date(Date.UTC(2026, 9, 5, 14, 30));
  assert.equal(jstDate(d), '2026-10-05');
  assert.equal(jstTime(d), '23:30');
  // 2026-10-06 00:10 JST = 2026-10-05 15:10 UTC → 日付は6日
  const e = new Date(Date.UTC(2026, 9, 5, 15, 10));
  assert.equal(jstDate(e), '2026-10-06');
  assert.equal(jstTime(e), '00:10');
});
