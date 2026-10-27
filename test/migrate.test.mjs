// データ移行のテスト（スプレッドシートの書き出しデータ → D1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, adminClient, loginAs, Client } from './helpers.mjs';
import { runMigration, parseCsv, detectSheet, parseExportJson } from '../public/js/migrate-client.js';

// 旧スプレッドシートを書き出したもの（表示値の揺れを含む）
function gasExport() {
  return {
    format: 'npas-gas-export',
    version: 1,
    sheets: {
      スタッフ名簿: [
        { _row: 2, スタッフID: 'S001', 氏名: 'サンプルスタッフ', ニックネーム: 'サンプル', 学年: 1, 有効: true },
        { _row: 3, スタッフID: 'S002', 氏名: '青空 みなみ', ニックネーム: 'みなみん', 学年: 2, 有効: 'TRUE' },
        { _row: 4, スタッフID: 'S003', 氏名: '山田 晴人', ニックネーム: 'はるっち', 学年: 2, 有効: 'FALSE' },
      ],
      勤怠データ: [
        { _row: 2, 記録ID: 'r-1', スタッフID: 'S002', 氏名: '青空 みなみ', 勤務日: '2026/10/01', 出勤: '10:00:00', 退勤: '15:00:00', '休憩(分)': 60, 業務内容: '受付', '手当(円)': '', '勤務時間(時間)': 4, 登録方法: 'manual', 更新日時: '2026-10-01T15:01:02+09:00' },
        { _row: 3, 記録ID: 'r-2', スタッフID: 'S002', 氏名: '青空 みなみ', 勤務日: '2026-10-02', 出勤: '9:05', 退勤: '13:00', '休憩(分)': 0, 業務内容: '', '手当(円)': '1,000', '勤務時間(時間)': 3.92, 登録方法: 'clock', 更新日時: '2026/10/02 13:00:05' },
        { _row: 4, 記録ID: 'r-3', スタッフID: 'S003', 氏名: '山田 晴人', 勤務日: '2026-10-03', 出勤: '22:00', 退勤: '02:00', '休憩(分)': 0, 業務内容: '夜間', '手当(円)': 0, '勤務時間(時間)': 4, 登録方法: 'bulk-manual', 更新日時: '' },
        // 勤務時間が再計算値と違う（警告のみ・記録の値で取り込む）
        { _row: 5, 記録ID: 'r-4', スタッフID: 'S002', 氏名: '青空 みなみ', 勤務日: '2026-10-04', 出勤: '10:00', 退勤: '12:00', '休憩(分)': 0, 業務内容: '', '手当(円)': '', '勤務時間(時間)': 2.5, 登録方法: 'manual', 更新日時: '' },
        // エラー：存在しない日付・名簿にないスタッフ・時刻不正・同じ記録ID
        { _row: 6, 記録ID: 'r-5', スタッフID: 'S002', 氏名: 'x', 勤務日: '2026-02-30', 出勤: '10:00', 退勤: '12:00', '休憩(分)': 0, '勤務時間(時間)': 2 },
        { _row: 7, 記録ID: 'r-6', スタッフID: 'S999', 氏名: '不明', 勤務日: '2026-10-05', 出勤: '10:00', 退勤: '12:00', '休憩(分)': 0, '勤務時間(時間)': 2 },
        { _row: 8, 記録ID: 'r-7', スタッフID: 'S002', 氏名: 'x', 勤務日: '2026-10-05', 出勤: '', 退勤: '12:00', '休憩(分)': 0, '勤務時間(時間)': 2 },
        { _row: 9, 記録ID: 'r-1', スタッフID: 'S002', 氏名: 'x', 勤務日: '2026-10-05', 出勤: '10:00', 退勤: '12:00', '休憩(分)': 0, '勤務時間(時間)': 2 },
      ],
      打刻修正申請: [
        { _row: 2, 申請ID: 'q-1', 申請日時: '2026-10-02T14:00:00+09:00', スタッフID: 'S002', 氏名: '青空 みなみ', 記録ID: 'r-2', '変更前(JSON)': '{"end":"13:00"}', '変更後(JSON)': '{"date":"2026-10-02","start":"09:05","end":"14:00","breakMin":0,"task":"","allowance":1000,"hours":4.92}', 修正理由: '退勤忘れ', 状態: '申請中', 処理日時: '', 処理者: '', 管理者メモ: '' },
      ],
      修正履歴: [
        { _row: 2, 日時: '2026-10-01T12:00:00+09:00', 操作: '一括勤怠申請', 記録ID: 'r-3', 操作者: '山田 晴人 (S003)', '変更前(JSON)': '', '変更後(JSON)': '{"date":"2026-10-03"}' },
      ],
    },
  };
}

