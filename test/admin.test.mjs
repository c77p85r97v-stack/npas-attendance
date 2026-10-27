// 管理者APIのテスト（ローカル模擬環境）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, loginAs, adminClient, Client, base } from './helpers.mjs';

test('管理者ログイン：パスワードが違えば拒否、スタッフのCookieでは管理者APIを使えない', async () => {
  const env = await setup();
  const c = new Client(env);
  assert.equal((await c.post('/api/admin/login', { loginId: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await c.post('/api/admin/login', { loginId: 'nobody', password: 'x' })).status, 401);
  const s = await loginAs(env, 'S001');
  for (const p of ['/api/admin/me', '/api/admin/staff', '/api/admin/summary', '/api/admin/export', '/api/admin/audit']) {
    assert.equal((await s.get(p)).status, 401, p);
  }
  const a = await adminClient(env);
  assert.equal((await a.get('/api/admin/me')).data.admin.loginId, 'admin');
});

test('修正申請の承認：記録が変更され、変更前・変更後が監査履歴に残る', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  const { data: rec } = await s.post('/api/attendance', base());
  const { data: req } = await s.post('/api/corrections', { recordId: rec.id, input: base({ end: '16:30', breakMin: '30' }), reason: '退勤時刻の修正' });
  const a = await adminClient(env);
  const list = await a.get('/api/admin/corrections');
  assert.equal(list.data.requests.length, 1);
  assert.equal(list.data.requests[0].before.end, '15:00');
  const ok = await a.post(`/api/admin/corrections/${req.requestId}/approve`, { memo: '確認しました' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const e = (await s.get('/api/history?month=2026-10')).data.entries[0];
  assert.equal(e.end, '16:30');
  assert.equal(e.hours, 6);
  const r = await env.DB.prepare('SELECT * FROM correction_requests').first();
  assert.equal(r.status, '承認');
  assert.equal(r.admin_memo, '確認しました');
  assert.match(r.processed_by, /管理 太郎/);
  assert.ok(r.processed_at);
  const log = await env.DB.prepare("SELECT * FROM audit_log WHERE action = '打刻修正承認'").first();
  assert.equal(JSON.parse(log.before_json).end, '15:00');
  assert.equal(JSON.parse(log.after_json).end, '16:30');
  // 二重承認はできない
  assert.equal((await a.post(`/api/admin/corrections/${req.requestId}/approve`, {})).status, 409);
  // 承認後は新たに申請できる
  assert.equal((await s.post('/api/corrections', { recordId: rec.id, input: base(), reason: '戻したい' })).status, 200);
});

test('修正申請の却下：記録は変わらず、状態とメモが残る', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  const { data: rec } = await s.post('/api/attendance', base());
  const { data: req } = await s.post('/api/corrections', { recordId: rec.id, input: base({ end: '18:00' }), reason: 'x' });
  const a = await adminClient(env);
  assert.equal((await a.post(`/api/admin/corrections/${req.requestId}/reject`, { memo: '根拠なし' })).status, 200);
  assert.equal((await s.get('/api/history?month=2026-10')).data.entries[0].end, '15:00');
  const r = await env.DB.prepare('SELECT status, admin_memo FROM correction_requests').first();
  assert.deepEqual({ ...r }, { status: '却下', admin_memo: '根拠なし' });
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM audit_log WHERE action = '打刻修正却下'").first());
});

test('修正申請の承認：申請後に記録が変わっていたら承認せず、記録も変えない', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  const { data: rec } = await s.post('/api/attendance', base());
  const { data: req } = await s.post('/api/corrections', { recordId: rec.id, input: base({ end: '16:00' }), reason: 'x' });
  const a = await adminClient(env);
  // 管理者が別の方法で先に記録を修正
  await a.post(`/api/admin/records/${rec.id}/update`, { ...base({ end: '17:00' }), reason: '直接修正' });
  const r = await a.post(`/api/admin/corrections/${req.requestId}/approve`, {});
  assert.equal(r.status, 409);
  assert.equal((await s.get('/api/history?month=2026-10')).data.entries[0].end, '17:00');
  assert.equal((await env.DB.prepare('SELECT status FROM correction_requests').first('status')), '申請中');
});

test('修正申請の承認：2人の管理者が同時に承認しても1回だけ処理される', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  const { data: rec } = await s.post('/api/attendance', base());
  const { data: req } = await s.post('/api/corrections', { recordId: rec.id, input: base({ end: '16:00' }), reason: 'x' });
  const a1 = await adminClient(env);
  const a2 = await adminClient(env);
  const rs = await Promise.all([a1, a2].map(a => a.post(`/api/admin/corrections/${req.requestId}/approve`, {})));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '打刻修正承認'").first('n'), 1);
});

