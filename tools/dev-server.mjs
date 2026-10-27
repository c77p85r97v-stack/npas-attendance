// ローカル確認用サーバー（Node.js 22.5 以上だけで動く。インストール不要）
//   node tools/dev-server.mjs            → http://localhost:8787
//   PORT=3000 node tools/dev-server.mjs  → ポートを変更
//   DB_FILE=:memory: node tools/dev-server.mjs → 保存しない（毎回まっさら）
// 本番の Cloudflare とは別物の「模擬環境」です。データは .local/dev.sqlite に保存されます。
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Node } from './d1-node.mjs';
import { handleApi } from '../src/index.js';
import { resetTestData } from '../src/routes/testtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

// public/_headers を読んで、静的ファイルにも本番と同じヘッダーを付ける
const headerRules = [];
{
  let cur = null;
  for (const line of readFileSync(join(PUBLIC, '_headers'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), headers: {} };
      headerRules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function staticFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || p.includes('_headers')) return null;
  let target = file;
  if (!existsSync(target) && existsSync(target + '.html')) target += '.html';
  if (!existsSync(target)) return null;
  const body = await readFile(target).catch(() => null);
  if (!body) return null;
  const headers = { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream' };
  for (const r of headerRules) if (r.pattern.test(p) || r.pattern.test(pathname)) Object.assign(headers, r.headers);
  delete headers['Strict-Transport-Security'];
  return new Response(body, { headers });
}

/** サーバーを起動する（自動テストからも使う） */
export function startServer(env, port) {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      try {
        const url = `http://${req.headers.host}${req.url}`;
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const pathname = new URL(url).pathname;
        const response = pathname.startsWith('/api/') ? await handleApi(request, env) : (await staticFile(pathname)) || new Response('Not found', { status: 404 });
        const h = {};
        response.headers.forEach((v, k) => {
          if (k === 'set-cookie') return;
          h[k] = v;
    });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    // http://localhost では Secure 属性付き Cookie もブラウザが受け付ける
    if (cookies.length) h['set-cookie'] = cookies;
    res.writeHead(response.status, h);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('error');
  }
    });
    server.listen(port, () => resolve(server));
  });
}

export async function createDevEnv(dbFile) {
  if (dbFile !== ':memory:') await mkdir(dirname(dbFile), { recursive: true });
  const env = {
    DB: new D1Node(dbFile).applyMigrations(),
    ENVIRONMENT: 'development',
    ALLOW_TEST_TOOLS: 'true',
    PIN_PEPPER: process.env.PIN_PEPPER || 'local-dev-pepper-0123456789',
    LOG_TIMING: process.env.LOG_TIMING || 'true',
  };
  // 初回はテスト用スタッフ・管理者・サンプルデータを作る
  const hasStaff = await env.DB.prepare('SELECT COUNT(*) AS n FROM staff').first('n');
  if (!hasStaff) {
    await resetTestData(env, new Request('http://localhost/api/test/reset'));
    console.log('テスト用データを作成しました（スタッフ TEST01〜05 / PIN 1234、管理者 testadmin / test-password-1234）');
  }
  return env;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const PORT = Number(process.env.PORT || 8787);
  const env = await createDevEnv(process.env.DB_FILE || join(ROOT, '.local', 'dev.sqlite'));
  await startServer(env, PORT);
  console.log(`N-PAS ローカル確認用サーバー: http://localhost:${PORT}`);
  console.log(`  スタッフ画面   http://localhost:${PORT}/`);
  console.log(`  管理画面       http://localhost:${PORT}/admin.html`);
  console.log(`  テスト画面     http://localhost:${PORT}/selftest.html`);
  console.log('（止めるときは Ctrl + C）');
}