function poster(client) {
  return async (path, body) => {
    const r = await client.post(path, body);
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
}

test('データ移行：確認のみ（dry-run）では何も書き込まず、問題点を報告する', async () => {
  const env = await setup({ staff: [] });
  const a = await adminClient(env);
  const rep = await runMigration(poster(a), gasExport().sheets, 'dry-run');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM staff').first('n'), 0);
  assert.equal(rep.tables.staff.newRows, 3);
  // 同じファイルの名簿にいるスタッフは「取り込み後に存在する」とみなして確認する
  assert.equal(rep.tables.attendance.newRows, 4);
  assert.equal(rep.tables.attendance.errors, 4); // 不正な行だけがエラー
  assert.ok(rep.tables.attendance.issues.some(i => /S999 が名簿にありません/.test(i.message)));
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 0);
  assert.equal(rep.ok, false);
});

test('データ移行：取り込み → 照合。IDを維持し、日付・時刻・数値を正しく変換する', async () => {
  const env = await setup({ staff: [] });
  const a = await adminClient(env);
  const sheets = gasExport().sheets;
  const imp = await runMigration(poster(a), sheets, 'import');
  const t = imp.tables;
  assert.equal(t.staff.inserted, 3);
  assert.equal(t.attendance.source, 8);
  assert.equal(t.attendance.inserted, 4);
  assert.equal(t.attendance.errors, 4);
  assert.equal(t.attendance.warnings, 1);
  assert.ok(t.attendance.countCheck); // 4 + 4 = 8
  const msgs = t.attendance.issues.map(i => `${i.row}:${i.level}:${i.message}`);
  assert.ok(msgs.some(m => m.startsWith('5:warning:勤務時間が再計算値と違います')), msgs.join('\n'));
  assert.ok(msgs.some(m => m.startsWith('6:error:存在しない日付です')));
  assert.ok(msgs.some(m => m.startsWith('7:error:スタッフID S999 が名簿にありません')));
  assert.ok(msgs.some(m => m.startsWith('8:error:時刻の形式が不正です')));
  assert.ok(msgs.some(m => m.startsWith('9:error:同じIDが移行元に複数あります')));
  assert.equal(t.corrections.inserted, 1);
  assert.equal(t.audit.inserted, 1);

  const r1 = await env.DB.prepare("SELECT * FROM attendance WHERE id = 'r-1'").first();
  assert.deepEqual(
    [r1.staff_id, r1.work_date, r1.start_time, r1.end_time, r1.break_min, r1.allowance, r1.hours, r1.source, r1.row_order, r1.updated_at],
    ['S002', '2026-10-01', '10:00', '15:00', 60, null, 4, 'migration', 2, '2026-10-01T06:01:02.000Z']
  );
  const r2 = await env.DB.prepare("SELECT * FROM attendance WHERE id = 'r-2'").first();
  assert.deepEqual([r2.start_time, r2.allowance, r2.updated_at], ['09:05', 1000, '2026-10-02T04:00:05.000Z']);
  const s3 = await env.DB.prepare("SELECT * FROM staff WHERE id = 'S003'").first();
  assert.equal(s3.active, 0);

  // 照合
  const ver = await runMigration(poster(a), sheets, 'verify');
  assert.equal(ver.tables.staff.complete, true);
  assert.equal(ver.tables.attendance.identical, 4);
  assert.equal(ver.tables.attendance.missing, 0);
  assert.equal(ver.tables.corrections.complete, true);
  assert.equal(ver.tables.audit.complete, true);

  // 移行したデータが新システムで使える（PIN発行 → ログイン → 履歴表示・修正申請の承認）
  const pin = (await a.post('/api/admin/staff/S002/pin')).data.pin;
  const c = new Client(env);
  await c.post('/api/login', { staffId: 'S002', pin });
  const h = await c.get('/api/history?month=2026-10');
  assert.deepEqual(h.data.entries.map(e => e.id), ['r-1', 'r-2', 'r-4']); // 旧シートの行順
  assert.equal(h.data.totalHours, 10.42);
  const reqs = await a.get('/api/admin/corrections');
  assert.equal(reqs.data.requests[0].id, 'q-1');
});