test('月別集計：勤務日数・合計勤務時間・合計休憩・合計手当。実績なしのスタッフも0で表示', async () => {
  const env = await setup();
  const s1 = await loginAs(env, 'S001');
  const s3 = await loginAs(env, 'S003');
  await s1.post('/api/attendance', base({ date: '2026-10-01', breakMin: '30', allowance: '500' }));
  await s1.post('/api/attendance', base({ date: '2026-10-01', start: '18:00', end: '20:00' })); // 同じ日に2件 → 日数は1
  await s1.post('/api/attendance', base({ date: '2026-10-20', start: '10:00', end: '10:20' }));
  await s1.post('/api/attendance', base({ date: '2026-11-01' })); // 別の月
  await s3.post('/api/attendance', base({ date: '2026-10-02', allowance: '1000' }));
  const a = await adminClient(env);
  const r = await a.get('/api/admin/summary?month=2026-10');
  // 並び：学年の大きい順 → 氏名順。無効スタッフ(S004)は出ない
  const col = new Intl.Collator('ja');
  const expected = [['S001', 2, '青空 みなみ'], ['S002', 2, '山田 晴人'], ['S003', 1, '川上 真一'], ['S005', 1, '未設定 PIN']]
    .sort((a, b) => b[1] - a[1] || col.compare(a[2], b[2]))
    .map(x => x[0]);
  assert.deepEqual(r.data.rows.map(x => x.staffId), expected);
  const m = Object.fromEntries(r.data.rows.map(x => [x.staffId, x]));
  assert.deepEqual([m.S001.days, m.S001.hours, m.S001.breakMin, m.S001.allowance], [2, 6.83, 30, 500]);
  assert.deepEqual([m.S002.days, m.S002.hours, m.S002.breakMin, m.S002.allowance], [0, 0, 0, 0]);
  assert.deepEqual([m.S003.days, m.S003.hours, m.S003.allowance], [1, 5, 1000]);
  // CSV（全月）
  const csv = await a.get('/api/admin/summary.csv?month=all');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('Content-Type'), /text\/csv/);
  const lines = csv.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '対象月,スタッフID,氏名,ニックネーム,学年,勤務日数,合計勤務時間(時間),合計休憩(分),合計手当(円)');
  assert.ok(lines.includes('2026-10,S001,青空 みなみ,みなみん,2,2,6.83,30,500'));
  assert.ok(lines.includes('2026-11,S001,青空 みなみ,みなみん,2,1,5.00,0,0'));
});

test('集計は保存と独立：集計を取得できなくても勤怠の保存は成功する', async () => {
  const env = await setup();
  const s1 = await loginAs(env, 'S001');
  const r = await s1.post('/api/attendance', base());
  assert.equal(r.status, 200);
  assert.equal(r.data.summaryUpdated, false); // 旧仕様と同じ項目（集計は取得時に計算）
});

test('個人別勤怠申請書：日別（複数勤務は合算）・月の日数・合計', async () => {
  const env = await setup();
  const s1 = await loginAs(env, 'S001');
  await s1.post('/api/attendance', base({ date: '2026-02-03', task: '受付', allowance: '300' }));
  await s1.post('/api/attendance', base({ date: '2026-02-03', start: '18:00', end: '20:00', task: '片付け', breakMin: '10' }));
  await s1.post('/api/attendance', base({ date: '2026-02-28', start: '22:00', end: '01:00' }));
  const a = await adminClient(env);
  const r = await a.get('/api/admin/personal?staffId=S001&month=2026-02');
  assert.equal(r.data.days.length, 28);
  const d3 = r.data.days[2];
  assert.equal(d3.weekday, '火');
  assert.deepEqual(d3.tasks, ['受付', '片付け']);
  assert.deepEqual(d3.starts, ['10:00', '18:00']);
  assert.equal(d3.hours, 6.83);
  assert.equal(d3.breakMin, 10);
  assert.equal(d3.allowance, 300);
  assert.equal(r.data.totals.hours, 9.83);
  assert.equal(r.data.totals.allowance, 300);
  assert.equal(r.data.staff.nick, 'みなみん');
  assert.equal((await a.get('/api/admin/personal?staffId=S001&month=2028-02')).data.days.length, 29);
});

