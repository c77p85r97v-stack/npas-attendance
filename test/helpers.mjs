// テスト用の共通処理：ブラウザの代わりに API を呼び、Cookie を保持する
import { handleApi } from '../src/index.js';
import { createTestEnv } from '../tools/d1-node.mjs';
import { hashSecret } from '../src/lib/crypto.js';

export const ORIGIN = 'https://npas.example.test';

export class Client {
  constructor(env) {
    this.env = env;
    this.cookies = new Map();
  }
  async req(method, path, body, headers = {}) {
    const h = new Headers({ 'X-Requested-With': 'npas', Origin: ORIGIN, ...headers });
    if (this.cookies.size) h.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (body !== undefined) h.set('Content-Type', 'application/json');
    const res = await handleApi(
      new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      this.env
    );
    const sc = res.headers.get('Set-Cookie');
    if (sc) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/Max-Age=0/.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const ct = res.headers.get('Content-Type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, h) {
    return this.req('GET', p, undefined, h);
  }
  post(p, b = {}, h) {
    return this.req('POST', p, b, h);
  }
}

export const PIN = '2468';

/** スタッフを何人か登録した環境を作る */
export async function setup({ staff = defaultStaff(), clock, extra } = {}) {
  const env = createTestEnv(extra);
  if (clock) env.__clock = clock;
  const at = new Date().toISOString();
  const h = await hashSecret(PIN, env.PIN_PEPPER);
  for (const s of staff) {
    await env.DB.prepare(
      'INSERT INTO staff (id, name, nick, grade, active, pin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(s.id, s.name, s.nick || '', String(s.grade), s.active === false ? 0 : 1, s.noPin ? null : h, at, at)
      .run();
  }
  const pw = await hashSecret('admin-password-123', env.PIN_PEPPER);
  await env.DB.prepare("INSERT INTO admins (id, login_id, name, password_hash, created_at) VALUES ('a1', 'admin', '管理 太郎', ?, ?)")
    .bind(pw, at)
    .run();
  return env;
}

export function defaultStaff() {
  return [
    { id: 'S001', name: '青空 みなみ', nick: 'みなみん', grade: 2 },
    { id: 'S002', name: '山田 晴人', nick: 'はるっち', grade: 2 },
    { id: 'S003', name: '川上 真一', nick: 'かわしん', grade: 1 },
    { id: 'S004', name: '退職 済子', nick: '', grade: 1, active: false },
    { id: 'S005', name: '未設定 PIN', nick: '', grade: 1, noPin: true },
  ];
}

export async function loginAs(env, id, pin = PIN) {
  const c = new Client(env);
  const r = await c.post('/api/login', { staffId: id, pin });
  if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.data));
  return c;
}

export async function adminClient(env) {
  const c = new Client(env);
  const r = await c.post('/api/admin/login', { loginId: 'admin', password: 'admin-password-123' });
  if (r.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(r.data));
  return c;
}

/** 日本時間の日時を Date にする */
export function jst(y, mo, d, h = 0, mi = 0, s = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s));
}

export function base(over = {}) {
  return { date: '2026-10-05', start: '10:00', end: '15:00', breakMin: '0', task: '受付', allowance: '', ...over };
}
