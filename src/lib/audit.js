// 操作履歴（旧「修正履歴」シートと同じ項目）
import { nowIso } from './time.js';

/**
 * 操作履歴を追加する文を作る（batch に含めて、本体の保存と同じトランザクションで記録する）。
 * onlyIfRecordId を指定すると、その記録IDが attendance に存在する場合だけ記録する。
 */
export function auditStmt(env, { action, recordId = '', operator = '', before = '', after = '', onlyIfRecordId }) {
  const b = before === '' ? '' : JSON.stringify(before);
  const a = after === '' ? '' : JSON.stringify(after);
  if (onlyIfRecordId) {
    return env.DB.prepare(
      `INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attendance WHERE id = ?)`
    ).bind(nowIso(), action, String(recordId), operator, b, a, onlyIfRecordId);
  }
  return env.DB.prepare(
    'INSERT INTO audit_log (at, action, record_id, operator, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(nowIso(), action, String(recordId), operator, b, a);
}

export function staffLabel(u) {
  return `${u.name} (${u.id})`;
}

export function adminLabel(a) {
  return `管理者:${a.name} (${a.loginId})`;
}
