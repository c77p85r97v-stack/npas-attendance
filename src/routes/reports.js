// 月別勤怠集計・個人別勤怠申請書・バックアップ用の書き出し（管理者のみ）
import { json, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { checkMonth, monthRange } from '../lib/validate.js';
import { jstMonth, nowIso } from '../lib/time.js';
import { fetchMonthEntries, rowToEntry } from './attendance.js';

const collator = new Intl.Collator('ja');

/** 旧 updateNPASMonthlySummary と同じ並び順：学年の大きい順 → 氏名順 */
function sortStaff(list) {
  return [...list].sort((a, b) => Number(b.grade) - Number(a.grade) || collator.compare(a.name, b.name));
}

async function activeStaff(env) {
  const { results } = await env.DB.prepare('SELECT id, name, nick, grade FROM staff WHERE active = 1').all();
  return sortStaff(results.map(r => ({ id: String(r.id), name: r.name, nick: r.nick, grade: String(r.grade) })));
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * 月別集計。集計表をあらかじめ保存せず、元の勤怠記録から毎回計算する。
 * （インデックスで対象月だけを読むので速く、保存処理と集計処理が独立する）
 * 勤務実績がないスタッフも 0 で表示する（旧仕様と同じ）。
 */
export async function computeSummary(env, months) {
  const staff = await activeStaff(env);
  const rows = [];
  if (!months.length) return rows;
  const sorted = [...months].sort();
  const from = monthRange(sorted[0])[0];
  const to = monthRange(sorted[sorted.length - 1])[1];
  // 対象期間を1回の問い合わせで「月×スタッフ」ごとに集計する
  const { results } = await env.DB.prepare(
    `SELECT substr(work_date, 1, 7) AS month, staff_id, COUNT(DISTINCT work_date) AS days, SUM(hours) AS hours,
            SUM(break_min) AS break_min, SUM(COALESCE(allowance, 0)) AS allowance
       FROM attendance WHERE work_date >= ? AND work_date < ? GROUP BY month, staff_id`
  )
    .bind(from, to)
    .all();
  const t = new Map(results.map(r => [`${r.month}|${r.staff_id}`, r]));
  for (const month of months) {
    for (const s of staff) {
      const x = t.get(`${month}|${s.id}`);
      rows.push({
        month,
        staffId: s.id,
        name: s.name,
        nick: s.nick,
        grade: s.grade,
        days: x ? Number(x.days) : 0,
        hours: x ? round2(Number(x.hours) || 0) : 0,
        breakMin: x ? Number(x.break_min) || 0 : 0,
        allowance: x ? Number(x.allowance) || 0 : 0,
      });
    }
  }
  return rows;
}

async function allMonths(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT substr(work_date, 1, 7) AS m FROM attendance ORDER BY m DESC"
  ).all();
  const set = new Set(results.map(r => r.m));
  set.add(jstMonth());
  return [...set].sort().reverse();
}

export async function summary(env, request) {
  await requireAdmin(env, request);
  const month = checkMonth(new URL(request.url).searchParams.get('month') || jstMonth());
  return json({ month, rows: await computeSummary(env, [month]) });
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // 表計算ソフトで数式として実行されないようにする（CSVインジェクション対策）
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(headers, rows) {
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function summaryCsv(env, request) {
  await requireAdmin(env, request);
  const p = new URL(request.url).searchParams.get('month') || 'all';
  const months = p === 'all' ? await allMonths(env) : [checkMonth(p)];
  const rows = await computeSummary(env, months);
  const headers = ['対象月', 'スタッフID', '氏名', 'ニックネーム', '学年', '勤務日数', '合計勤務時間(時間)', '合計休憩(分)', '合計手当(円)'];
  const body = toCsv(
    headers,
    rows.map(r => [r.month, r.staffId, r.name, r.nick, r.grade, r.days, r.hours.toFixed(2), r.breakMin, r.allowance])
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="npas-monthly-summary-${p}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 1人・1か月分の日別表を組み立てる */
function buildPersonal(s, month, entries) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= last; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const list = entries.filter(e => e.date === date);
    days.push({
      day: d,
      weekday: WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
      tasks: list.map(e => e.task).filter(Boolean),
      starts: list.map(e => e.start),
      ends: list.map(e => e.end),
      breakMin: list.reduce((a, e) => a + e.breakMin, 0),
      hours: round2(list.reduce((a, e) => a + e.hours, 0)),
      allowance: list.reduce((a, e) => a + (Number(e.allowance) || 0), 0),
      records: list,
    });
  }
  return {
    staff: { id: String(s.id), name: s.name, nick: s.nick, grade: String(s.grade), active: !!s.active },
    month,
    days,
    totals: {
      hours: round2(entries.reduce((a, e) => a + e.hours, 0)),
      allowance: entries.reduce((a, e) => a + (Number(e.allowance) || 0), 0),
    },
  };
}

/** 個人別勤怠申請書（旧 個人_ シート）：1人・1か月分の日別表 */
export async function personal(env, request) {
  await requireAdmin(env, request);
  const url = new URL(request.url);
  const month = checkMonth(url.searchParams.get('month') || jstMonth());
  const staffId = String(url.searchParams.get('staffId') || '');
  const s = await env.DB.prepare('SELECT id, name, nick, grade, active FROM staff WHERE id = ?').bind(staffId).first();
  if (!s) throw new HttpError(404, 'スタッフが見つかりません');
  const entries = await fetchMonthEntries(env, s.id, month);
  return json(buildPersonal(s, month, entries));
}

/**
 * 個人別勤怠申請書をまとめて取得（学年ごと、または全員）。印刷用。
 * 有効なスタッフを、旧集計と同じ並び（学年の大きい順 → 氏名順）で返す。問い合わせは2回だけ。
 */
export async function personalBatch(env, request) {
  await requireAdmin(env, request);
  const url = new URL(request.url);
  const month = checkMonth(url.searchParams.get('month') || jstMonth());
  const grade = String(url.searchParams.get('grade') || 'all');
  const all = (await env.DB.prepare('SELECT id, name, nick, grade, active FROM staff WHERE active = 1').all()).results;
  const staff = sortStaff(all.map(r => ({ ...r, id: String(r.id), grade: String(r.grade) }))).filter(r => grade === 'all' || r.grade === grade);
  if (!staff.length) return json({ month, grade, sheets: [] });
  const [from, to] = monthRange(month);
  const { results } = await env.DB.prepare(
    `SELECT staff_id, id, work_date, start_time, end_time, break_min, task, allowance, hours, method
       FROM attendance
      WHERE staff_id IN (SELECT value FROM json_each(?)) AND work_date >= ? AND work_date < ?
      ORDER BY row_order`
  )
    .bind(JSON.stringify(staff.map(s => s.id)), from, to)
    .all();
  const by = new Map(staff.map(s => [s.id, []]));
  for (const r of results) by.get(String(r.staff_id))?.push(rowToEntry(r));
  return json({ month, grade, sheets: staff.map(s => buildPersonal(s, month, by.get(s.id))) });
}

/**
 * バックアップ用の書き出し。移行ツールと同じ形式（旧シートの列名）なので、
 * 管理画面の「データ移行」からそのまま復元できる。PINのハッシュとログイン情報は含めない。
 */
const EXPORT_SQL = {
  スタッフ名簿: 'SELECT id, name, nick, grade, active FROM staff ORDER BY rowid',
  勤怠データ: 'SELECT * FROM attendance ORDER BY row_order, id',
  修正履歴: 'SELECT * FROM audit_log ORDER BY id',
  打刻修正申請: 'SELECT * FROM correction_requests ORDER BY requested_at, id',
};

/**
 * バックアップの分割取得（データが多くても1回の処理が重くならないよう、表ごとに少しずつ取得する）。
 * 管理画面が全部を取得して1つのファイルにまとめる。
 */
export async function exportPage(env, request) {
  await requireAdmin(env, request);
  const url = new URL(request.url);
  const sheet = url.searchParams.get('sheet');
  if (!EXPORT_SQL[sheet]) throw new HttpError(400, 'sheet が不正です');
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1000, 1), 2000);
  const { results } = await env.DB.prepare(`${EXPORT_SQL[sheet]} LIMIT ? OFFSET ?`).bind(limit + 1, offset).all();
  const more = results.length > limit;
  const rows = convertExport(sheet, results.slice(0, limit), offset);
  return json({ sheet, offset, rows, more, exportedAt: nowIso() });
}

function convertExport(sheet, results, offset = 0) {
  if (sheet === 'スタッフ名簿') {
    return results.map((r, i) => ({
      _row: offset + i + 2,
      スタッフID: r.id,
      氏名: r.name,
      ニックネーム: r.nick,
      学年: r.grade,
      有効: r.active ? 'TRUE' : 'FALSE',
    }));
  }
  if (sheet === '勤怠データ') {
    return results.map(r => ({
      _row: r.row_order,
      記録ID: r.id,
      スタッフID: r.staff_id,
      氏名: r.staff_name,
      勤務日: r.work_date,
      出勤: r.start_time,
      退勤: r.end_time,
      '休憩(分)': r.break_min,
      業務内容: r.task,
      '手当(円)': r.allowance == null ? '' : r.allowance,
      '勤務時間(時間)': r.hours,
      登録方法: r.method,
      更新日時: r.updated_at,
    }));
  }
  if (sheet === '修正履歴') {
    return results.map(r => ({
      _row: r.id,
      _key: r.legacy_key || `d1:${r.id}`,
      日時: r.at,
      操作: r.action,
      記録ID: r.record_id,
      操作者: r.operator,
      '変更前(JSON)': r.before_json,
      '変更後(JSON)': r.after_json,
    }));
  }
  return results.map((r, i) => ({
    _row: offset + i + 2,
    申請ID: r.id,
    申請日時: r.requested_at,
    スタッフID: r.staff_id,
    氏名: r.staff_name,
    記録ID: r.record_id,
    '変更前(JSON)': r.before_json,
    '変更後(JSON)': r.after_json,
    修正理由: r.reason,
    状態: r.status,
    処理日時: r.processed_at || '',
    処理者: r.processed_by || '',
    管理者メモ: r.admin_memo || '',
    種類: r.kind || '修正',
  }));
}

/** 一括での書き出し（データが少ないとき用。管理画面は exportPage を使う） */
export async function exportAll(env, request) {
  await requireAdmin(env, request);
  const names = Object.keys(EXPORT_SQL);
  const res = await env.DB.batch(names.map(n => env.DB.prepare(EXPORT_SQL[n])));
  const sheets = {};
  names.forEach((n, i) => (sheets[n] = convertExport(n, res[i].results)));
  const data = { format: 'npas-d1-backup', version: 1, exportedAt: nowIso(), timezone: 'Asia/Tokyo', sheets };
  const stamp = nowIso().replace(/[-:]/g, '').slice(0, 15);
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="npas-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
