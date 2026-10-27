// パスワード・PINのハッシュ化とトークン生成（Web Crypto API のみ使用）

const enc = new TextEncoder();

export function uuid() {
  return crypto.randomUUID();
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** 長さに依存しない比較（タイミング攻撃対策） */
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Workers 無料プランの CPU 時間（1リクエスト10ms）に収まる回数。
// PIN は桁数が少ないため、守りの中心は「サーバー側の秘密値(PEPPER)」と「連続失敗でのロック」。
// 保存形式に回数を含めているので、将来回数を増やしても古いハッシュはそのまま検証できる。
export const PBKDF2_ITERATIONS = 20000;

async function pbkdf2(secret, salt, iterations, pepper) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${pepper}\u0000${secret}`), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

/** 保存形式: pbkdf2$回数$ソルト(hex)$ハッシュ(hex) */
export async function hashSecret(secret, pepper, iterations = PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const h = await pbkdf2(secret, salt, iterations, pepper);
  return `pbkdf2$${iterations}$${toHex(salt)}$${h}`;
}

export async function verifySecret(secret, stored, pepper) {
  if (!stored || typeof stored !== 'string') return false;
  const [alg, it, saltHex, hash] = stored.split('$');
  const iterations = Number(it);
  if (alg !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 1000 || !saltHex || !hash) return false;
  const h = await pbkdf2(secret, fromHex(saltHex), iterations, pepper);
  return safeEqual(h, hash);
}

/** 数字だけのPINを生成（管理者がスタッフへ配布する用） */
export function randomPin(digits = 6) {
  const a = new Uint32Array(digits);
  crypto.getRandomValues(a);
  return [...a].map(n => String(n % 10)).join('');
}