test('データ移行：再実行しても重複せず、内容が違うデータは上書きせず報告する', async () => {
  const env = await setup({ staff: [] });
  const a = await adminClient(env);
  const sheets = gasExport().sheets;
  await runMigration(poster(a), sheets, 'import');
  const again = await runMigration(poster(a), sheets, 'import');
  assert.equal(again.tables.staff.inserted, 0);
  assert.equal(again.tables.staff.identical, 3);
  assert.equal(again.tables.attendance.inserted, 0);
  assert.equal(again.tables.attendance.identical, 4);
  assert.equal(again.tables.audit.identical, 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 4);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE legacy_key IS NOT NULL').first('n'), 1);

  // 移行先で内容が変わっている場合
  await env.DB.prepare("UPDATE attendance SET end_time = '16:00' WHERE id = 'r-1'").run();
  const v = await runMigration(poster(a), sheets, 'verify');
  const c = v.tables.attendance.issues.find(i => i.level === 'conflict');
  assert.equal(c.id, 'r-1');
  assert.match(c.message, /end_time: 移行元="15:00" \/ 移行先="16:00"/);
  assert.equal(v.ok, false);
  const imp = await runMigration(poster(a), sheets, 'import');
  assert.equal(imp.tables.attendance.conflicts, 1);
  assert.equal(await env.DB.prepare("SELECT end_time FROM attendance WHERE id = 'r-1'").first('end_time'), '16:00'); // 上書きしない
});

test('データ移行：既存スタッフと別スタッフのデータが混ざらない（IDで照合）', async () => {
  const env = await setup({ staff: [{ id: 'S002', name: '別人 です', grade: 1 }] });
  const a = await adminClient(env);
  const rep = await runMigration(poster(a), gasExport().sheets, 'import');
  const c = rep.tables.staff.issues.find(i => i.id === 'S002');
  assert.equal(c.level, 'conflict');
  assert.equal(await env.DB.prepare("SELECT name FROM staff WHERE id = 'S002'").first('name'), '別人 です');
});

test('データ移行：結果の記録と、書き出し→復元の往復で内容が一致する', async () => {
  const env = await setup({ staff: [] });
  const a = await adminClient(env);
  const imp = await runMigration(poster(a), gasExport().sheets, 'import');
  const saved = await a.post('/api/admin/migrate/report', { mode: 'import', report: imp });
  assert.equal(saved.data.dbCounts.attendance, 4);
  assert.equal((await a.get('/api/admin/migrate/reports')).data.runs.length, 1);
  // 新しく登録した記録を含めて書き出し → 空のDBへ復元
  const pin = (await a.post('/api/admin/staff/S002/pin')).data.pin;
  const s = new Client(env);
  await s.post('/api/login', { staffId: 'S002', pin });
  await s.post('/api/attendance', { date: '2026-10-09', start: '10:00', end: '11:00', breakMin: '0', task: '新規', allowance: '' });
  const backup = (await a.get('/api/admin/export')).data;
  const env2 = await setup({ staff: [] });
  const a2 = await adminClient(env2);
  const sheets2 = parseExportJson(JSON.stringify(backup));
  const rest = await runMigration(poster(a2), sheets2, 'import');
  assert.equal(rest.tables.attendance.inserted, 5);
  const ver = await runMigration(poster(a2), sheets2, 'verify');
  assert.equal(ver.ok, true, JSON.stringify(ver.tables, null, 1));
});

test('CSV読み込み：Googleスプレッドシートの CSV をシート判定して読み込める', () => {
  const csv = '﻿記録ID,スタッフID,氏名,勤務日,出勤,退勤,休憩(分),業務内容,手当(円),勤務時間(時間),登録方法,更新日時\r\n' +
    'r-1,S002,青空 みなみ,2026/10/01,10:00:00,15:00:00,60,"受付, 案内",,4,manual,2026/10/01 15:01:02\r\n' +
    'r-2,S002,青空 みなみ,2026/10/02,9:05:00,13:00:00,0,"改行\n""引用""あり","1,000",3.92,clock,\r\n';
  const rows = parseCsv(csv);
  assert.equal(detectSheet(rows), '勤怠データ');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['業務内容'], '受付, 案内');
  assert.equal(rows[1]['業務内容'], '改行\n"引用"あり');
  assert.equal(rows[1]['手当(円)'], '1,000');
  assert.equal(rows[1]._row, 3);
});

test('データ移行：スタッフは実行できない', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  assert.equal((await s.post('/api/admin/migrate', { mode: 'import', table: 'staff', rows: [] })).status, 401);
});
