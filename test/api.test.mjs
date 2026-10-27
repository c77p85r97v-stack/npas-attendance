// スタッフ側APIのテスト（ローカル模擬環境：node:sqlite で D1 を再現）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, loginAs, Client, PIN, jst, base, adminClient } from './helpers.mjs';

test('スタッフ一覧：有効なスタッフのみ、PINなどの情報を含まない', async () => {
  const env = await setup();
  const r = await new Client(env).get('/api/staff');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(s => s.id), ['S001', 'S002', 'S003', 'S005']);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ['grade', 'id', 'name', 'nick']);
  assert.equal(r.data[0].grade, '2');
});

test('ログイン：正しいPINでのみ成功し、名前の選択だけではログインできない', async () => {
  const env = await setup();
  const c = new Client(env);
  assert.equal((await c.post('/api/login', { staffId: 'S001' })).status, 400);
  assert.equal((await c.post('/api/login', { staffId: 'S001', pin: '0000' })).status, 401);
  assert.equal((await c.post('/api/login', { staffId: 'S001', pin: 'abcd' })).status, 400);
  assert.equal((await c.post('/api/login', { staffId: 'S004', pin: PIN })).status, 401); // 無効スタッフ
  const noPin = await c.post('/api/login', { staffId: 'S005', pin: PIN });
  assert.equal(noPin.status, 403);
  assert.match(noPin.data.error, /PINが未設定/);
  const r = await c.post('/api/login', { staffId: 'S001', pin: PIN });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, '青空 みなみ');
  assert.match(r.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await c.get('/api/me')).data.user.id, 'S001');
});

test('ログイン：PINを5回続けて間違えると15分ロック、管理者が解除できる', async () => {
  const env = await setup();
  const c = new Client(env);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login', { staffId: 'S002', pin: '9999' })).status, 401);
  const locked = await c.post('/api/login', { staffId: 'S002', pin: PIN });
  assert.equal(locked.status, 429);
  const a = await adminClient(env);
  assert.equal((await a.post('/api/admin/staff/S002/unlock')).status, 200);
  assert.equal((await c.post('/api/login', { staffId: 'S002', pin: PIN })).status, 200);
});

test('未ログインでは勤怠の取得・登録ができない', async () => {
  const env = await setup();
  const c = new Client(env);
  assert.equal((await c.get('/api/history?month=2026-10')).status, 401);
  assert.equal((await c.get('/api/clock/status')).status, 401);
  assert.equal((await c.post('/api/attendance', base())).status, 401);
  assert.equal((await c.post('/api/clock/in')).status, 401);
  assert.equal((await c.post('/api/bulk', { staffIds: ['S001'], ...base() })).status, 401);
  assert.equal((await c.post('/api/corrections', { recordId: 'x', input: base(), reason: 'r' })).status, 401);
});

test('権限：スタッフIDを指定しても他人の記録は取得・登録できない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const b = await loginAs(env, 'S002');
  await a.post('/api/attendance', base());
  // b が a のスタッフIDを指定
  assert.equal((await b.get('/api/history?month=2026-10&staffId=S001')).status, 403);
  assert.equal((await b.post('/api/attendance', { ...base(), staffId: 'S001' })).status, 403);
  assert.equal((await b.get('/api/clock/status?staffId=S001')).status, 403);
  // 自分の履歴には a の記録は含まれない
  assert.equal((await b.get('/api/history?month=2026-10')).data.entries.length, 0);
  assert.equal((await a.get('/api/history?month=2026-10')).data.entries.length, 1);
  // スタッフは管理者APIを使えない
  assert.equal((await a.get('/api/admin/summary?month=2026-10')).status, 401);
});

