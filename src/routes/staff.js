// スタッフ一覧・ログイン・ログアウト
import { json, readJson } from '../lib/http.js';
import { staffLogin, destroySession, clearCookie, STAFF_COOKIE, requireStaff } from '../lib/auth.js';

/** 旧 listStaff()：有効なスタッフのみ。PINなどの情報は返さない。 */
export async function listStaff(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, nick, grade FROM staff WHERE active = 1 AND id <> '' AND name <> '' ORDER BY rowid"
  ).all();
  return json(results.map(r => ({ id: String(r.id), name: r.name, nick: r.nick, grade: String(r.grade) })));
}

export async function login(env, request) {
  const body = await readJson(request);
  const { user, cookie } = await staffLogin(env, body.staffId, body.pin);
  return json({ ok: true, user }, 200, { 'Set-Cookie': cookie });
}

export async function logout(env, request) {
  await destroySession(env, request, 'staff');
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(STAFF_COOKIE) });
}

export async function me(env, request) {
  const u = await requireStaff(env, request);
  return json({ user: u });
}
