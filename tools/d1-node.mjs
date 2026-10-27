// ローカル検証用：Node.js 標準の SQLite（node:sqlite）で Cloudflare D1 と同じ使い方ができるようにする。
// D1 も中身は SQLite なので SQL はそのまま動く。
// ※本物の D1 との違い：ネットワーク遅延がない／同時実行の細かい挙動は再現しない。
//   テスト結果では「ローカル模擬環境」として区別して報告すること。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    // D1 と同じく undefined は使えない
    for (const p of params) if (p === undefined) throw new Error('D1_TYPE_ERROR: undefined は bind できません');
    return new Stmt(this.db, this.sql, params.map(p => (typeof p === 'boolean' ? Number(p) : p)));
  }
  _prep() {
    const s = this.db.prepare(this.sql);
    return s;
  }
  _exec() {
    const s = this._prep();
    const returnsRows = s.columns().length > 0;
    if (returnsRows) {
      const rows = s.all(...this.params).map(r => ({ ...r }));
      return { results: rows, success: true, meta: { changes: this.db.prepare('SELECT changes() AS c').get().c, rows_read: rows.length } };
    }
    const r = s.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const r = this._exec().results[0] ?? null;
    if (r && col) return r[col] ?? null;
    return r;
  }
  async all() {
    return this._exec();
  }
  async run() {
    return this._exec();
  }
  async raw() {
    return this._exec().results.map(r => Object.values(r));
  }
}

export class D1Node {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;'); // D1 は外部キー制約が有効
    this.queryCount = 0;
  }
  prepare(sql) {
    this.queryCount++;
    return new Stmt(this.db, sql);
  }
  /** D1 の batch：全体が1つのトランザクション。途中で失敗したら全て取り消す。 */
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map(s => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 1 };
  }
  /** 未適用のマイグレーションだけを順に実行する（wrangler と同じ d1_migrations 表で記録） */
  applyMigrations() {
    const dir = join(ROOT, 'migrations');
    this.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const done = new Set(this.db.prepare('SELECT name FROM d1_migrations').all().map(r => r.name));
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(readFileSync(join(dir, f), 'utf8'));
        this.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    return this;
  }
}

export function createTestEnv(extra = {}) {
  const DB = new D1Node().applyMigrations();
  return { DB, ENVIRONMENT: 'test', ALLOW_TEST_TOOLS: 'true', PIN_PEPPER: 'test-pepper-0123456789', LOG_TIMING: 'false', ...extra };
}
