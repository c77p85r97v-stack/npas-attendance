// 画面の比較：旧GAS版 Index.html と新しいクラウド版を、同じデータで表示して画像を比べる。
// 旧版は google.script.run を模擬（中身は新しいAPIを呼ぶ）して表示する。
//   1) node tools/dev-server.mjs を起動しておく
//   2) node test/ui/compare-ui.mjs <旧Index.html> <出力フォルダ>
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const [, , originalPath, outDir = '/tmp/ui-compare'] = process.argv;
mkdirSync(outDir, { recursive: true });
const originalHtml = readFileSync(originalPath, 'utf8');
const apiJs = readFileSync(new URL('../../public/js/api.js', import.meta.url), 'utf8');

// 旧版用：google.script.run を新APIへの呼び出しで再現
const gasShim = `${apiJs};
window.google={script:{run:(function mk(ok,ng){return new Proxy({},{get(_,k){
  if(k==='withSuccessHandler')return f=>mk(f,ng);
  if(k==='withFailureHandler')return f=>mk(ok,f);
  return (...a)=>window.npasApi(k,a).then(r=>ok&&ok(r),e=>ng&&ng(e));}})})()}};`;

const browser = await chromium.launch();
const results = [];
for (const variant of ['original', 'new']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.setFixedTime(new Date('2026-10-27T14:00:00+09:00'));
  if (variant === 'original') {
    await page.addInitScript(gasShim);
    await page.route(BASE + '/__original', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: originalHtml }));
    await page.goto(BASE + '/__original');
  } else {
    await page.goto(BASE + '/');
  }
  await page.waitForFunction(() => !document.getElementById('grade').disabled);
  const shot = async name => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${name}-${variant}.png`), fullPage: true });
  };
  await shot('01-login');
  await page.selectOption('#grade', '1');
  await page.selectOption('#person', 'TEST01');
  await shot('02-login-selected');
  if (variant === 'original') {
    // 旧版はPINがないので、APIのログインだけ裏で済ませる（Cookieを共有）
    await page.evaluate(() => window.npasApi('login', ['TEST01', '1234']));
  } else if (await page.isVisible('#pin')) {
    await page.fill('#pin', '1234');
  }
  await page.click('#loginBtn');
  await page.waitForSelector('#home.active');
  await page.waitForFunction(() => document.getElementById('statusText').textContent !== '確認中...');
  await shot('03-home');
  for (const [go, name, wait] of [
    ['request', '04-request'],
    ['bulkRequest', '05-bulk', '.npas-bulk-person'],
    ['history', '06-history', '.entry, .empty'],
    ['corrections', '07-corrections', '.correction-pick, #correctionEntries .empty'],
  ]) {
    await page.evaluate(g => show(g), go);
    if (wait) await page.waitForSelector(wait);
    await page.waitForTimeout(300);
    await shot(name);
    await page.evaluate(() => show('home'));
  }
  results.push({ variant, errors });
  await ctx.close();
}
await browser.close();

// 画像の差分（ピクセル単位）。sharp で読み込んで比較する
const sharp = require('sharp');
const report = [];
for (const name of ['01-login', '02-login-selected', '03-home', '04-request', '05-bulk', '06-history', '07-corrections']) {
  const a = sharp(join(outDir, `${name}-original.png`));
  const b = sharp(join(outDir, `${name}-new.png`));
  const [ma, mb] = await Promise.all([a.metadata(), b.metadata()]);
  let diffPixels = null;
  if (ma.width === mb.width && ma.height === mb.height) {
    const [ra, rb] = await Promise.all([a.raw().toBuffer(), b.raw().toBuffer()]);
    diffPixels = 0;
    const ch = ma.channels;
    for (let i = 0; i < ra.length; i += ch) {
      if (Math.abs(ra[i] - rb[i]) + Math.abs(ra[i + 1] - rb[i + 1]) + Math.abs(ra[i + 2] - rb[i + 2]) > 30) diffPixels++;
    }
  }
  report.push({ screen: name, original: `${ma.width}x${ma.height}`, new: `${mb.width}x${mb.height}`, diffPixels });
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ results, report }, null, 2));
console.table(report);
console.log('pageerrors', JSON.stringify(results));
