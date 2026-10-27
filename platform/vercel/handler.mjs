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
const BACKUP_PREFIX = 'npas/backups/';
const SQLITE_TYPE = 'application/vnd.sqlite3';
const MAX_ATTEMPTS = 12;

function envFromProcess(db, extra = {}) {
  const e = process.env;
  return {
    ...extra,
    DB: db,
    CRON_SECRET: e.CRON_SECRET,
    AUTH_MODE: e.AUTH_MODE,
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
  const { get, put, head, list, del } = blob;
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
  
  const stamp = () => {
    const d = new Date(Date.now() + 9 * 3600e3).toISOString();
    return d.slice(0, 10).replace(/-/g, '') + '-' + d.slice(11, 19).replace(/:/g, '');
  };
  const validName = n => /^[\w-]{1,80}$/.test(String(n));

  /** バックアップ機能（管理画面の「テスト記録の初期化」「バックアップ」から使う） */
  function backupsApi(ctx) {
    return {
      async create(label) {
        const name = `${stamp()}-${label}`;
        await put(`${BACKUP_PREFIX}${name}.sqlite`, readFileSync(state.file), {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: SQLITE_TYPE,
        });
        return { name };
      },
      async list() {
        const out = [];
        let cursor;
        do {
          const r = await list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
          for (const b of r.blobs) {
            out.push({ name: b.pathname.slice(BACKUP_PREFIX.length).replace(/\.sqlite$/, ''), size: b.size, uploadedAt: b.uploadedAt, url: b.url });
          }
          cursor = r.hasMore ? r.cursor : undefined;
        } while (cursor);
        return out.sort((a, b) => (a.name < b.name ? 1 : -1)).map(({ url, ...x }) => x);
      },
      async read(name) {
        if (!validName(name)) return null;
        const r = await get(`${BACKUP_PREFIX}${name}.sqlite`, { access: 'private', useCache: false });
        if (!r || r.statusCode !== 200) return null;
        return Buffer.from(await new Response(r.stream).arrayBuffer());
      },
      async restore(name, { operator }) {
        const bytes = await this.read(name);
        if (!bytes) throw Object.assign(new Error('バックアップが見つかりません'), { status: 404 });
        ctx.pendingRestore = { bytes, name, operator };
      },
      async prune({ keepDaily }) {
        const r = await list({ prefix: BACKUP_PREFIX, limit: 1000 });
        const daily = r.blobs.filter(b => b.pathname.endsWith('-daily.sqlite')).sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
        const old = daily.slice(keepDaily);
        if (old.length) await del(old.map(b => b.url));
        return old.length;
      },
    };
  }

  /** 復元：バックアップの内容を新しいデータベースとして開き、操作履歴を1行足して保存する */
  function applyRestore(p) {
    const etag = state.etag;
    state = { ...openFile(p.bytes), etag, saved: 0 };
    state.db.db
      .prepare("INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, 'バックアップから復元', ?, ?, '', '')")
      .run(new Date().toISOString(), p.name, p.operator || '');
  }

  async function handleOnce(makeRequest) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await load();
      const ctx = {};
      const res = await worker.fetch(makeRequest(), envFromProcess(state.db, { BACKUPS: backupsApi(ctx) }));
      if (ctx.pendingRestore && res.status === 200) applyRestore(ctx.pendingRestore);
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
        await new Promise(r => setTimeout(r, Math.min(40 * attempt, 400) + Math.random() * 120));
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
