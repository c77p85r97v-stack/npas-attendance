// 印刷の確認：学年ごとのまとめ印刷で「1人＝1ページ」になっているかを、実際に PDF にして数える
//   node test/ui/print-check.mjs [出力フォルダ]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDevEnv, startServer } from '../../tools/dev-server.mjs';
import { resetTestData } from '../../src/routes/testtools.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const out = process.argv[2] || '/tmp/print-check';
mkdirSync(out, { recursive: true });

const env = await createDevEnv(':memory:');
env.LOG_TIMING = 'false';
await resetTestData(env, new Request('http://localhost/api/test/reset?samples=0'));
const month = '2026-10';
// きつめのデータ：毎日2件、長い業務内容、1日だけ4件
const at = new Date().toISOString();
let order = 1;
const add = (sid, d, s, e, task) =>
  env.DB.prepare(
    `INSERT INTO attendance (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours, method, row_order, source, created_at, updated_at)
     VALUES (?, ?, 'x', ?, ?, ?, 0, ?, 300, 2, 'manual', ?, 'app', ?, ?)`
  ).bind(crypto.randomUUID(), sid, `${month}-${String(d).padStart(2, '0')}`, s, e, task, order++, at, at).run();
for (let d = 1; d <= 31; d++) {
  await add('TEST01', d, '09:00', '11:00', '受付・案内・資料の準備と片付け、来場者対応、備品の確認など長めの業務内容');
  await add('TEST01', d, '13:00', '15:00', '午後の受付');
}
for (const [s, e] of [['16:00', '17:00'], ['18:00', '19:00']]) await add('TEST01', 15, s, e, '追加の業務');
await add('TEST02', 3, '10:00', '12:00', '受付');

const server = await startServer(env, 0);
const BASE = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto(BASE + '/admin.html');
await page.fill('#loginId', 'testadmin');
await page.fill('#password', 'test-password-1234');
await page.click('#loginBtn');
await page.waitForSelector('#appView:not([hidden])');
await page.click('[data-tab="personal"]');
await page.fill('#perMonth', month);
await page.evaluate(() => (window.print = () => (window.__printed = true)));
const results = [];
for (const [grade, expected] of [['1', 2], ['all', 5]]) {
  await page.evaluate(() => (window.__printed = false));
  await page.selectOption('#perGrade', grade);
  await page.click('#perPrintGrade');
  await page.waitForFunction(() => window.__printed === true);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  writeFileSync(join(out, `grade-${grade}.pdf`), pdf);
  const pages = (await PDFDocument.load(pdf)).getPageCount();
  results.push({ grade, sheets: expected, pages });
}
// 1人分の印刷（「この人を印刷」）も1ページ
await page.selectOption('#perStaff', 'TEST01');
await page.waitForFunction(() => document.querySelectorAll('#perSheet .sheet').length === 1);
await page.evaluate(() => (window.__printed = false));
await page.click('#perPrint');
await page.waitForFunction(() => window.__printed === true);
await page.emulateMedia({ media: 'print' });
const one = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
writeFileSync(join(out, 'one.pdf'), one);
results.push({ grade: '1人（TEST01・毎日2件）', sheets: 1, pages: (await PDFDocument.load(one)).getPageCount() });
await browser.close();
server.close();
console.table(results);
for (const r of results) assert.equal(r.pages, r.sheets, `${r.grade}: ${r.sheets}人分が ${r.pages} ページになった`);
console.log('OK：すべて1人1ページ');
