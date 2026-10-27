// テスト用の道具（本番環境では無効）
// ・テスト用スタッフ（ID が TEST で始まる）とテスト用管理者を作り直す
// ・テスト用スタッフのデータだけを消す（他のスタッフのデータには触れない）
import { json, HttpError } from '../lib/http.js';
import { hashSecret } from '../lib/crypto.js';
import { pepper } from '../lib/auth.js';
import { nowIso, jstDate } from '../lib/time.js';

export const TEST_PIN = '1234';
export const TEST_ADMIN = { loginId: 'testadmin', password: 'test-password-1234' };
export const TEST_STAFF = [
  { id: 'TEST01', name: 'テスト 一郎', nick: 'いちろう', grade: '1' },
  { id: 'TEST02', name: 'テスト 二子', nick: 'ふたこ', grade: '1' },
  { id: 'TEST03', name: 'テスト 三太', nick: 'さんた', grade: '2' },
  { id: 'TEST04', name: 'テスト 四葉', nick: 'よつば', grade: '2' },
  { id: 'TEST05', name: 'テスト 五郎', nick: 'ごろう', grade: '3' },
];

export function testToolsEnabled(env) {
  return env.ENVIRONMENT !== 'production' && env.ALLOW_TEST_TOOLS === 'true';
}

export async function resetTestData(env, request) {
  if (!testToolsEnabled(env)) throw new HttpError(404, '見つかりません');
  const url = new URL(request.url);
  const withSamples = url.searchParams.get('samples') !== '0';
  const at = nowIso();
  const p = pepper(env);
  const pinHash = await hashSecret(TEST_PIN, p);
  const pwHash = await hashSecret(TEST_ADMIN.password, p);
  const T = "(SELECT id FROM staff WHERE id LIKE 'TEST%')";
  const stmts = [
    env.DB.prepare(`DELETE FROM correction_requests WHERE staff_id IN ${T}`),
    env.DB.prepare(`DELETE FROM clock_sessions WHERE staff_id IN ${T}`),
    env.DB.prepare(`DELETE FROM attendance WHERE staff_id IN ${T}`),
    env.DB.prepare(`DELETE FROM sessions WHERE kind = 'staff' AND subject_id IN ${T}`),
    env.DB.prepare(`DELETE FROM audit_log WHERE operator LIKE '%(TEST%' OR operator LIKE '%(testadmin)%'`),
  ];
  for (const s of TEST_STAFF) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO staff (id, name, nick, grade, active, pin_hash, pin_updated_at, failed_logins, locked_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, nick = excluded.nick, grade = excluded.grade, active = 1,
           pin_hash = excluded.pin_hash, failed_logins = 0, locked_until = NULL`
      ).bind(s.id, s.name, s.nick, s.grade, pinHash, at, at, at)
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO admins (id, login_id, name, password_hash, failed_logins, created_at) VALUES ('test-admin', ?, 'テスト管理者', ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, failed_logins = 0, locked_until = NULL`
    ).bind(TEST_ADMIN.loginId, pwHash, at)
  );
  if (withSamples) {
    // 先月と今月のサンプル勤怠（TEST01 / TEST02）
    const d = new Date();
    const thisMonth = jstDate(d).slice(0, 7);
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15));
    const prevMonth = jstDate(prev).slice(0, 7);
    const samples = [
      ['TEST01', `${prevMonth}-03`, '10:00', '15:00', 60, '受付', 4],
      ['TEST01', `${prevMonth}-10`, '13:00', '17:30', 0, '準備・片付け', 4.5],
      ['TEST01', `${thisMonth}-02`, '22:00', '02:00', 30, '夜間イベント（翌日退勤）', 3.5],
      ['TEST02', `${thisMonth}-01`, '09:00', '12:00', 0, '資料作成', 3],
    ];
    samples.forEach(([sid, date, s, e, br, task, h], i) => {
      const name = TEST_STAFF.find(x => x.id === sid).name;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO attendance (id, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance, hours, method, row_order, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', (SELECT COALESCE(MAX(row_order), 0) + 1 FROM attendance), 'app', ?, ?)`
        ).bind(`TEST-SAMPLE-${i + 1}`, sid, name, date, s, e, br, task, i === 1 ? 500 : null, h, at, at)
      );
    });
  }
  await env.DB.batch(stmts);
  return json({
    ok: true,
    staff: TEST_STAFF.map(s => s.id),
    pin: TEST_PIN,
    admin: TEST_ADMIN.loginId,
    message: 'テスト用スタッフ（TEST01〜TEST05）のデータを初期化しました。他のスタッフのデータは変更していません。',
  });
}

/**
 * サーバーの中で動作確認テスト（selftest.html と同じ手順）を実行して結果を返す。
 * ブラウザを使わずに、公開した環境が正しく動くかを確かめるため。
 */
export async function selfCheck(env, request, handleApi) {
  if (!testToolsEnabled(env)) throw new HttpError(404, '見つかりません');
  const { runSteps } = await import('../../public/js/selftest-steps.js');
  const origin = new URL(request.url).origin;
  const cookies = new Map();
  const fetchImpl = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('Origin', origin);
    if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await handleApi(new Request(origin + path, { method: init.method || 'GET', headers, body: init.body }), env);
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) cookies.delete(kv.slice(0, i));
      else cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const started = Date.now();
  const results = await runSteps(fetchImpl);
  const pass = results.filter(r => r.ok).length;
  return json({ pass, fail: results.length - pass, totalMs: Date.now() - started, results });
}
