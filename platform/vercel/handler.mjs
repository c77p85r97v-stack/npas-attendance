// Vercel 用の入口（試用版）
// Cloudflare D1 の代わりに、SQLite のデータベースファイルを Vercel Blob（非公開）に保存する。
//
// 安全性の考え方：
//  ・1つのリクエストを処理する間、同じサーバー内の他のリクエストは待たせる（順番に処理）。
//  ・書き込みがあった場合だけファイルを保存する。保存は「読み込んだ時点から誰も更新していない」
//    ときだけ成功する（ETag による条件付き書き込み）。
//  ・他のサーバーが先に更新していたら、最新のファイルを読み直して、そのリクエストを最初からやり直す。
//    → 二重登録や更新の取りこぼしが起きない（旧仕様の LockService と同じ役割）。
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { D1Node } from '../../tools/d1-node.mjs';
import worker from '../../src/index.js';
import { resetTestData, testToolsEnabled } from '../../src/routes/testtools.js';

const BLOB_PATH = 'npas/attendance.sqlite';
const MAX_ATTEMPTS = 6;

function envFromProcess(db) {
  const e = process.env;
  return {
    DB: db,
    ENVIRONMENT: e.ENVIRONMENT || 'staging',
    ALLOW_TEST_TOOLS: e.ALLOW_TEST_TOOLS || 'false',
    PIN_PEPPER: e.PIN_PEPPER,
    ADMIN_SETUP_TOKEN: e.ADMIN_SETUP_TOKEN,
    BULK_POLICY: e.BULK_POLICY || 'all',
    LOG_TIMING: 'true',
  };
}

/**
 * blob: { get, put, head }（@vercel/blob と同じ使い方）。テストでは偽物を渡す。
 * 戻り値：Web 標準の Request を受け取り Response を返す関数
 */
export function createApp(blob) {
  const { get, put, head } = blob;
  let state = null; // { etag, file, db, saved }
  let queue = Promise.resolve();

  function openFile(bytes) {
    if (state) {
      try {
        state.db.db.close();
      } catch {}
      rmSync(state.file, { force: true });
    }
    const file = `/tmp/npas-${randomUUID()}.sqlite`;
    if (bytes) writeFileSync(file, bytes);
    const db = new D1Node(file).applyMigrations();
    db.db.exec('PRAGMA journal_mode = DELETE;');
    return { file, db };
  }
  
  /** 最新のデータベースを用意する（変わっていなければ手元のものを使う） */
  async function load() {
    // useCache: false … CDN のキャッシュを通さず、常に最新版を読む（304 なら手元のものを使う）
    const r = await get(BLOB_PATH, { access: 'private', useCache: false, ifNoneMatch: state?.etag || undefined });
    if (!r) {
      // まだ保存されていない（初回）：テスト用の道具が有効なら、テスト用スタッフとサンプルを作る
      if (!state || state.etag !== null) {
        state = { ...openFile(null), etag: null };
        const env = envFromProcess(state.db);
        if (testToolsEnabled(env)) await resetTestData(env, new Request('https://localhost/api/test/reset'));
      }
      return;
    }
    if (r.statusCode === 304 && state) return;
    const bytes = Buffer.from(await new Response(r.stream).arrayBuffer());
    state = { ...openFile(bytes), etag: r.blob.etag };
  }
  
  const changes = db => Number(db.db.prepare('SELECT total_changes() AS n').get().n);
  
  async function save() {
    const bytes = readFileSync(state.file);
    const res = await put(BLOB_PATH, bytes, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: state.etag !== null,
      ...(state.etag ? { ifMatch: state.etag } : {}),
      contentType: 'application/vnd.sqlite3',
      cacheControlMaxAge: 60,
    });
    state.etag = res.etag || (await head(BLOB_PATH)).etag;
    state.saved = changes(state.db);
  }
  
  function isConflict(e) {
    const s = `${e && e.name} ${e && e.message}`;
    return /Precondition|already exists|412|409/i.test(s);
  }
  
  async function handleOnce(makeRequest) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await load();
      const res = await worker.fetch(makeRequest(), envFromProcess(state.db));
      // 最後に保存した時点から変更がなければ（読み取りだけなら）保存しない
      if (changes(state.db) === (state.saved || 0)) return res;
      try {
        await save();
        return res;
      } catch (e) {
        // 保存できなかった変更は捨てて、最新を読み直してやり直す
        state = (() => {
          try {
            state.db.db.close();
          } catch {}
          rmSync(state.file, { force: true });
          return null;
        })();
        if (!isConflict(e)) throw e;
        console.warn(`npas: 同時更新のためやり直し (${attempt})`);
        await new Promise(r => setTimeout(r, 30 * attempt + Math.random() * 50));
      }
    }
    return new Response(JSON.stringify({ error: '混み合っています。少し待ってからもう一度お試しください' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return function app(makeRequest) {
    // 同じサーバー内のリクエストは1つずつ処理する
    const run = queue.then(() => handleOnce(makeRequest));
    queue = run.catch(() => {});
    return run;
  };
}

let defaultApp = null;

// Node.js 形式（req, res）の入口
export default async function handler(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  const makeRequest = () =>
    new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });

  if (!defaultApp) defaultApp = createApp(await import('@vercel/blob'));
  let response;
  try {
    response = await defaultApp(makeRequest);
  } catch (e) {
    console.error('npas fatal:', e && e.stack ? e.stack : String(e));
    response = new Response(JSON.stringify({ error: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const out = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') out[k] = v;
  });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}
