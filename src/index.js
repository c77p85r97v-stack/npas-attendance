// N-PAS Attendance クラウド版（Cloudflare Workers）
// 画面（public/ 以下のファイル）は Workers の静的アセットとして配信し、
// /api/ 以下だけをこのプログラムが処理する。
import { json, errorResponse, assertSameOrigin, HttpError } from './lib/http.js';
import { authMode } from './lib/auth.js';
import * as staff from './routes/staff.js';
import * as att from './routes/attendance.js';
import * as clock from './routes/clock.js';
import * as bulk from './routes/bulk.js';
import * as corr from './routes/corrections.js';
import * as admin from './routes/admin.js';
import * as reports from './routes/reports.js';
import * as migrate from './routes/migrate.js';
import * as testtools from './routes/testtools.js';
import * as maint from './routes/maintenance.js';

// [メソッド, パス(正規表現), 処理]
const ROUTES = [
  ['GET', /^\/api\/health$/, env => json({ ok: true, environment: env.ENVIRONMENT || 'development' })],
  ['GET', /^\/api\/staff$/, env => staff.listStaff(env)],
  ['GET', /^\/api\/bootstrap$/, async env => {
    // ログイン画面に必要なもの（名簿と設定）を1回の通信で返す
    const staffRes = await staff.listStaff(env);
    return json({ staff: await staffRes.json(), config: { authMode: authMode(env), environment: env.ENVIRONMENT || 'development' } });
  }],
  ['GET', /^\/api\/config$/, env => json({ authMode: authMode(env), environment: env.ENVIRONMENT || 'development', testTools: testtools.testToolsEnabled(env), backups: !!env.BACKUPS })],
  ['POST', /^\/api\/login$/, (env, req) => staff.login(env, req)],
  ['POST', /^\/api\/logout$/, (env, req) => staff.logout(env, req)],
  ['GET', /^\/api\/me$/, (env, req) => staff.me(env, req)],
  ['GET', /^\/api\/clock\/status$/, (env, req) => clock.clockStatus(env, req)],
  ['POST', /^\/api\/clock\/in$/, (env, req) => clock.clockIn(env, req, now(env))],
  ['POST', /^\/api\/clock\/out$/, (env, req) => clock.clockOut(env, req, now(env))],
  ['POST', /^\/api\/attendance$/, (env, req) => att.saveAttendance(env, req)],
  ['GET', /^\/api\/history$/, (env, req) => att.getHistory(env, req)],
  ['POST', /^\/api\/bulk$/, (env, req) => bulk.saveBulk(env, req)],
  ['POST', /^\/api\/corrections$/, (env, req) => corr.submitCorrection(env, req)],
  ['POST', /^\/api\/corrections\/delete$/, (env, req) => corr.submitDeletion(env, req)],
  ['GET', /^\/api\/my\/requests$/, (env, req) => corr.myRequests(env, req)],
  ['GET', /^\/api\/my\/requests$/, (env, req) => corr.myRequests(env, req)],

  ['POST', /^\/api\/admin\/login$/, (env, req) => admin.login(env, req)],
  ['POST', /^\/api\/admin\/logout$/, (env, req) => admin.logout(env, req)],
  ['GET', /^\/api\/admin\/me$/, (env, req) => admin.me(env, req)],
  ['GET', /^\/api\/admin\/setup$/, env => admin.setupStatus(env)],
  ['POST', /^\/api\/admin\/setup$/, (env, req) => admin.setupFirstAdmin(env, req)],
  ['GET', /^\/api\/admin\/admins$/, (env, req) => admin.listAdmins(env, req)],
  ['POST', /^\/api\/admin\/admins$/, (env, req) => admin.addAdmin(env, req)],
  ['POST', /^\/api\/admin\/password$/, (env, req) => admin.changeOwnPassword(env, req)],
  ['GET', /^\/api\/admin\/clocked-in$/, (env, req) => admin.clockedIn(env, req)],
  ['GET', /^\/api\/admin\/corrections$/, (env, req) => admin.listCorrections(env, req)],
  ['POST', /^\/api\/admin\/corrections\/([\w-]+)\/approve$/, (env, req, m) => admin.approveCorrection(env, req, m[1])],
  ['POST', /^\/api\/admin\/corrections\/([\w-]+)\/reject$/, (env, req, m) => admin.rejectCorrection(env, req, m[1])],
  ['GET', /^\/api\/admin\/staff$/, (env, req) => admin.listStaffAdmin(env, req)],
  ['POST', /^\/api\/admin\/staff$/, (env, req) => admin.saveStaff(env, req)],
  ['POST', /^\/api\/admin\/staff\/([\w-]+)\/pin$/, (env, req, m) => admin.issuePin(env, req, m[1])],
  ['POST', /^\/api\/admin\/staff\/([\w-]+)\/unlock$/, (env, req, m) => admin.unlockStaff(env, req, m[1])],
  ['POST', /^\/api\/admin\/staff\/([\w-]+)\/cancel-clock$/, (env, req, m) => admin.cancelClock(env, req, m[1])],
  ['POST', /^\/api\/admin\/pins\/issue-missing$/, (env, req) => admin.issueMissingPins(env, req)],
  ['GET', /^\/api\/admin\/records$/, (env, req) => admin.listRecords(env, req)],
  ['POST', /^\/api\/admin\/records$/, (env, req) => admin.addRecord(env, req)],
  ['POST', /^\/api\/admin\/records\/([\w-]+)\/update$/, (env, req, m) => admin.updateRecord(env, req, m[1])],
  ['POST', /^\/api\/admin\/records\/([\w-]+)\/delete$/, (env, req, m) => admin.deleteRecord(env, req, m[1])],
  ['GET', /^\/api\/admin\/audit$/, (env, req) => admin.listAudit(env, req)],
  ['GET', /^\/api\/admin\/summary$/, (env, req) => reports.summary(env, req)],
  ['GET', /^\/api\/admin\/summary\.csv$/, (env, req) => reports.summaryCsv(env, req)],
  ['GET', /^\/api\/admin\/personal$/, (env, req) => reports.personal(env, req)],
  ['GET', /^\/api\/admin\/personal-batch$/, (env, req) => reports.personalBatch(env, req)],
  ['GET', /^\/api\/admin\/export$/, (env, req) => reports.exportAll(env, req)],
  ['GET', /^\/api\/admin\/export\/page$/, (env, req) => reports.exportPage(env, req)],
  ['POST', /^\/api\/admin\/migrate$/, (env, req) => migrate.migrateChunk(env, req)],
  ['POST', /^\/api\/admin\/migrate\/report$/, (env, req) => migrate.saveReport(env, req)],
  ['GET', /^\/api\/admin\/migrate\/reports$/, (env, req) => migrate.listReports(env, req)],

  ['GET', /^\/api\/admin\/reset-history$/, (env, req) => maint.resetPreview(env, req)],
  ['POST', /^\/api\/admin\/reset-history$/, (env, req) => maint.resetHistory(env, req)],
  ['GET', /^\/api\/admin\/backups$/, (env, req) => maint.listBackups(env, req)],
  ['POST', /^\/api\/admin\/backups$/, (env, req) => maint.createBackup(env, req)],
  ['GET', /^\/api\/admin\/backups\/download$/, (env, req) => maint.downloadBackup(env, req)],
  ['POST', /^\/api\/admin\/backups\/restore$/, (env, req) => maint.restoreBackup(env, req)],
  ['GET', /^\/api\/cron\/backup$/, (env, req) => maint.cronBackup(env, req)],

  ['POST', /^\/api\/test\/reset$/, (env, req) => testtools.resetTestData(env, req)],
  ['GET', /^\/api\/test\/enabled$/, env => json({ enabled: testtools.testToolsEnabled(env) })],
  ['GET', /^\/api\/test\/selfcheck$/, (env, req) => testtools.selfCheck(env, req, handleApi)],
];

// テストでは時計を差し替えられる（本番の設定値からは変更できない）
function now(env) {
  return typeof env.__clock === 'function' ? env.__clock() : new Date();
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const started = Date.now();
  let res;
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    let matched = false;
    for (const [m, re, fn] of ROUTES) {
      const hit = url.pathname.match(re);
      if (!hit) continue;
      matched = true;
      if (m !== method) continue;
      res = await fn(env, request, hit);
      break;
    }
    if (!res) throw new HttpError(matched ? 405 : 404, matched ? '許可されていない操作です' : '見つかりません');
  } catch (e) {
    res = errorResponse(e);
  }
  // 応答時間をログに残す（個人情報は出さない：パスとステータスと時間のみ）
  if (env.LOG_TIMING !== 'false') console.log(`api ${request.method} ${url.pathname} ${res.status} ${Date.now() - started}ms`);
  const headers = new Headers(res.headers);
  headers.set('Server-Timing', `app;dur=${Date.now() - started}`);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    // 静的ファイル（画面）
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
