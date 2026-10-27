// 画面操作の自動テスト（ブラウザで実際にボタンを押して確認する）
// サーバーをこのプログラムの中で起動し、時計を進められるようにしている。
//   node test/ui/e2e.mjs [スクリーンショット保存先]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDevEnv, startServer } from '../../tools/dev-server.mjs';
import { resetTestData } from '../../src/routes/testtools.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || '/tmp/e2e';
mkdirSync(out, { recursive: true });

const env = await createDevEnv(':memory:');
env.LOG_TIMING = 'false';
await resetTestData(env, new Request('http://localhost/api/test/reset?samples=0'));
let offsetMs = 0; // サーバーの時計をずらす（退勤の確認用）
env.__clock = () => new Date(Date.now() + offsetMs);
const server = await startServer(env, 0);
const BASE = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['✅', name]);
  } catch (e) {
    results.push(['❌', name, e.message.split('\n')[0]]);
  }
}
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
const toastText = async () => (await page.waitForSelector('#toast', { state: 'visible' })).textContent();

await page.goto(BASE + '/');
await page.waitForFunction(() => !document.getElementById('grade').disabled);

await check('ログイン：PINを間違えるとエラー表示、画面は進まない', async () => {
  await page.selectOption('#grade', '1');
  await page.selectOption('#person', 'TEST01');
  assert.equal(await page.textContent('#nickname'), 'ニックネーム：いちろう');
  await page.fill('#pin', '9999');
  await page.click('#loginBtn');
  assert.match(await toastText(), /名前またはPINが正しくありません/);
  assert.ok(await page.isVisible('#login.active'));
});
await check('ログイン：正しいPINでホーム画面へ', async () => {
  await page.fill('#pin', '1234');
  await page.click('#loginBtn');
  await page.waitForSelector('#home.active');
  assert.equal(await page.textContent('#loggedInName'), 'いちろう');
  await page.waitForFunction(() => /まだ出勤していません/.test(document.getElementById('statusText').textContent));
});
await check('出勤打刻 → 勤務状況が「出勤中」になる', async () => {
  await page.click('#clockIn');
  assert.match(await toastText(), /出勤を記録したよ！ \d\d:\d\d/);
  await page.waitForFunction(() => /出勤中です/.test(document.getElementById('statusText').textContent));
});
await check('退勤打刻（2時間15分後）：退勤画面で休憩・内容を入力して確定', async () => {
  offsetMs = (2 * 60 + 15) * 60 * 1000;
  await page.click('#clockOut');
  await page.waitForSelector('#checkout.active');
  await page.waitForFunction(() => /^\d\d:\d\d$/.test(document.getElementById('checkoutStarted').textContent));
  await page.fill('#checkoutBreak', '15');
  await page.fill('#checkoutTask', '受付・案内');
  await page.screenshot({ path: join(out, 'checkout.png'), fullPage: true });
  await page.click('#confirmCheckout');
  await page.waitForSelector('#home.active');
  assert.match(await toastText(), /退勤を記録したよ/);
  await page.waitForFunction(() => /まだ出勤していません/.test(document.getElementById('statusText').textContent));
});
await check('通常の勤怠申請：入力して申請 → ホームへ戻る', async () => {
  await page.click('[data-go="request"]');
  await page.waitForSelector('#request.active');
  await page.fill('#start', '09:00');
  await page.fill('#end', '12:30');
  await page.fill('#task', '資料の準備');
  assert.equal(await page.textContent('#taskCount'), '5');
  await page.fill('#breakMin', '30');
  await page.click('#allowanceToggle');
  await page.fill('#allowance', '800');
  await page.click('#submit');
  assert.match(await toastText(), /申請完了/);
  await page.waitForSelector('#home.active');
});
await check('通常の勤怠申請：不正な入力はサーバーのエラーメッセージを表示', async () => {
  await page.click('[data-go="request"]');
  await page.fill('#start', '10:00');
  await page.fill('#end', '10:30');
  await page.fill('#breakMin', '30');
  await page.click('#submit');
  assert.match(await toastText(), /出退勤時刻と休憩時間を確認してください/);
  assert.ok(await page.isVisible('#request.active'));
  await page.click('#request .back');
});
await check('勤務履歴：今月の2件と合計・日数・平均・休憩を表示', async () => {
  await page.click('.menu-tile[data-go="history"]');
  await page.waitForSelector('#history.active .entry');
  assert.equal((await page.$$('#entries .entry')).length, 2);
  // 2:00 + 3:00 = 5時間（退勤打刻は 2時間15分 − 休憩15分）
  assert.equal(await page.textContent('#totalHours'), '5時間 0分');
  assert.equal(await page.textContent('#breakTotal'), '0時間 45分');
  assert.equal(await page.textContent('#days'), '1日');
  await page.screenshot({ path: join(out, 'history.png'), fullPage: true });
  await page.click('#prevMonth');
  await page.waitForSelector('#entries .empty');
  await page.click('#nextMonth');
  await page.waitForSelector('#entries .entry');
  await page.click('#history .back');
});
await check('一括勤怠申請：2名選択 → 確認画面 → 申請 → 結果表示（重複はスキップ）', async () => {
  await page.click('[data-go="bulkRequest"]');
  await page.waitForSelector('.npas-bulk-person');
  assert.equal(await page.textContent('#bulkOperator'), 'テスト 一郎');
  await page.check('.npas-bulk-person[value="TEST01"]');
  await page.check('.npas-bulk-person[value="TEST02"]');
  assert.equal(await page.textContent('#bulkCount'), '2名選択中');
  await page.fill('#bulkTask', '一括テスト');
  await page.click('#bulkSubmit');
  await page.waitForSelector('#npasBulkConfirm', { state: 'visible' });
  assert.match(await page.textContent('#npasBulkConfirmText'), /対象：2名/);
  await page.screenshot({ path: join(out, 'bulk-confirm.png') });
  await page.click('#npasBulkConfirmOk');
  await page.waitForFunction(() => /一括申請結果/.test(document.getElementById('bulkResult').textContent));
  const t = await page.textContent('#bulkResult');
  // TEST01 は今日すでに記録があるのでスキップ、TEST02 は登録
  assert.match(t, /登録成功：1名\n・テスト 二子/);
  assert.match(t, /スキップ：1名\n・テスト 一郎/);
  await page.click('#bulkRequest .back');
});
await check('打刻修正申請：記録を選び、修正内容と理由を送信', async () => {
  await page.click('[data-go="corrections"]');
  await page.waitForSelector('.correction-pick');
  await page.click('.correction-pick >> nth=0');
  await page.waitForSelector('#correctionEditor', { state: 'visible' });
  await page.fill('#fixEnd', '13:00');
  await page.click('#sendCorrection');
  assert.equal(await page.textContent('#correctionMessage'), '修正理由を入力してください');
  await page.fill('#fixReason', '退勤時刻を間違えた');
  await page.click('#sendCorrection');
  await page.waitForFunction(() => /申請を受け付けました/.test(document.getElementById('correctionMessage').textContent));
  await page.click('#corrections .back');
});
await check('ログアウト → ログイン画面へ戻り、操作できなくなる', async () => {
  await page.click('#switchPerson');
  await page.waitForSelector('#login.active');
  const r = await page.evaluate(() => fetch('/api/me').then(r => r.status));
  assert.equal(r, 401);
});

