// Vercel 試用版の保存方式のテスト（Vercel Blob を偽物で再現）
// 複数のサーバー（インスタンス）が同時に書き込んでも、取りこぼし・二重登録が起きないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../platform/vercel/handler.mjs';

process.env.ENVIRONMENT = 'staging';
process.env.ALLOW_TEST_TOOLS = 'true';
process.env.PIN_PEPPER = 'vercel-test-pepper-0123456789';

/** ETag 付きの条件付き書き込みをする偽の Blob ストア（通信の遅れもまねる） */
function fakeBlob() {
  const store = new Map();
  const stats = { puts: 0, conflicts: 0 };
  const delay = () => new Promise(r => setTimeout(r, Math.random() * 8));
  const etagOf = b => '"' + createHash('md5').update(b).digest('hex') + '"';
  return {
    stats,
    store,
    async get(path, { ifNoneMatch } = {}) {
      await delay();
      const v = store.get(path);
      if (!v) return null;
      if (ifNoneMatch && ifNoneMatch === v.etag) return { statusCode: 304, stream: null, blob: { etag: v.etag } };
      return { statusCode: 200, stream: new Blob([v.bytes]).stream(), blob: { etag: v.etag } };
    },
    async head(path) {
      await delay();
      return { etag: store.get(path).etag };
    },
    async list({ prefix }) {
      await delay();
      const blobs = [...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ pathname: k, url: 'blob://' + k, size: v.bytes.length, uploadedAt: new Date() }));
      return { blobs, hasMore: false };
    },
    async del(urls) {
      for (const u of [].concat(urls)) store.delete(u.replace('blob://', ''));
    },
    async put(path, bytes, { allowOverwrite, ifMatch }) {
      await delay();
      const cur = store.get(path);
      if (cur && !allowOverwrite) {
        stats.conflicts++;
        throw Object.assign(new Error('Vercel Blob: This blob already exists'), { name: 'BlobError' });
      }
      if (ifMatch && (!cur || cur.etag !== ifMatch)) {
        stats.conflicts++;
        throw Object.assign(new Error('precondition failed'), { name: 'BlobPreconditionFailedError' });
      }
      const b = Buffer.from(bytes);
      const etag = etagOf(Buffer.concat([b, Buffer.from(String(Date.now() + Math.random()))]));
      store.set(path, { bytes: b, etag });
      stats.puts++;
      return { etag };
    },
  };
}

