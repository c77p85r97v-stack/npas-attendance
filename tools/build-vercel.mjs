// Vercel 試用版のビルド（Build Output API v3 の形式で .vercel/output を作る）
//   node tools/build-vercel.mjs
// ・public/ の画面ファイル → 静的ファイル（public/_headers の内容をヘッダー設定に変換）
// ・/api/* → 1つの関数（platform/vercel/handler.mjs）
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel', 'output');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'static'), { recursive: true });

// 1) 静的ファイル
cpSync(join(ROOT, 'public'), join(OUT, 'static'), { recursive: true, filter: src => !src.endsWith('_headers') });

// 2) _headers → routes のヘッダー設定
const routes = [];
let cur = null;
for (const line of readFileSync(join(ROOT, 'public', '_headers'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  if (!/^\s/.test(line)) {
    const glob = line.trim();
    cur = { src: '^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', headers: {}, continue: true };
    routes.push(cur);
  } else if (cur) {
    const i = line.indexOf(':');
    cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
routes.push({ handle: 'filesystem' });
routes.push({ src: '^/api/(.*)$', dest: '/api' });
writeFileSync(join(OUT, 'config.json'), JSON.stringify({ version: 3, routes }, null, 2));

// 3) 関数
const FN = join(OUT, 'functions', 'api.func');
mkdirSync(FN, { recursive: true });
for (const d of ['src', 'migrations', 'platform']) cpSync(join(ROOT, d), join(FN, d), { recursive: true });
mkdirSync(join(FN, 'tools'), { recursive: true });
cpSync(join(ROOT, 'tools', 'd1-node.mjs'), join(FN, 'tools', 'd1-node.mjs'));
writeFileSync(
  join(FN, 'package.json'),
  JSON.stringify({ name: 'npas-api', private: true, type: 'module', dependencies: { '@vercel/blob': 'latest' } }, null, 2)
);
writeFileSync(
  join(FN, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs24.x',
      handler: 'platform/vercel/handler.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: false,
      maxDuration: 30,
      regions: ['hnd1'],
    },
    null,
    2
  )
);
if (!process.env.SKIP_NPM) {
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: FN, stdio: 'inherit' });
  if (!existsSync(join(FN, 'node_modules', '@vercel', 'blob'))) throw new Error('@vercel/blob のインストールに失敗しました');
}
console.log('Vercel 用のビルドを作成しました:', OUT);
