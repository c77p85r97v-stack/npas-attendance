// データベースのバックアップ（SQLファイル）をパソコンに保存する
//   node tools/backup.mjs production   → backups/npas-production-日時.sql
// wrangler（Cloudflare公式ツール）の d1 export を使います。事前に npx wrangler login が必要です。
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';

const env = process.argv[2];
const DB = { production: 'npas-attendance', staging: 'npas-attendance-staging' }[env];
if (!DB) {
  console.error('使い方: node tools/backup.mjs production（または staging）');
  process.exit(1);
}
mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const file = `backups/npas-${env}-${stamp}.sql`;
const r = spawnSync('npx', ['wrangler', 'd1', 'export', DB, '--remote', '--env', env, '--output', file], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error('バックアップに失敗しました。上のエラーを確認してください。');
  process.exit(r.status || 1);
}
console.log(`保存しました: ${file}（${statSync(file).size.toLocaleString()} バイト）`);
