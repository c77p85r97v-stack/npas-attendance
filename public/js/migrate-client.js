// データ移行の画面側の処理（管理画面とテストの両方で使う）
// ファイルを読み込み → 表ごとに500行ずつサーバーへ送る → 結果をまとめる

export const TABLES = [
  ['staff', 'スタッフ名簿'],
  ['attendance', '勤怠データ'],
  ['corrections', '打刻修正申請'],
  ['audit', '修正履歴'],
];
const CHUNK = 200; // 1回の処理を軽くする（Workers無料プランのCPU時間制限に配慮）

/** CSV（Googleスプレッドシートの「ダウンロード → CSV」）を行オブジェクトにする */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].every(c => c.trim() === '')) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, c) => {
      if (h) o[h] = rows[i][c] ?? '';
    });
    out.push(o);
  }
  return out;
}

/** CSVの見出しからどのシートかを判定 */
export function detectSheet(rows) {
  const h = rows.length ? Object.keys(rows[0]) : [];
  if (h.includes('申請ID')) return '打刻修正申請';
  if (h.includes('記録ID') && h.includes('勤務日')) return '勤怠データ';
  if (h.includes('操作') && h.includes('日時')) return '修正履歴';
  if (h.includes('スタッフID') && h.includes('有効')) return 'スタッフ名簿';
  return null;
}

/** 書き出しJSON（GAS版 or バックアップ）を読み込む */
export function parseExportJson(text) {
  const data = JSON.parse(text);
  if (!data || !['npas-gas-export', 'npas-d1-backup'].includes(data.format) || !data.sheets) {
    throw new Error('N-PAS の書き出しファイルではありません');
  }
  return data.sheets;
}

function plannedStaff(sheets) {
  const rows = Array.isArray(sheets['スタッフ名簿']) ? sheets['スタッフ名簿'] : [];
  return rows.map(r => ({ id: String(r['スタッフID'] ?? '').trim(), name: String(r['氏名'] ?? '').trim() })).filter(r => r.id && r.name);
}

/**
 * 移行を実行する。post(path, body) はサーバーへの送信関数。
 * mode: 'dry-run'（確認のみ）/ 'import'（取り込み）/ 'verify'（照合）
 */
export async function runMigration(post, sheets, mode, onProgress = () => {}) {
  const report = { mode, startedAt: new Date().toISOString(), tables: {} };
  for (const [table, sheet] of TABLES) {
    const rows = Array.isArray(sheets[sheet]) ? sheets[sheet] : [];
    const t = { sheet, source: rows.length, valid: 0, errors: 0, warnings: 0, newRows: 0, inserted: 0, identical: 0, conflicts: 0, missing: 0, issues: [] };
    for (let i = 0; i < rows.length; i += CHUNK) {
      onProgress(`${sheet}：${Math.min(i + CHUNK, rows.length)} / ${rows.length} 行`);
      const body = { mode, table, rows: rows.slice(i, i + CHUNK) };
      if (mode === 'dry-run' && table === 'attendance') body.plannedStaff = plannedStaff(sheets);
      const r = await post('/api/admin/migrate', body);
      for (const k of ['valid', 'errors', 'warnings', 'newRows', 'inserted', 'identical', 'conflicts', 'missing']) t[k] += r.counts[k];
      if (t.issues.length < 2000) t.issues.push(...r.issues);
    }
    // 件数の照合：移行元の件数 ＝ 正常な行 ＋ エラーの行
    t.countCheck = t.valid + t.errors === t.source;
    if (mode === 'import') t.complete = t.errors === 0 && t.conflicts === 0 && t.inserted + t.identical === t.source;
    if (mode === 'verify') t.complete = t.errors === 0 && t.conflicts === 0 && t.missing === 0 && t.identical === t.source;
    report.tables[table] = t;
  }
  report.finishedAt = new Date().toISOString();
  report.ok = Object.values(report.tables).every(t => t.countCheck && (mode === 'dry-run' ? t.errors === 0 && t.conflicts === 0 : t.complete));
  return report;
}

/** バックアップを表ごとに少しずつ取得して、1つのデータにまとめる */
export async function downloadBackup(get, onProgress = () => {}, pageSize = 1000) {
  const sheets = {};
  let exportedAt = null;
  for (const [, sheet] of TABLES) {
    sheets[sheet] = [];
    let offset = 0;
    for (;;) {
      const r = await get(`/api/admin/export/page?sheet=${encodeURIComponent(sheet)}&offset=${offset}&limit=${pageSize}`);
      exportedAt = exportedAt || r.exportedAt;
      sheets[sheet].push(...r.rows);
      onProgress(`${sheet}：${sheets[sheet].length} 件`);
      if (!r.more) break;
      offset += r.rows.length;
    }
  }
  return { format: 'npas-d1-backup', version: 1, exportedAt, timezone: 'Asia/Tokyo', sheets };
}