// ---------- 管理画面 ----------
const admin = await ctx.newPage();
admin.on('pageerror', e => pageErrors.push(String(e)));
await admin.setViewportSize({ width: 1100, height: 900 });
const adminToast = async () => (await admin.waitForSelector('#toast', { state: 'visible' })).textContent();
await admin.goto(BASE + '/admin.html');
await check('管理画面：ログイン（パスワード違いは拒否）', async () => {
  await admin.fill('#loginId', 'testadmin');
  await admin.fill('#password', 'wrong');
  await admin.click('#loginBtn');
  await admin.waitForFunction(() => document.getElementById('loginError').textContent.length > 0);
  await admin.fill('#password', 'test-password-1234');
  await admin.click('#loginBtn');
  await admin.waitForSelector('#appView:not([hidden])');
});
await check('管理画面：修正申請を承認すると記録が変わる', async () => {
  await admin.waitForSelector('.req');
  assert.equal(await admin.textContent('#pendingCount'), '1');
  await admin.screenshot({ path: join(out, 'admin-corrections.png'), fullPage: true });
  await admin.click('.req button.primary');
  await admin.fill('#modalBody textarea', '確認済み');
  await admin.click('#modalOk');
  assert.match(await adminToast(), /承認しました/);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE staff_id = 'TEST01' AND end_time = '13:00'").first('n');
  assert.equal(n, 1);
});
await check('管理画面：月別集計（実績なしのスタッフも0で表示）', async () => {
  await admin.click('[data-tab="summary"]');
  await admin.waitForSelector('#sumTable tbody tr');
  const rows = await admin.$$eval('#sumTable tbody tr', trs => trs.map(t => t.innerText.split('\t')));
  assert.equal(rows.length, 5);
  assert.ok(rows.some(r => r[1] === 'TEST05' && r[5] === '0'));
  await admin.screenshot({ path: join(out, 'admin-summary.png'), fullPage: true });
});
await check('管理画面：個人別勤怠申請書', async () => {
  await admin.click('[data-tab="personal"]');
  await admin.selectOption('#perStaff', 'TEST01');
  await admin.waitForSelector('#perSheet h1');
  assert.match(await admin.textContent('#perSheet'), /氏名：テスト 一郎（いちろう）/);
  await admin.screenshot({ path: join(out, 'admin-personal.png'), fullPage: true });
});
let newPin = null;
await check('管理画面：PINの再発行 → 新しいPINでスタッフがログインできる', async () => {
  await admin.click('[data-tab="staff"]');
  await admin.waitForSelector('#staffTable tbody tr');
  const row = admin.locator('#staffTable tbody tr', { hasText: 'TEST05' });
  await row.locator('button', { hasText: 'PIN再発行' }).click();
  await admin.click('#modalOk');
  await admin.waitForSelector('.pinlist');
  newPin = (await admin.textContent('.pinlist tbody td:last-child')).trim();
  assert.match(newPin, /^\d{6}$/);
  await admin.screenshot({ path: join(out, 'admin-staff.png'), fullPage: true });
  const status = await page.evaluate(pin => fetch('/api/login', { method: 'POST', headers: { 'X-Requested-With': 'npas', 'Content-Type': 'application/json' }, body: JSON.stringify({ staffId: 'TEST05', pin }) }).then(r => r.status), newPin);
  assert.equal(status, 200);
});
await check('管理画面：データ移行（ファイル選択 → 確認 → 取り込み → 照合）', async () => {
  const exportJson = {
    format: 'npas-gas-export',
    version: 1,
    sheets: {
      スタッフ名簿: [{ _row: 2, スタッフID: 'S001', 氏名: '移行 花子', ニックネーム: 'はなこ', 学年: 2, 有効: true }],
      勤怠データ: [{ _row: 2, 記録ID: 'mig-1', スタッフID: 'S001', 氏名: '移行 花子', 勤務日: '2026/09/01', 出勤: '10:00:00', 退勤: '15:00:00', '休憩(分)': 60, 業務内容: '受付', '手当(円)': '', '勤務時間(時間)': 4, 登録方法: 'manual', 更新日時: '2026-09-01T15:00:00+09:00' }],
      打刻修正申請: [],
      修正履歴: [],
    },
  };
  const file = join(out, 'npas-export-sample.json');
  writeFileSync(file, JSON.stringify(exportJson));
  await admin.click('[data-tab="data"]');
  await admin.setInputFiles('#migFiles', file);
  await admin.waitForFunction(() => /勤怠データ 1件/.test(document.getElementById('migLoaded').textContent));
  await admin.click('#migDry');
  await admin.waitForFunction(() => /確認のみが終わりました/.test(document.getElementById('migProgress').textContent));
  assert.match(await admin.textContent('#migReport'), /問題はありませんでした/);
  await admin.click('#migImport');
  await admin.click('#modalOk');
  await admin.waitForFunction(() => /取り込みが終わりました/.test(document.getElementById('migProgress').textContent));
  assert.match(await admin.textContent('#migReport'), /問題はありませんでした/);
  await admin.click('#migVerify');
  await admin.waitForFunction(() => /照合が終わりました/.test(document.getElementById('migProgress').textContent));
  assert.match(await admin.textContent('#migReport'), /問題はありませんでした/);
  assert.doesNotMatch(await admin.textContent('#migReport'), /null|undefined/);
  await admin.screenshot({ path: join(out, 'admin-migration.png'), fullPage: true });
  assert.equal(await env.DB.prepare("SELECT hours FROM attendance WHERE id = 'mig-1'").first('hours'), 4);
});
await check('管理画面：操作履歴に一連の操作が残っている', async () => {
  await admin.click('[data-tab="audit"]');
  await admin.waitForSelector('#auditTable tbody tr');
  const text = await admin.textContent('#auditTable');
  for (const a of ['出勤打刻', '退勤打刻', '勤怠申請', '一括勤怠申請', '打刻修正申請', '打刻修正承認', 'PIN発行']) assert.ok(text.includes(a), a);
});
await check('画面上のJavaScriptエラーがない', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
server.close();
for (const r of results) console.log(r.join(' '));
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed} 件成功 / ${failed} 件失敗`);
process.exit(failed ? 1 : 0);