test('スタッフ管理：追加（S+3桁の空き番号）・更新（IDは変えない）・PIN発行', async () => {
  const env = await setup();
  const a = await adminClient(env);
  const add = await a.post('/api/admin/staff', { name: '新人 さん', nick: 'しんじん', grade: '1' });
  assert.equal(add.data.id, 'S006');
  assert.equal((await a.post('/api/admin/staff', { name: '', grade: '1' })).status, 400);
  assert.equal((await a.post('/api/admin/staff', { name: 'x', grade: 'a' })).status, 400);
  const up = await a.post('/api/admin/staff', { id: 'S006', name: '新人 さん', nick: 'しんちゃん', grade: '2', active: true });
  assert.equal(up.status, 200);
  const pin = await a.post('/api/admin/staff/S006/pin');
  assert.match(pin.data.pin, /^\d{6}$/);
  const c = new Client(env);
  assert.equal((await c.post('/api/login', { staffId: 'S006', pin: pin.data.pin })).status, 200);
  // PINの再発行で古いセッションは無効
  await a.post('/api/admin/staff/S006/pin');
  assert.equal((await c.get('/api/me')).status, 401);
  // PIN自体は操作履歴に残さない
  const logs = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'PIN発行'").all();
  assert.ok(logs.results.every(l => !l.after_json.includes(pin.data.pin)));
  const list = await a.get('/api/admin/staff');
  assert.equal(list.data.staff.find(s => s.id === 'S006').nick, 'しんちゃん');
  assert.equal(list.data.staff.find(s => s.id === 'S005').hasPin, false);
});

test('PIN一括発行：未設定の有効スタッフだけに、少人数ずつ発行して最後は残り0', async () => {
  const staff = Array.from({ length: 5 }, (_, i) => ({ id: 'S00' + (i + 1), name: 'スタッフ' + i, grade: 1, noPin: true }));
  staff.push({ id: 'S009', name: '無効', grade: 1, noPin: true, active: false });
  const env = await setup({ staff });
  const a = await adminClient(env);
  const all = [];
  let remaining = 1;
  let rounds = 0;
  while (remaining > 0 && rounds++ < 10) {
    const r = await a.post('/api/admin/pins/issue-missing', { limit: 2 });
    all.push(...r.data.issued);
    remaining = r.data.remaining;
  }
  assert.equal(all.length, 5);
  assert.ok(!all.some(s => s.id === 'S009'));
  const c = new Client(env);
  assert.equal((await c.post('/api/login', { staffId: all[3].id, pin: all[3].pin })).status, 200);
});

test('勤怠記録の管理者による追加・修正・削除（理由必須、削除内容は履歴に残る）', async () => {
  const env = await setup();
  const a = await adminClient(env);
  assert.equal((await a.post('/api/admin/records', { staffId: 'S001', ...base() })).status, 400); // 理由なし
  const add = await a.post('/api/admin/records', { staffId: 'S001', ...base(), reason: '紙の申請書から入力' });
  assert.equal(add.status, 200);
  const up = await a.post(`/api/admin/records/${add.data.id}/update`, { ...base({ end: '14:00' }), reason: '時刻修正' });
  assert.equal(up.data.hours, 4);
  const del = await a.post(`/api/admin/records/${add.data.id}/delete`, { reason: '重複登録' });
  assert.equal(del.status, 200);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM attendance').first('n'), 0);
  const log = await env.DB.prepare("SELECT * FROM audit_log WHERE action = '管理者による勤怠削除'").first();
  assert.equal(JSON.parse(log.before_json).end, '14:00');
  const audit = await a.get('/api/admin/audit?limit=10');
  assert.deepEqual(audit.data.logs.map(l => l.action), ['管理者による勤怠削除', '管理者による勤怠修正', '管理者による勤怠追加']);
});

test('バックアップ書き出し：旧シートと同じ列名、PINハッシュを含まない', async () => {
  const env = await setup();
  const s = await loginAs(env, 'S001');
  await s.post('/api/attendance', base({ allowance: '' }));
  const a = await adminClient(env);
  const r = await a.get('/api/admin/export');
  assert.equal(r.status, 200);
  const data = r.data;
  assert.equal(data.format, 'npas-d1-backup');
  assert.equal(data.sheets['スタッフ名簿'].length, 5);
  assert.ok(!JSON.stringify(data).includes('pbkdf2'));
  const row = data.sheets['勤怠データ'][0];
  assert.equal(row['手当(円)'], '');
  assert.equal(row['勤務日'], '2026-10-05');
});

