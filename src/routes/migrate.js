// データ移行（スプレッドシート → D1）
// ・元データ（スプレッドシート）には一切書き込まない。書き出したJSON/CSVを読むだけ。
// ・スタッフIDと記録IDはそのまま維持する。
// ・同じIDが既にあれば「一致ならスキップ」「内容が違えば上書きせず報告」。何度実行しても安全。
// ・dry-run（確認のみ）→ import（取り込み）→ verify（照合）の3段階。
import { json, readJson, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { checkDate, checkTime, minutesBetween, ALLOWANCE_MAX } from '../lib/validate.js';
import { jstDate, jstTime, nowIso } from '../lib/time.js';
import { sha256Hex, uuid } from '../lib/crypto.js';
import { adminLabel } from '../lib/audit.js';

const MAX_ROWS = 500;
const MODES = ['dry-run', 'import', 'verify'];
const TABLES = ['staff', 'attendance', 'corrections', 'audit'];

const str = v => (v == null ? '' : String(v)).trim();
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function normDate(v) {
  const s = str(v);
  if (ISO_DT.test(s)) return jstDate(new Date(s));
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:$|[\sT])/);
  if (!m) throw new Error('日付の形式が不正です: ' + s);
  return checkDateSoft(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
}
function checkDateSoft(s) {
  try {
    return checkDate(s);
  } catch {
    throw new Error('存在しない日付です: ' + s);
  }
}
export function normTime(v) {
  const s = str(v);
  if (ISO_DT.test(s)) return jstTime(new Date(s));
  const m = s.match(/^(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+)?(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) throw new Error('時刻の形式が不正です: ' + s);
  const t = `${m[1].padStart(2, '0')}:${m[2]}`;
  try {
    return checkTime(t);
  } catch {
    throw new Error('時刻が不正です: ' + s);
  }
}
function normNumber(v, label) {
  const s = str(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${label}が数値ではありません: ${s}`);
  return n;
}
function normDateTime(v) {
  const s = str(v);
  if (!s) return '';
  if (ISO_DT.test(s)) return new Date(s).toISOString();
  // "2026/10/27 13:05:00" のような日本時間の表示形式
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m.map(Number);
    return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, se || 0)).toISOString();
  }
  const m2 = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m2) return new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3], -9)).toISOString();
  return s; // 解釈できない場合は元の文字列のまま保存（報告対象）
}
const round2 = n => Math.round(n * 100) / 100;

// ---------- 行の変換（旧シートの列名 → DBの項目） ----------
function convStaff(r) {
  const id = str(r['スタッフID']);
  const name = str(r['氏名']);
  if (!id) throw new Error('スタッフIDが空です');
  if (!name) throw new Error('氏名が空です');
  return {
    id,
    name,
    nick: str(r['ニックネーム']),
    grade: str(r['学年']),
    active: str(r['有効']).toLowerCase() === 'true' ? 1 : 0,
  };
}

function convAttendance(r, warnings) {
  const id = str(r['記録ID']);
  if (!id) throw new Error('記録IDが空です');
  const staffId = str(r['スタッフID']);
  if (!staffId) throw new Error('スタッフIDが空です');
  const date = normDate(r['勤務日']);
  const start = normTime(r['出勤']);
  const end = normTime(r['退勤']);
  const br = normNumber(r['休憩(分)'], '休憩') ?? 0;
  if (!Number.isInteger(br) || br < 0 || br >= 1440) throw new Error('休憩時間が範囲外です: ' + br);
  const allowance = normNumber(r['手当(円)'], '手当');
  if (allowance != null && (allowance < 0 || allowance > ALLOWANCE_MAX)) throw new Error('手当が範囲外です: ' + allowance);
  const hours = normNumber(r['勤務時間(時間)'], '勤務時間');
  if (hours == null) throw new Error('勤務時間が空です');
  const calc = round2((minutesBetween(start, end) - br) / 60);
  if (Math.abs(calc - hours) > 0.005) warnings.push(`勤務時間が再計算値と違います（記録 ${hours} / 計算 ${calc}）。記録の値で取り込みます`);
  const task = str(r['業務内容']);
  if (task.length > 200) warnings.push('業務内容が200文字を超えています（そのまま取り込みます）');
  const updated = normDateTime(r['更新日時']) || nowIso();
  return {
    id,
    staff_id: staffId,
    staff_name: str(r['氏名']),
    work_date: date,
    start_time: start,
    end_time: end,
    break_min: br,
    task,
    allowance,
    hours,
    method: str(r['登録方法']) || 'manual',
    row_order: Number(r._row) || 0,
    created_at: updated,
    updated_at: updated,
  };
}

function convCorrection(r) {
  const id = str(r['申請ID']);
  if (!id) throw new Error('申請IDが空です');
  const recordId = str(r['記録ID']);
  if (!recordId) throw new Error('記録IDが空です');
  return {
    id,
    requested_at: normDateTime(r['申請日時']) || nowIso(),
    staff_id: str(r['スタッフID']),
    staff_name: str(r['氏名']),
    record_id: recordId,
    before_json: str(r['変更前(JSON)']),
    after_json: str(r['変更後(JSON)']),
    reason: str(r['修正理由']),
    status: str(r['状態']) || '申請中',
    processed_at: normDateTime(r['処理日時']) || null,
    processed_by: str(r['処理者']) || null,
    admin_memo: str(r['管理者メモ']),
    kind: str(r['種類']) === '削除' ? '削除' : '修正',
  };
}

async function convAudit(r) {
  const row = {
    at: normDateTime(r['日時']) || '',
    action: str(r['操作']),
    record_id: str(r['記録ID']),
    operator: str(r['操作者']),
    before_json: str(r['変更前(JSON)']),
    after_json: str(r['変更後(JSON)']),
  };
  if (!row.at && !row.action) throw new Error('日時と操作が空です');
  row.legacy_key = str(r._key) || 'gas:' + (Number(r._row) || 0) + ':' + (await sha256Hex(JSON.stringify(row))).slice(0, 32);
  return row;
}

// ---------- テーブルごとの設定 ----------
const SPEC = {
  staff: {
    table: 'staff',
    key: 'id',
    cols: ['id', 'name', 'nick', 'grade', 'active'],
    compare: ['name', 'nick', 'grade', 'active'],
    extraInsert: { created_at: 'NOW', updated_at: 'NOW' },
  },
  attendance: {
    table: 'attendance',
    key: 'id',
    cols: ['id', 'staff_id', 'staff_name', 'work_date', 'start_time', 'end_time', 'break_min', 'task', 'allowance', 'hours', 'method', 'row_order', 'created_at', 'updated_at'],
    compare: ['staff_id', 'staff_name', 'work_date', 'start_time', 'end_time', 'break_min', 'task', 'allowance', 'hours', 'method'],
    extraInsert: { source: "'migration'" },
  },
  corrections: {
    table: 'correction_requests',
    key: 'id',
    cols: ['id', 'requested_at', 'staff_id', 'staff_name', 'record_id', 'before_json', 'after_json', 'reason', 'status', 'processed_at', 'processed_by', 'admin_memo', 'kind'],
    compare: ['record_id', 'staff_id', 'before_json', 'after_json', 'reason', 'status', 'admin_memo', 'kind'],
    extraInsert: { source: "'migration'" },
  },
  audit: {
    table: 'audit_log',
    key: 'legacy_key',
    cols: ['legacy_key', 'at', 'action', 'record_id', 'operator', 'before_json', 'after_json'],
    compare: ['action', 'record_id', 'operator', 'before_json', 'after_json'],
    extraInsert: {},
  },
};

function same(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 1e-9 && a != null && b != null;
  return String(a ?? '') === String(b ?? '');
}

export async function migrateChunk(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const mode = String(body.mode || '');
  const table = String(body.table || '');
  if (!MODES.includes(mode)) throw new HttpError(400, 'mode が不正です');
  if (!TABLES.includes(table)) throw new HttpError(400, 'table が不正です');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'rows がありません');
  if (body.rows.length > MAX_ROWS) throw new HttpError(400, `1回に送れるのは${MAX_ROWS}行までです`);
  const spec = SPEC[table];

  const issues = []; // { row, id, level: 'error'|'warning'|'conflict'|'missing', message }
  const valid = [];
  const seen = new Set();
  for (const raw of body.rows) {
    const rowNo = Number(raw && raw._row) || null;
    const warnings = [];
    try {
      if (!raw || typeof raw !== 'object') throw new Error('行の形式が不正です');
      let v;
      if (table === 'staff') v = convStaff(raw);
      else if (table === 'attendance') v = convAttendance(raw, warnings);
      else if (table === 'corrections') v = convCorrection(raw);
      else v = await convAudit(raw);
      const k = v[spec.key];
      if (seen.has(k)) throw new Error('同じIDが移行元に複数あります: ' + k);
      seen.add(k);
      for (const w of warnings) issues.push({ row: rowNo, id: k, level: 'warning', message: w });
      valid.push(v);
    } catch (e) {
      issues.push({ row: rowNo, id: raw ? str(raw['記録ID'] || raw['スタッフID'] || raw['申請ID']) : '', level: 'error', message: e.message });
    }
  }

  // 勤怠記録：スタッフが存在するか（別スタッフの記録と混ざらないよう、名簿にないIDは取り込まない）
  if (table === 'attendance' && valid.length) {
    const ids = [...new Set(valid.map(v => v.staff_id))];
    const { results } = await env.DB.prepare('SELECT id, name FROM staff WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all();
    const known = new Map(results.map(r => [String(r.id), r.name]));
    // 確認のみ（dry-run）では、同じファイルのスタッフ名簿に載っている人も「取り込み後に存在する」とみなす
    if (mode === 'dry-run' && Array.isArray(body.plannedStaff)) {
      for (const s of body.plannedStaff) if (s && s.id && !known.has(String(s.id))) known.set(String(s.id), String(s.name || ''));
    }
    for (let i = valid.length - 1; i >= 0; i--) {
      const v = valid[i];
      if (!known.has(v.staff_id)) {
        issues.push({ row: v.row_order, id: v.id, level: 'error', message: `スタッフID ${v.staff_id} が名簿にありません（先にスタッフ名簿を移行してください）` });
        valid.splice(i, 1);
      } else if (!v.staff_name) {
        v.staff_name = known.get(v.staff_id);
      }
    }
  }

  // 既存データとの比較
  const keys = valid.map(v => v[spec.key]);
  const existing = new Map();
  if (keys.length) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
    for (const r of results) existing.set(String(r[spec.key]), r);
  }
  const toInsert = [];
  let identical = 0;
  let conflicts = 0;
  for (const v of valid) {
    const ex = existing.get(String(v[spec.key]));
    if (!ex) {
      toInsert.push(v);
      continue;
    }
    const diff = spec.compare.filter(c => !same(v[c], ex[c]));
    if (!diff.length) identical++;
    else {
      conflicts++;
      issues.push({
        row: v.row_order || null,
        id: v[spec.key],
        level: 'conflict',
        message: '移行先に同じIDで内容の違うデータがあります（上書きしません）: ' + diff.map(c => `${c}: 移行元=${JSON.stringify(v[c])} / 移行先=${JSON.stringify(ex[c])}`).join('、'),
      });
    }
  }

  let inserted = 0;
  let missing = 0;
  if (mode === 'verify') {
    missing = toInsert.length;
    for (const v of toInsert) issues.push({ row: v.row_order || null, id: v[spec.key], level: 'missing', message: '移行先にありません' });
  } else if (mode === 'import' && toInsert.length) {
    const at = nowIso();
    const extra = Object.entries(spec.extraInsert);
    const colsSql = [...spec.cols, ...extra.map(([c]) => c)].join(', ');
    const valsSql = [
      ...spec.cols.map(c => `json_extract(j.value, '$.${c}')`),
      ...extra.map(([, e]) => (e === 'NOW' ? '?2' : e)),
    ].join(', ');
    const usesNow = extra.some(([, e]) => e === 'NOW');
    const stmt = env.DB.prepare(
      `INSERT INTO ${spec.table} (${colsSql}) SELECT ${valsSql} FROM json_each(?1) AS j WHERE 1 ON CONFLICT DO NOTHING RETURNING ${spec.key} AS k`
    );
    const { results } = await (usesNow ? stmt.bind(JSON.stringify(toInsert), at) : stmt.bind(JSON.stringify(toInsert))).all();
    inserted = results.length;
    const done = new Set(results.map(r => String(r.k)));
    for (const v of toInsert) {
      if (!done.has(String(v[spec.key]))) {
        issues.push({
          row: v.row_order || null,
          id: v[spec.key],
          level: 'conflict',
          message: table === 'corrections' ? '同じ記録に「申請中」の申請が既にあるため取り込めませんでした' : '取り込めませんでした（重複）',
        });
        conflicts++;
      }
    }
  }

  return json({
    table,
    mode,
    operator: adminLabel(admin),
    counts: {
      source: body.rows.length,
      valid: valid.length,
      errors: issues.filter(i => i.level === 'error').length,
      warnings: issues.filter(i => i.level === 'warning').length,
      newRows: mode === 'verify' ? 0 : toInsert.length,
      inserted,
      identical,
      conflicts,
      missing,
    },
    issues: issues.slice(0, 1000),
  });
}

/** 移行結果の記録（管理画面がまとめた結果 ＋ サーバーで数えた件数） */
export async function saveReport(env, request) {
  const admin = await requireAdmin(env, request);
  const body = await readJson(request);
  const mode = MODES.includes(body.mode) ? body.mode : 'import';
  const [s, a, c, l] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM staff'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM attendance'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM correction_requests'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE legacy_key IS NOT NULL'),
  ]);
  const dbCounts = { staff: s.results[0].n, attendance: a.results[0].n, corrections: c.results[0].n, auditMigrated: l.results[0].n };
  const report = { ...(body.report && typeof body.report === 'object' ? body.report : {}), dbCounts };
  const text = JSON.stringify(report);
  if (text.length > 500000) throw new HttpError(413, '報告が大きすぎます');
  const id = uuid();
  await env.DB.prepare('INSERT INTO migration_runs (id, at, operator, mode, report_json) VALUES (?, ?, ?, ?, ?)')
    .bind(id, nowIso(), adminLabel(admin), mode, text)
    .run();
  return json({ ok: true, id, dbCounts });
}

export async function listReports(env, request) {
  await requireAdmin(env, request);
  const { results } = await env.DB.prepare('SELECT id, at, operator, mode, report_json FROM migration_runs ORDER BY at DESC LIMIT 20').all();
  return json({ runs: results.map(r => ({ id: r.id, at: r.at, operator: r.operator, mode: r.mode, report: JSON.parse(r.report_json) })) });
}