test('CSRF対策：他のサイトからの書き込みは拒否', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  assert.equal((await a.post('/api/attendance', base(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.post('/api/attendance', base(), { 'X-Requested-With': '' })).status, 403);
  assert.equal((await a.post('/api/attendance', base(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await a.get('/api/history?month=2026-10')).data.entries.length, 0);
});

test('通常の勤怠申請：保存して月別履歴に表示される', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const r = await a.post('/api/attendance', base({ breakMin: '30', task: '  受付  ', allowance: '500' }));
  assert.equal(r.status, 200);
  assert.equal(r.data.hours, 4.5);
  assert.equal(r.data.workDate, '2026-10-05');
  assert.equal(r.data.summaryUpdated, false);
  const h = await a.get('/api/history?month=2026-10');
  assert.equal(h.data.entries.length, 1);
  const e = h.data.entries[0];
  assert.deepEqual(
    { date: e.date, start: e.start, end: e.end, breakMin: e.breakMin, task: e.task, allowance: e.allowance, hours: e.hours, method: e.method },
    { date: '2026-10-05', start: '10:00', end: '15:00', breakMin: 30, task: '受付', allowance: 500, hours: 4.5, method: 'manual' }
  );
  assert.equal(h.data.totalHours, 4.5);
  // 操作履歴
  const log = await env.DB.prepare("SELECT * FROM audit_log WHERE action = '勤怠申請'").all();
  assert.equal(log.results.length, 1);
  assert.match(log.results[0].operator, /S001/);
});

test('通常の勤怠申請：不正な入力はサーバー側で拒否し、何も保存しない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const cases = [
    [{ date: '2026-02-30' }, '存在しない日付です'],
    [{ date: '20261005' }, '日付が不正です'],
    [{ start: '25:00' }, '時刻が不正です'],
    [{ end: '' }, '時刻が不正です'],
    [{ breakMin: '-5' }, '休憩時間を確認してください'],
    [{ breakMin: '300' }, '出退勤時刻と休憩時間を確認してください'],
    [{ allowance: 'abc' }, '手当を確認してください'],
    [{ allowance: '2000000' }, '手当を確認してください'],
  ];
  for (const [o, msg] of cases) {
    const r = await a.post('/api/attendance', base(o));
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.data.error, msg);
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n');
  assert.equal(n, 0);
});

test('通常の勤怠申請：同じ requestId の再送は二重登録しない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const r1 = await a.post('/api/attendance', base({ requestId: 'req-12345678' }));
  const r2 = await a.post('/api/attendance', base({ requestId: 'req-12345678' }));
  assert.equal(r1.data.id, r2.data.id);
  assert.equal(r2.data.duplicate, true);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 1);
  // 同時に送っても1件
  const rs = await Promise.all([1, 2, 3, 4].map(() => a.post('/api/attendance', base({ requestId: 'req-abcdefgh' }))));
  assert.equal(new Set(rs.map(r => r.data.id)).size, 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 2);
});

test('月別履歴：対象月だけ・登録順で返し、月の境界を正しく扱う', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  for (const d of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01', '2026-10-15']) {
    await a.post('/api/attendance', base({ date: d }));
  }
  const h = await a.get('/api/history?month=2026-10');
  assert.deepEqual(h.data.entries.map(e => e.date), ['2026-10-01', '2026-10-31', '2026-10-15']);
  assert.equal(h.data.totalHours, 15);
  assert.equal((await a.get('/api/history?month=2026-13')).status, 400);
  assert.equal((await a.get('/api/history?month=2026-1')).status, 400);
  // 12月→翌年1月
  await a.post('/api/attendance', base({ date: '2026-12-31' }));
  await a.post('/api/attendance', base({ date: '2027-01-01' }));
  assert.deepEqual((await a.get('/api/history?month=2026-12')).data.entries.map(e => e.date), ['2026-12-31']);
});