test('バックアップの分割取得：まとめて取得したものと同じ内容になる', async () => {
  const { downloadBackup } = await import('../public/js/migrate-client.js');
  const env = await setup();
  const s = await loginAs(env, 'S001');
  for (let i = 1; i <= 25; i++) await s.post('/api/attendance', base({ date: `2026-10-${String(i).padStart(2, '0')}` }));
  const a = await adminClient(env);
  const page = await a.get('/api/admin/export/page?sheet=勤怠データ&offset=10&limit=10');
  assert.equal(page.data.rows.length, 10);
  assert.equal(page.data.more, true);
  const paged = await downloadBackup(async p => (await a.get(p)).data, () => {}, 7); // 7件ずつ（複数ページ）
  const full = (await a.get('/api/admin/export')).data;
  assert.deepEqual(paged.sheets, full.sheets);
  assert.equal(paged.sheets['勤怠データ'].length, 25);
});

test('最初の管理者の初期設定：合言葉が必要・管理者がいれば使えない', async () => {
  const env = await setup({ extra: { ADMIN_SETUP_TOKEN: 'setup-token-0123456789' } });
  await env.DB.prepare("DELETE FROM admins").run();
  const c = new Client(env);
  assert.equal((await c.get('/api/admin/setup')).data.needsSetup, true);
  assert.equal((await c.post('/api/admin/setup', { setupToken: 'wrong', loginId: 'boss', name: '先生', password: 'long-password-1' })).status, 403);
  assert.equal((await c.post('/api/admin/setup', { setupToken: 'setup-token-0123456789', loginId: 'boss', name: '先生', password: 'short' })).status, 400);
  const ok = await c.post('/api/admin/setup', { setupToken: 'setup-token-0123456789', loginId: 'boss', name: '先生', password: 'long-password-1' });
  assert.equal(ok.status, 200);
  assert.equal((await c.post('/api/admin/setup', { setupToken: 'setup-token-0123456789', loginId: 'boss2', name: 'x', password: 'long-password-1' })).status, 409);
  assert.equal((await c.get('/api/admin/setup')).data.needsSetup, false);
  assert.equal((await c.post('/api/admin/login', { loginId: 'boss', password: 'long-password-1' })).status, 200);
  // 管理者の追加・パスワード変更
  assert.equal((await c.post('/api/admin/admins', { loginId: 'boss', name: 'x', password: 'long-password-2' })).status, 409);
  assert.equal((await c.post('/api/admin/admins', { loginId: 'sub', name: '副', password: 'long-password-2' })).status, 200);
  assert.equal((await c.post('/api/admin/password', { current: 'wrong', password: 'new-password-123' })).status, 400);
  assert.equal((await c.post('/api/admin/password', { current: 'long-password-1', password: 'new-password-123' })).status, 200);
  assert.equal((await new Client(env).post('/api/admin/login', { loginId: 'boss', password: 'new-password-123' })).status, 200);
  assert.equal((await c.get('/api/admin/admins')).data.admins.length, 2);
});

test('合言葉が未設定なら初期設定はできない', async () => {
  const env = await setup();
  await env.DB.prepare("DELETE FROM admins").run();
  const r = await new Client(env).post('/api/admin/setup', { setupToken: '', loginId: 'boss', name: '先生', password: 'long-password-1' });
  assert.equal(r.status, 403);
});

test('テスト用管理者は本番環境ではログインできない', async () => {
  const env = await setup({ extra: { ENVIRONMENT: 'production', ALLOW_TEST_TOOLS: 'true' } });
  const { hashSecret } = await import('../src/lib/crypto.js');
  await env.DB.prepare("INSERT INTO admins (id, login_id, name, password_hash, created_at) VALUES ('test-admin', 'testadmin', 'テスト', ?, '2026-01-01')").bind(await hashSecret('test-password-1234', env.PIN_PEPPER)).run();
  const c = new Client(env);
  assert.equal((await c.post('/api/admin/login', { loginId: 'testadmin', password: 'test-password-1234' })).status, 401);
  assert.equal((await c.post('/api/test/reset')).status, 404);
});

test('本番環境で PIN_PEPPER が未設定なら、ログインを止めて設定を促す', async () => {
  const env = await setup({ extra: { ENVIRONMENT: 'production' } });
  delete env.PIN_PEPPER;
  const r = await new Client(env).post('/api/login', { staffId: 'S001', pin: '2468' });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /PIN_PEPPER/);
});

test('サーバー側の動作確認（/api/test/selfcheck）が全手順成功する', async () => {
  const { createTestEnv } = await import('../tools/d1-node.mjs');
  const env = createTestEnv();
  const r = await new Client(env).get('/api/test/selfcheck');
  assert.equal(r.status, 200);
  assert.equal(r.data.fail, 0, JSON.stringify(r.data.results.filter(x => !x.ok)));
  assert.ok(r.data.pass >= 25);
});
