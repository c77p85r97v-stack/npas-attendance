// 応答時間の測定（ローカル模擬環境）
// データ量を増やしても遅くならないかを確認する。ネットワークの往復時間は含まない。
//   node tools/bench.mjs [勤怠件数]
import { createTestEnv } from './d1-node.mjs';
import { hashSecret } from '../src/lib/crypto.js';
import { Client } from '../test/helpers.mjs';

const N = Number(process.argv[2] || 20000);
const STAFF = 100;
const env = createTestEnv();
const at = new Date().toISOString();
const pin = await hashSecret('2468', env.PIN_PEPPER);
for (let i = 1; i <= STAFF; i++) {
  await env.DB.prepare('INSERT INTO staff (id, name, nick, grade, active, pin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
    .bind('S' + String(i).padStart(3, '0'), 'スタッフ' + i, 'nick' + i, String(1 + (i % 4)), pin, at, at)
    .run();
}
const pw = await hashSecret('admin-password-123', env.PIN_PEPPER);
await env.DB.prepare("INSERT INTO admins (id, login_id, name, password_hash, created_at) VALUES ('a1','admin','管理',?,?)").bind(pw, at).run();

// N 件の勤怠（3年分に分散）を一括投入
const rows = [];
for (let i = 0; i < N; i++) {
  const d = new Date(Date.UTC(2024, 0, 1) + (i % 1000) * 86400000).toISOString().slice(0, 10);
  rows.push({ id: 'r' + i, sid: 'S' + String((i % STAFF) + 1).padStart(3, '0'), d, o: i + 1 });
}
for (let i = 0; i < rows.length; i += 5000) {
  await env.DB.prepare(
    `INSERT INTO attendance (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours, method, row_order, source, created_at, updated_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.sid'), 'x', json_extract(value,'$.d'), '10:00', '15:00', 0, '', NULL, 5, 'manual', json_extract(value,'$.o'), 'app', ?, ? FROM json_each(?)`
  )
    .bind(at, at, JSON.stringify(rows.slice(i, i + 5000)))
    .run();
}

const staff = new Client(env);
await staff.post('/api/login', { staffId: 'S001', pin: '2468' });
const admin = new Client(env);
await admin.post('/api/admin/login', { loginId: 'admin', password: 'admin-password-123' });

async function measure(name, fn, times = 30) {
  const ms = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    const r = await fn(i);
    ms.push(performance.now() - t);
    if (r && r.status && r.status >= 400) throw new Error(name + ' ' + JSON.stringify(r.data));
  }
  ms.sort((a, b) => a - b);
  return { 処理: name, 中央値ms: +ms[Math.floor(ms.length / 2)].toFixed(2), 最大ms: +ms[ms.length - 1].toFixed(2) };
}

const out = [];
out.push(await measure('スタッフ一覧（ログイン画面）', () => staff.get('/api/staff')));
out.push(await measure('ログイン（PIN照合）', () => new Client(env).post('/api/login', { staffId: 'S002', pin: '2468' }), 10));
out.push(await measure('出勤状態の取得', () => staff.get('/api/clock/status')));
out.push(await measure('月別履歴（1人・1か月）', () => staff.get('/api/history?month=2025-06')));
out.push(await measure('通常の勤怠申請（保存・重なりチェック込み）', i => staff.post('/api/attendance', { date: `2028-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, start: '10:00', end: '15:00', breakMin: '0', task: 'bench' + i, allowance: '' })));
out.push(await measure('出勤→退勤（2回の通信の合計）', async () => {
  await staff.post('/api/clock/in');
  return staff.post('/api/clock/out', { breakMin: '0', task: '' }).then(r => (r.status === 400 ? { status: 200 } : r));
}));
const ids = Array.from({ length: 100 }, (_, i) => 'S' + String(i + 1).padStart(3, '0'));
out.push(await measure('一括勤怠申請（100名）', i => staff.post('/api/bulk', { staffIds: ids, date: `2027-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, start: '10:00', end: '15:00', breakMin: '0' }), 10));
out.push(await measure('月別集計（全員・1か月）', () => admin.get('/api/admin/summary?month=2025-06')));
out.push(await measure('月別集計CSV（全員・全月）', () => admin.get('/api/admin/summary.csv?month=all'), 5));
out.push(await measure('自分の申請の結果', () => staff.get('/api/my/requests')));
out.push(await measure('出勤中のスタッフ一覧', () => admin.get('/api/admin/clocked-in')));
out.push(await measure('個人別勤怠申請書（1人・1か月）', () => admin.get('/api/admin/personal?staffId=S001&month=2025-06')));

console.log(`勤怠 ${N.toLocaleString()} 件・スタッフ ${STAFF} 名（ローカル模擬環境 / Node ${process.version}）`);
console.table(out);
const plan = await env.DB.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM attendance WHERE staff_id = 'S001' AND work_date >= '2025-06-01' AND work_date < '2025-07-01' ORDER BY row_order").all();
console.log('月別履歴の検索方法:', plan.map(p => p.detail).join(' / '));