/** ブラウザ代わり（Cookie を保持）。どのインスタンスに届くかは毎回ランダム */
function client(apps) {
  const cookies = new Map();
  return async (method, path, body) => {
    const app = apps[Math.floor(Math.random() * apps.length)];
    const headers = new Headers({ 'X-Requested-With': 'npas', Origin: 'https://npas.vercel.test' });
    if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (body) headers.set('Content-Type', 'application/json');
    const res = await app(() => new Request('https://npas.vercel.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }));
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.status, data: await res.json() };
  };
}

test('Vercel版：初回にテスト用データが作られ、保存・再読み込みできる', async () => {
  const blob = fakeBlob();
  const a = createApp(blob);
  const c = client([a]);
  const staff = await c('GET', '/api/staff');
  assert.equal(staff.status, 200);
  assert.ok(staff.data.some(s => s.id === 'TEST01'));
  assert.equal(blob.stats.puts, 1, JSON.stringify(blob.stats)); // 初期データを保存
  assert.equal((await c('POST', '/api/login', { staffId: 'TEST01', pin: '1234' })).status, 200);
  assert.equal((await c('POST', '/api/attendance', { date: '2025-05-05', start: '10:00', end: '15:00', breakMin: '0' })).status, 200);
  // 別のインスタンス（新しく起動したサーバー）からも見える
  const b = createApp(blob);
  const c2 = client([b]);
  await c2('POST', '/api/login', { staffId: 'TEST01', pin: '1234' });
  const h = await c2('GET', '/api/history?month=2025-05');
  assert.equal(h.data.entries.length, 1);
  // 読み取りだけでは保存しない
  const puts = blob.stats.puts;
  await c2('GET', '/api/history?month=2025-05');
  assert.equal(blob.stats.puts, puts);
});

test('Vercel版：3つのインスタンスに同時に書き込んでも、取りこぼし・二重登録がない', async () => {
  const blob = fakeBlob();
  const apps = [createApp(blob), createApp(blob), createApp(blob)];
  const c0 = client(apps);
  await c0('GET', '/api/staff'); // 初期化
  const users = ['TEST01', 'TEST02', 'TEST03', 'TEST04', 'TEST05'].map(() => client(apps));
  const ids = ['TEST01', 'TEST02', 'TEST03', 'TEST04', 'TEST05'];
  await Promise.all(users.map((c, i) => c('POST', '/api/login', { staffId: ids[i], pin: '1234' })));
  // 5人 × 4件の申請を同時に、さらに全員が同時に出勤を5回押す
  const results = await Promise.all(
    users.flatMap((c, i) => [
      ...[1, 2, 3, 4].map(d => c('POST', '/api/attendance', { date: `2026-11-0${d}`, start: '10:00', end: '12:00', breakMin: '0', task: ids[i] })),
      ...[1, 2, 3, 4, 5].map(() => c('POST', '/api/clock/in', {})),
    ])
  );
  const saves = results.filter(r => r.data.workDate);
  assert.equal(saves.length, 20, JSON.stringify(results.filter(r => r.status >= 500)));
  const clockOk = results.filter(r => r.data.time).length;
  assert.equal(clockOk, 5, '出勤は1人1回だけ成功');
  assert.ok(blob.stats.conflicts > 0, '同時更新の衝突が実際に起きている（やり直しで解決）');
  // 最新のデータを新しいインスタンスで確認
  const fresh = client([createApp(blob)]);
  for (let i = 0; i < 5; i++) {
    await fresh('POST', '/api/login', { staffId: ids[i], pin: '1234' });
    const h = await fresh('GET', '/api/history?month=2026-11');
    assert.equal(h.data.entries.length, 4, `${ids[i]} の記録数`);
    assert.ok(h.data.entries.every(e => e.task === ids[i]), '他人の記録が混ざらない');
    assert.equal((await fresh('GET', '/api/clock/status')).data.active, true);
  }
});

test('Vercel版：テスト記録の初期化→バックアップから復元、毎日の自動バックアップ', async () => {
  process.env.CRON_SECRET = 'cron-secret-0123456789abcdef';
  const blob = fakeBlob();
  const app = createApp(blob);
  const c = client([app]);
  await c('POST', '/api/login', { staffId: 'TEST01', pin: '1234' });
  await c('POST', '/api/attendance', { date: '2025-05-05', start: '10:00', end: '15:00', breakMin: '0' });
  const admin = client([app]);
  await admin('POST', '/api/admin/login', { loginId: 'testadmin', password: 'test-password-1234' });
  const r = await admin('POST', '/api/admin/reset-history', { confirm: '初期化' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.backup, /^\d{8}-\d{6}-before-reset$/);
  const list = await admin('GET', '/api/admin/backups');
  assert.ok(list.data.backups.some(b => b.name === r.data.backup));
  // 初期化後は記録なし（新しいインスタンスでも）
  const c2 = client([createApp(blob)]);
  await c2('POST', '/api/login', { staffId: 'TEST01', pin: '1234' });
  assert.equal((await c2('GET', '/api/history?month=2025-05')).data.entries.length, 0);
  // 復元
  assert.equal((await admin('POST', '/api/admin/backups/restore', { name: r.data.backup, confirm: 'いいえ' })).status, 400);
  const rs = await admin('POST', '/api/admin/backups/restore', { name: r.data.backup, confirm: '復元' });
  assert.equal(rs.status, 200, JSON.stringify(rs.data));
  const c3 = client([createApp(blob)]);
  await c3('POST', '/api/login', { staffId: 'TEST01', pin: '1234' });
  assert.equal((await c3('GET', '/api/history?month=2025-05')).data.entries.length, 1);
  // 毎日の自動バックアップ（合言葉がないと拒否）
  const raw = async auth => app(() => new Request('https://npas.vercel.test/api/cron/backup', { headers: auth ? { Authorization: auth } : {} }));
  assert.equal((await raw()).status, 401);
  assert.equal((await raw('Bearer wrong')).status, 401);
  const ok = await raw('Bearer cron-secret-0123456789abcdef');
  assert.equal(ok.status, 200);
  assert.ok([...blob.store.keys()].some(k => k.endsWith('-daily.sqlite')));
});
