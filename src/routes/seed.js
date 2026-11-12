// 初期名簿の登録：設定 STAFF_SEED_JSON（名簿の JSON）があり、スタッフが1人もいないときだけ登録する。
// 名簿（個人名）をソースコードに書かずに、本番環境へ最初の名簿を入れるための仕組み。
// 一度登録されると（スタッフが1人でもいれば）何もしない。
import { nowIso } from '../lib/time.js';

export async function applyStaffSeed(env) {
  const raw = env.STAFF_SEED_JSON;
  if (!raw) return 0;
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM staff').first('n');
  if (Number(n) > 0) return 0;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error('npas: STAFF_SEED_JSON を読み取れません');
    return 0;
  }
  const rows = (Array.isArray(list) ? list : [])
    .map(s => ({
      id: String(s.id || '').trim(),
      name: String(s.name || '').trim(),
      nick: String(s.nick || '').trim(),
      grade: String(s.grade ?? '').replace(/\.0+$/, '').trim(),
      active: s.active === false || String(s.active).toLowerCase() === 'false' ? 0 : 1,
    }))
    .filter(s => s.id && s.name);
  if (!rows.length) return 0;
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO staff (id, name, nick, grade, active, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.nick'),
              json_extract(value, '$.grade'), json_extract(value, '$.active'), ?1, ?1
         FROM json_each(?2) WHERE 1 ON CONFLICT DO NOTHING`
    ).bind(at, JSON.stringify(rows)),
    env.DB.prepare(
      "INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, '初期名簿の登録', '', 'システム（STAFF_SEED_JSON）', '', ?)"
    ).bind(at, JSON.stringify({ count: rows.length, ids: rows.map(r => r.id) })),
  ]);
  return rows.length;
}

/**
 * 名簿の追加（STAFF_ADD_JSON）：まだ登録されていないスタッフIDだけを追加する。
 * - すでにあるIDは一切変更しない（管理画面で直した名前・学年・無効化はそのまま）
 * - 追加するものがなければ何も書き込まない（毎回の読み込みで保存が起きない）
 * - 追加した内容は操作履歴に残す
 */
export async function applyStaffAdditions(env) {
  const raw = env.STAFF_ADD_JSON;
  if (!raw) return 0;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error('npas: STAFF_ADD_JSON を読み取れません');
    return 0;
  }
  const rows = (Array.isArray(list) ? list : [])
    .map(s => ({
      id: String(s.id || '').trim(),
      name: String(s.name || '').trim(),
      nick: String(s.nick || '').trim(),
      grade: String(s.grade ?? '').replace(/\.0+$/, '').trim(),
      active: 1,
    }))
    .filter(s => s.id && s.name && /^[1-9]$/.test(s.grade));
  if (!rows.length) return 0;
  const { results } = await env.DB.prepare('SELECT id FROM staff WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(rows.map(r => r.id)))
    .all();
  const have = new Set((results || []).map(r => String(r.id)));
  const add = rows.filter(r => !have.has(r.id));
  if (!add.length) return 0;
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO staff (id, name, nick, grade, active, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.nick'),
              json_extract(value, '$.grade'), 1, ?1, ?1
         FROM json_each(?2) WHERE 1 ON CONFLICT DO NOTHING`
    ).bind(at, JSON.stringify(add)),
    env.DB.prepare(
      "INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, '名簿の追加', '', 'システム（STAFF_ADD_JSON）', '', ?)"
    ).bind(at, JSON.stringify({ count: add.length, staff: add.map(r => `${r.id} ${r.grade}年 ${r.nick || r.name}`) })),
  ]);
  return add.length;
}