test('出勤打刻 → 状態取得 → 退勤打刻：勤務時間を計算して保存し、出勤状態を解除', async () => {
  let now = jst(2026, 10, 5, 9, 58, 40);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  assert.deepEqual((await a.get('/api/clock/status')).data, { active: false, startedAt: null });
  const ci = await a.post('/api/clock/in');
  assert.equal(ci.status, 200);
  assert.equal(ci.data.time, '09:58');
  const st = await a.get('/api/clock/status');
  assert.equal(st.data.active, true);
  assert.equal(st.data.startedAt, now.toISOString());
  now = jst(2026, 10, 5, 15, 3, 10);
  const co = await a.post('/api/clock/out', { breakMin: 45, task: '受付', allowance: '' });
  assert.equal(co.status, 200);
  assert.equal(co.data.workDate, '2026-10-05');
  assert.equal(co.data.hours, 4.33); // 09:58〜15:03 = 305分 − 45分 = 260分
  assert.equal((await a.get('/api/clock/status')).data.active, false);
  const e = (await a.get('/api/history?month=2026-10')).data.entries[0];
  assert.equal(e.start, '09:58');
  assert.equal(e.end, '15:03');
  assert.equal(e.method, 'clock');
});

test('二重出勤の拒否（同時に押しても1件だけ）', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => a.post('/api/clock/in')));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(rs.filter(r => r.status === 409).length, 4);
  assert.equal(rs.find(r => r.status === 409).data.error, 'すでに出勤打刻済みです');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM clock_sessions').first('n'), 1);
});

test('出勤していない状態での退勤は拒否', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const r = await a.post('/api/clock/out', { breakMin: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '先に出勤してください');
});

