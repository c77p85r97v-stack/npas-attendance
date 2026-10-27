-- N-PAS Attendance 初期スキーマ
-- 何度実行しても安全なように IF NOT EXISTS を付けています。
-- 適用は wrangler d1 migrations apply（適用済みのものは自動でスキップされます）。

-- スタッフ名簿（旧「スタッフ名簿」シート）
CREATE TABLE IF NOT EXISTS staff (
  id             TEXT PRIMARY KEY,              -- スタッフID（旧IDをそのまま維持）
  name           TEXT NOT NULL,                 -- 氏名
  nick           TEXT NOT NULL DEFAULT '',      -- ニックネーム
  grade          TEXT NOT NULL DEFAULT '',      -- 学年
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), -- 有効
  pin_hash       TEXT,                          -- PINのハッシュ（平文は保存しない）
  pin_updated_at TEXT,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 勤怠記録（旧「勤怠データ」シート）
CREATE TABLE IF NOT EXISTS attendance (
  id                TEXT PRIMARY KEY,           -- 記録ID（旧IDをそのまま維持）
  staff_id          TEXT NOT NULL REFERENCES staff(id),
  staff_name        TEXT NOT NULL,              -- 登録時点の氏名（旧シートと同じ）
  work_date         TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  start_time        TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time          TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  break_min         INTEGER NOT NULL CHECK (break_min >= 0 AND break_min < 1440),
  task              TEXT NOT NULL DEFAULT '',
  allowance         REAL CHECK (allowance IS NULL OR (allowance >= 0 AND allowance <= 1000000)), -- 空欄は NULL
  hours             REAL NOT NULL,              -- 勤務時間(時間)
  method            TEXT NOT NULL,              -- 登録方法 manual / clock / bulk-manual / correction など
  row_order         INTEGER NOT NULL,           -- 旧シートの行順（表示順を維持するため）
  client_request_id TEXT UNIQUE,                -- 再送時の二重登録防止キー
  source            TEXT NOT NULL DEFAULT 'app',-- app / migration
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL               -- 更新日時
);
-- 月別履歴・月別集計で「スタッフ＋期間」を絞り込むためのインデックス
CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance(staff_id, work_date);
-- 全員分の月別集計のためのインデックス
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_row_order ON attendance(row_order);

-- 出勤中の状態（旧 ScriptProperties の CLOCK_スタッフID）
CREATE TABLE IF NOT EXISTS clock_sessions (
  staff_id   TEXT PRIMARY KEY REFERENCES staff(id), -- 1人1件まで＝二重出勤をDBで防止
  session_id TEXT NOT NULL UNIQUE,                  -- 退勤時の記録IDになる（再送しても二重登録されない）
  started_at TEXT NOT NULL                          -- ISO 8601 (UTC)
);

-- 打刻修正申請（旧「打刻修正申請」シート）
CREATE TABLE IF NOT EXISTS correction_requests (
  id           TEXT PRIMARY KEY,                -- 申請ID
  requested_at TEXT NOT NULL,                   -- 申請日時
  staff_id     TEXT NOT NULL,
  staff_name   TEXT NOT NULL,
  record_id    TEXT NOT NULL,                   -- 記録ID
  before_json  TEXT NOT NULL,                   -- 変更前(JSON)
  after_json   TEXT NOT NULL,                   -- 変更後(JSON)
  reason       TEXT NOT NULL,                   -- 修正理由
  status       TEXT NOT NULL DEFAULT '申請中',  -- 申請中 / 承認 / 却下
  processed_at TEXT,                            -- 処理日時
  processed_by TEXT,                            -- 処理者
  admin_memo   TEXT NOT NULL DEFAULT '',        -- 管理者メモ
  source       TEXT NOT NULL DEFAULT 'app'
);
-- 1つの記録に「申請中」は1件だけ（同時送信でも二重申請にならない）
CREATE UNIQUE INDEX IF NOT EXISTS uq_correction_pending
  ON correction_requests(record_id) WHERE status = '申請中';
CREATE INDEX IF NOT EXISTS idx_correction_status ON correction_requests(status, requested_at);

-- 操作履歴（旧「修正履歴」シート）
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,                    -- 日時
  action      TEXT NOT NULL,                    -- 操作
  record_id   TEXT NOT NULL DEFAULT '',         -- 記録ID（複数の場合はカンマ区切り）
  operator    TEXT NOT NULL DEFAULT '',         -- 操作者
  before_json TEXT NOT NULL DEFAULT '',         -- 変更前(JSON)
  after_json  TEXT NOT NULL DEFAULT '',         -- 変更後(JSON)
  legacy_key  TEXT UNIQUE                       -- 移行データの重複防止キー
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- 管理者アカウント（スタッフとは別に管理）
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  login_id      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL
);

-- ログインセッション（トークンはハッシュで保存）
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('staff', 'admin')),
  subject_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- データ移行の実行記録
CREATE TABLE IF NOT EXISTS migration_runs (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  operator    TEXT NOT NULL,
  mode        TEXT NOT NULL,                    -- dry-run / import
  report_json TEXT NOT NULL
);