test('退勤打刻：日付をまたぐ勤務は出勤日の記録として翌日退勤で計算', async () => {
  let now = jst(2026, 10, 31, 22, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = jst(2026, 11, 1, 2, 30);
  const co = await a.post('/api/clock/out', { breakMin: 30 });
  assert.equal(co.data.workDate, '2026-10-31');
  assert.equal(co.data.hours, 4);
  assert.equal((await a.get('/api/history?month=2026-10')).data.entries[0].end, '02:30');
  assert.equal((await a.get('/api/history?month=2026-11')).data.entries.length, 0);
});

test('退勤打刻：24時間以上は管理者への連絡を促し、出勤状態は残す', async () => {
  let now = jst(2026, 10, 5, 10, 0, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = jst(2026, 10, 6, 10, 0, 0); // ちょうど24時間
  const r = await a.post('/api/clock/out', { breakMin: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '24時間以上の勤務は管理者に連絡してください');
  assert.equal((await a.get('/api/clock/status')).data.active, true);
  // 管理者が出勤状態を取り消せる
  const ad = await adminClient(env);
  assert.equal((await ad.post('/api/admin/staff/S001/cancel-clock')).status, 200);
  assert.equal((await a.get('/api/clock/status')).data.active, false);
});

test('退勤打刻：24時間未満の上限（23時間59分）は受け付ける', async () => {
  let now = jst(2026, 10, 5, 10, 0, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = new Date(jst(2026, 10, 6, 10, 0, 0).getTime() - 1000);
  const r = await a.post('/api/clock/out', { breakMin: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.hours, 23.98);
});

test('退勤打刻：入力エラーのときは保存せず、出勤状態も解除しない', async () => {
  let now = jst(2026, 10, 5, 10, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = jst(2026, 10, 5, 11, 0);
  const r = await a.post('/api/clock/out', { breakMin: 60 });
  assert.equal(r.status, 400);
  assert.equal((await a.get('/api/clock/status')).data.active, true);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 0);
});

test('退勤打刻：保存に失敗したら出勤状態を解除しない（トランザクション）', async () => {
  let now = jst(2026, 10, 5, 10, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = jst(2026, 10, 5, 15, 0);
  // 保存時に失敗するよう細工（attendance への INSERT を失敗させるトリガー）
  await env.DB.exec("CREATE TRIGGER fail_ins BEFORE INSERT ON attendance BEGIN SELECT RAISE(ABORT, 'disk error'); END;");
  const r = await a.post('/api/clock/out', { breakMin: 0 });
  assert.equal(r.status, 500);
  assert.equal((await a.get('/api/clock/status')).data.active, true);
  await env.DB.exec('DROP TRIGGER fail_ins');
  // 再試行で1件だけ保存される
  const r2 = await a.post('/api/clock/out', { breakMin: 0 });
  assert.equal(r2.status, 200);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 1);
});

test('退勤打刻：応答が届かず再送しても、同時に2回押しても二重登録しない', async () => {
  let now = jst(2026, 10, 5, 10, 0);
  const env = await setup({ clock: () => now });
  const a = await loginAs(env, 'S001');
  await a.post('/api/clock/in');
  now = jst(2026, 10, 5, 15, 0);
  const r1 = await a.post('/api/clock/out', { breakMin: 0, requestId: 'out-11111111' });
  const r2 = await a.post('/api/clock/out', { breakMin: 0, requestId: 'out-11111111' }); // 再送
  assert.equal(r2.status, 200);
  assert.equal(r2.data.id, r1.data.id);
  // 同時押し
  await a.post('/api/clock/in');
  now = jst(2026, 10, 5, 18, 0);
  const rs = await Promise.all([1, 2, 3].map(i => a.post('/api/clock/out', { breakMin: 0, requestId: 'out-2222222' + i })));
  assert.ok(rs.every(r => r.status === 200 || r.status === 400), JSON.stringify(rs.map(r => r.data)));
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 2);
});

test('一括勤怠申請：勤務時間が重なる人はスキップし、成功件数・スキップ件数・理由を返す', async () => {
  const env = await setup();
  const op = await loginAs(env, 'S003');
  const s1 = await loginAs(env, 'S001');
  await s1.post('/api/attendance', base({ date: '2026-10-10' })); // S001 は既に記録あり
  const r = await op.post('/api/bulk', { operatorId: 'S003', staffIds: ['S001', 'S002', 'S003'], ...base({ date: '2026-10-10', start: '13:00', end: '17:00' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.saved.map(s => s.id), ['S002', 'S003']);
  assert.deepEqual(r.data.skipped, [{ id: 'S001', name: '青空 みなみ', reason: '勤務時間が重なる記録が既にあります（10/10 10:00〜15:00）' }]);
  assert.equal(r.data.auditWarning, '');
  const rec = await env.DB.prepare("SELECT * FROM attendance WHERE staff_id = 'S002'").first();
  assert.equal(rec.method, 'bulk-manual');
  assert.equal(rec.hours, 4);
  // 代表者と操作内容が監査履歴に残る
  const log = await env.DB.prepare("SELECT * FROM audit_log WHERE action = '一括勤怠申請'").first();
  assert.match(log.operator, /川上 真一 \(S003\)/);
  const after = JSON.parse(log.after_json);
  assert.deepEqual(after.skipped, ['S001']);
  assert.equal(log.record_id.split(',').length, 2);
  // もう一度同じ申請 → 全員スキップ
  const again = await op.post('/api/bulk', { staffIds: ['S001', 'S002', 'S003'], ...base({ date: '2026-10-10' }) });
  assert.equal(again.data.saved.length, 0);
  assert.equal(again.data.skipped.length, 3);
});

test('一括勤怠申請：入力チェック（人数・重複・名簿外・無効スタッフ）', async () => {
  const env = await setup();
  const op = await loginAs(env, 'S001');
  const send = ids => op.post('/api/bulk', { staffIds: ids, ...base() });
  assert.equal((await send([])).data.error, '申請するスタッフを1〜100名選択してください');
  assert.equal((await send(Array.from({ length: 101 }, (_, i) => 'X' + i))).data.error, '申請するスタッフを1〜100名選択してください');
  assert.equal((await send(['S001', 'S001'])).data.error, 'スタッフの選択に重複または不正な値があります');
  assert.equal((await send(['S001', 'NOPE'])).data.error, '名簿にないスタッフが選択されています。画面を更新してください');
  assert.equal((await send(['S004'])).status, 400); // 無効スタッフ
  assert.equal((await op.post('/api/bulk', { staffIds: ['S001'], ...base({ end: '10:00' }) })).status, 400);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 0);
});

test('一括勤怠申請：100名まで一度に登録でき、同時に2つ申請しても重複しない', async () => {
  const staff = Array.from({ length: 100 }, (_, i) => ({ id: 'S' + String(i + 1).padStart(3, '0'), name: 'スタッフ' + (i + 1), grade: 1 + (i % 2) }));
  const env = await setup({ staff });
  const op1 = await loginAs(env, 'S001');
  const op2 = await loginAs(env, 'S002');
  const ids = staff.map(s => s.id);
  const [r1, r2] = await Promise.all([
    op1.post('/api/bulk', { staffIds: ids, ...base({ date: '2026-10-20' }) }),
    op2.post('/api/bulk', { staffIds: ids, ...base({ date: '2026-10-20' }) }),
  ]);
  assert.equal(r1.data.saved.length + r2.data.saved.length, 100);
  assert.equal(r1.data.skipped.length + r2.data.skipped.length, 100);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE work_date = '2026-10-20'").first('n'), 100);
  assert.equal(await env.DB.prepare("SELECT COUNT(DISTINCT staff_id) AS n FROM attendance").first('n'), 100);
});

test('一括勤怠申請：通常申請と同時でも、同じ人・同じ日が二重にならない（一括側がスキップ）', async () => {
  const env = await setup();
  const op = await loginAs(env, 'S003');
  const s1 = await loginAs(env, 'S001');
  const [, b] = await Promise.all([s1.post('/api/attendance', base({ date: '2026-10-11' })), op.post('/api/bulk', { staffIds: ['S001', 'S002'], ...base({ date: '2026-10-11' }) })]);
  // 通常申請は旧仕様どおり同じ日に複数登録できるが、一括申請が重複を作ることはない
  const bulkN = await env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE staff_id = 'S001' AND work_date = '2026-10-11' AND method = 'bulk-manual'").first('n');
  assert.ok(bulkN <= 1);
  assert.equal(b.status, 200);
  const s1saved = b.data.saved.some(x => x.id === 'S001');
  assert.equal(bulkN, s1saved ? 1 : 0);
});

test('一括勤怠申請：設定で無効にできる（BULK_POLICY=disabled）', async () => {
  const env = await setup({ extra: { BULK_POLICY: 'disabled' } });
  const op = await loginAs(env, 'S001');
  assert.equal((await op.post('/api/bulk', { staffIds: ['S001'], ...base() })).status, 403);
});

test('打刻修正申請：申請を保存するだけで、元の記録は変わらない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const { data: saved } = await a.post('/api/attendance', base());
  const r = await a.post('/api/corrections', { staffId: 'S001', recordId: saved.id, input: base({ end: '16:00' }), reason: '退勤時刻の入力を間違えた' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, '申請中');
  const req = await env.DB.prepare('SELECT * FROM correction_requests').first();
  assert.equal(JSON.parse(req.before_json).end, '15:00');
  assert.equal(JSON.parse(req.after_json).end, '16:00');
  assert.equal(JSON.parse(req.after_json).hours, 6);
  assert.equal(req.reason, '退勤時刻の入力を間違えた');
  assert.equal((await a.get('/api/history?month=2026-10')).data.entries[0].end, '15:00'); // 未承認なので変わらない
  // 審査待ちがあると再申請できない（同時に送っても1件）
  const dup = await Promise.all([1, 2].map(() => a.post('/api/corrections', { recordId: saved.id, input: base({ end: '17:00' }), reason: '再申請' })));
  assert.ok(dup.every(d => d.status === 409));
  assert.equal(dup[0].data.error, 'この記録には審査待ちの申請があります');
});

test('打刻修正申請：理由が必須・他人の記録は申請できない・入力も検証する', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const b = await loginAs(env, 'S002');
  const { data: saved } = await a.post('/api/attendance', base());
  assert.equal((await a.post('/api/corrections', { recordId: saved.id, input: base(), reason: '  ' })).data.error, '修正理由を1～300文字で入力してください');
  assert.equal((await a.post('/api/corrections', { recordId: saved.id, input: base(), reason: 'x'.repeat(301) })).status, 400);
  assert.equal((await a.post('/api/corrections', { recordId: saved.id, input: base({ start: '99:00' }), reason: 'x' })).status, 400);
  assert.equal((await b.post('/api/corrections', { recordId: saved.id, input: base(), reason: 'x' })).status, 404);
});

test('ログアウト後は操作できない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  const cookie = [...a.cookies][0];
  await a.post('/api/logout');
  assert.equal((await a.get('/api/me')).status, 401);
  // 古いCookieを使い回しても無効
  const c = new Client(env);
  c.cookies.set(cookie[0], cookie[1]);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('想定外のエラーは詳細（SQL等）を画面に出さない', async () => {
  const env = await setup();
  const a = await loginAs(env, 'S001');
  await env.DB.exec('DROP TABLE audit_log');
  const r = await a.post('/api/attendance', base());
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.data.error, /audit_log|SQL|no such table/i);
});

test('一括勤怠申請：スキップは勤務時間帯が少しでも重なる場合だけ（同じ日でも重ならなければ登録）', async () => {
  const env = await setup();
  const op = await loginAs(env, 'S003');
  const s1 = await loginAs(env, 'S001');
  const s2 = await loginAs(env, 'S002');
  await s1.post('/api/attendance', base({ date: '2026-10-10', start: '09:00', end: '12:00' }));
  await s2.post('/api/attendance', base({ date: '2026-10-10', start: '12:00', end: '13:01' }));
  const bulk = (o) => op.post('/api/bulk', { staffIds: ['S001', 'S002'], ...base({ date: '2026-10-10', ...o }) }).then(r => r.data);
  // 13:00〜17:00：S001(9-12)は重ならない／S002(12:00-13:01)は1分重なる
  let r = await bulk({ start: '13:00', end: '17:00' });
  assert.deepEqual(r.saved.map(x => x.id), ['S001']);
  assert.deepEqual(r.skipped.map(x => x.id), ['S002']);
  assert.match(r.skipped[0].reason, /12:00〜13:01/);
  // 17:00〜19:00：13:00〜17:00 と「接するだけ」なので重ならない
  r = await bulk({ start: '17:00', end: '19:00' });
  assert.deepEqual(r.saved.map(x => x.id).sort(), ['S001', 'S002']);
  // 18:30〜18:31：17:00〜19:00 の中なので両方スキップ
  r = await bulk({ start: '18:30', end: '18:31' });
  assert.equal(r.saved.length, 0);
  assert.equal(r.skipped.length, 2);
});

test('一括勤怠申請：日付をまたぐ勤務との重なりも判定する', async () => {
  const env = await setup();
  const op = await loginAs(env, 'S003');
  const s1 = await loginAs(env, 'S001');
  await s1.post('/api/attendance', base({ date: '2026-10-31', start: '22:00', end: '02:00' })); // 11/1 02:00 まで
  const bulk = (o) => op.post('/api/bulk', { staffIds: ['S001'], ...base(o) }).then(r => r.data);
  let r = await bulk({ date: '2026-11-01', start: '01:00', end: '03:00' }); // 翌日の深夜と重なる
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /10\/31 22:00〜02:00/);
  r = await bulk({ date: '2026-11-01', start: '02:00', end: '05:00' }); // 接するだけ
  assert.equal(r.saved.length, 1);
  // 前日側：10/30 23:00〜10/31 23:30 は 10/31 22:00〜 と重なる
  r = await bulk({ date: '2026-10-30', start: '23:00', end: '23:30' }); // 10/30 23:00〜23:30 は重ならない
  assert.equal(r.saved.length, 1);
  r = await bulk({ date: '2026-10-31', start: '21:00', end: '22:01' });
  assert.equal(r.skipped.length, 1);
});
