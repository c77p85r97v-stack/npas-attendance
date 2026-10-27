# N-PAS Attendance クラウド版 設計書

## 1. 全体の流れ

```
スマホ・PC のブラウザ
   │  画面（HTML/JS/画像）…… Workers 静的アセット（Worker を通らず直接配信）
   │  /api/* …………………… Worker（src/index.js）
   ▼
Cloudflare Workers ──（バインディング DB）──► Cloudflare D1（SQLite）
```

- 画面は旧 `Index.html` をそのまま使い、通信部分（`google.script.run`）だけを `public/js/api.js` に置き換えた。
- 本人の特定はログイン時に発行する Cookie（`npas_sid`／管理者は `npas_admin`）で行う。

## 2. データベース（migrations/0001_init.sql）

| 表 | 旧シート | 主な列 | 制約・インデックス |
|---|---|---|---|
| `staff` | スタッフ名簿 | id（スタッフID）, name, nick, grade, active, pin_hash, failed_logins, locked_until | 主キー id |
| `attendance` | 勤怠データ | id（記録ID）, staff_id, staff_name, work_date, start_time, end_time, break_min, task, allowance（空欄=NULL）, hours, method, row_order, client_request_id, source, created_at, updated_at | 主キー id／(staff_id, work_date)／work_date／row_order／client_request_id 一意／CHECK で形式・範囲 |
| `clock_sessions` | ScriptProperties の `CLOCK_<ID>` | staff_id, session_id, started_at | staff_id 主キー（二重出勤を防止）, session_id 一意 |
| `correction_requests` | 打刻修正申請 | id（申請ID）, requested_at, staff_id, staff_name, record_id, before_json, after_json, reason, status, processed_at, processed_by, admin_memo | 「申請中」は record_id ごとに1件（部分一意インデックス） |
| `audit_log` | 修正履歴 | at（日時）, action（操作）, record_id, operator（操作者）, before_json, after_json, legacy_key | legacy_key 一意（移行の重複防止） |
| `admins` | （新規） | login_id, name, password_hash | login_id 一意 |
| `sessions` | （新規） | token_hash, kind, subject_id, expires_at | トークンはハッシュで保存 |
| `migration_runs` | （新規） | at, operator, mode, report_json | 移行の実行記録 |

**月別集計は表を持たない**：`attendance` の `(staff_id, work_date)` インデックスを使い、表示のたびに `GROUP BY` で計算する。
保存と集計が独立するので、集計の失敗で保存が失敗扱いになることがない。

**表示順**：旧シートの行の順（＝登録順）を `row_order` で保持。移行時は旧シートの行番号を入れる。

## 3. API

すべて JSON。書き込み（POST）は `X-Requested-With: npas` ヘッダーと同一オリジンが必須（CSRF 対策）。
エラーは `{ "error": "メッセージ" }`。メッセージは旧 GAS 版と同じ文言。

### スタッフ用（ログイン必須。* は不要）

| メソッド | パス | 旧関数 | 内容 |
|---|---|---|---|
| GET | `/api/staff` * | listStaff | 有効なスタッフの id, name, nick, grade |
| POST | `/api/login` * | — | `{staffId, pin}` → Cookie 発行 |
| POST | `/api/logout` | — | セッション削除 |
| GET | `/api/me` | — | ログイン中のスタッフ |
| GET | `/api/clock/status` | clockStatus | `{active, startedAt}` |
| POST | `/api/clock/in` | clockIn | `{time}`。出勤中なら 409「すでに出勤打刻済みです」 |
| POST | `/api/clock/out` | clockOut | `{breakMin, task, allowance, requestId}` → `{id, hours, workDate, summaryUpdated:false}` |
| POST | `/api/attendance` | saveAttendance | `{date, start, end, breakMin, task, allowance, requestId}` |
| GET | `/api/history?month=YYYY-MM` | getHistory | `{entries:[{id,date,start,end,breakMin,task,allowance,hours,method}], totalHours}` |
| POST | `/api/bulk` | npasSaveBulkAttendance | `{staffIds[], date, start, end, breakMin, task, allowance}` → `{saved, skipped, workDate, operator, auditWarning}` |
| POST | `/api/corrections` | npasSubmitCorrection | `{recordId, input, reason}` → `{requestId, status:'申請中'}` |

スタッフID（`staffId`・`operatorId`）を送っても使わない。ログイン本人と違えば 403。

### 管理者用（管理者ログイン必須）

| メソッド | パス | 内容 |
|---|---|---|
| GET/POST | `/api/admin/setup` | 最初の管理者の作成（`ADMIN_SETUP_TOKEN` が必要。管理者がいれば使えない） |
| POST | `/api/admin/login`, `/api/admin/logout` | ログイン・ログアウト |
| GET | `/api/admin/me` | ログイン中の管理者 |
| GET/POST | `/api/admin/admins` | 管理者の一覧・追加 |
| POST | `/api/admin/password` | 自分のパスワード変更 |
| GET | `/api/admin/corrections?status=` | 修正申請の一覧 |
| POST | `/api/admin/corrections/:id/approve` `…/reject` | 承認（記録を変更）・却下 `{memo}` |
| GET/POST | `/api/admin/staff` | スタッフ一覧・追加/更新 |
| POST | `/api/admin/staff/:id/pin` | PIN 発行（応答で1回だけ表示） |
| POST | `/api/admin/pins/issue-missing` | PIN 未設定者へ少人数ずつ発行 `{limit}` → `{issued, remaining}` |
| POST | `/api/admin/staff/:id/unlock` | ログインロック解除 |
| POST | `/api/admin/staff/:id/cancel-clock` | 出勤状態の取消 |
| GET/POST | `/api/admin/records` | 勤怠記録の一覧・追加（理由必須） |
| POST | `/api/admin/records/:id/update` `…/delete` | 修正・削除（理由必須・履歴に全内容） |
| GET | `/api/admin/audit?limit=&beforeId=` | 操作履歴 |
| GET | `/api/admin/summary?month=` | 月別集計 |
| GET | `/api/admin/summary.csv?month=YYYY-MM\|all` | 月別集計 CSV（旧シートと同じ列） |
| GET | `/api/admin/personal?staffId=&month=` | 個人別勤怠申請書 |
| GET | `/api/admin/export/page?sheet=&offset=&limit=` | バックアップの分割取得 |
| POST | `/api/admin/migrate` | 移行 `{mode: dry-run\|import\|verify, table, rows[≤500]}` |
| POST/GET | `/api/admin/migrate/report(s)` | 移行結果の保存・一覧 |

### テスト用（本番では 404）

| POST | `/api/test/reset` | TEST01〜05 とテスト管理者を作り直す（他のスタッフには触れない） |

## 4. 同時アクセスと二重登録の防止

| 場面 | 方法 |
|---|---|
| 出勤の二重打刻 | `clock_sessions.staff_id` が主キー。`INSERT … ON CONFLICT DO NOTHING` の結果が0件なら拒否 |
| 退勤の二重登録 | 記録IDを出勤ごとの `session_id` に固定。「記録の追加」と「出勤状態の削除」を1つの batch（トランザクション）で。削除は記録が存在するときだけ |
| 通信エラー後の再送 | 画面が内容ごとに `requestId` を付け、成功するまで同じ値を使う。サーバーは同じ `requestId` の記録があればそれを返す |
| 一括申請の重複 | `INSERT … SELECT … WHERE NOT EXISTS (同じ人・同じ日)` を1文で実行し、`RETURNING` で登録できた人を判定 |
| 修正申請の二重申請 | 部分一意インデックス（record_id, status='申請中'） |
| 承認と直接修正の競合 | 「記録が変更前と同じ」ことを条件に UPDATE。条件が合わなければ 409 |
| 同時承認 | 「申請中」であることを条件に UPDATE。1回だけ成功 |

## 5. 認証の詳細

- PIN・パスワード：PBKDF2-SHA256（20,000回）＋ ソルト ＋ サーバーの秘密値 `PIN_PEPPER`。保存形式 `pbkdf2$回数$ソルト$ハッシュ`（回数は後から増やせる）。
- 回数は Workers 無料プランの CPU 時間（10ms/リクエスト）に収まるよう選んだ（ローカル測定で約3.5ms）。PIN は桁数が少ないため、守りの中心は秘密値とロック。
- 5回続けて失敗すると15分ロック。PIN を再発行するとその人のセッションは無効になる。

## 6. 旧仕様との対応（変えていない点）

- 入力検証と計算：`src/lib/validate.js` は旧 `date_` `time_` `minutes_` `validate_` と同じ式（テストで確認）。
- 業務内容は200文字を超えると切り詰める（旧仕様。拒否はしない）。
- 退勤打刻の時刻は日本時間の HH:mm（秒は切り捨て）。勤務日は出勤した日。
- 一括申請は、同じ人・同じ日の記録があればスキップ。通常の申請は同じ日に複数登録できる（旧仕様）。
- 月別集計：有効なスタッフのみ、学年の大きい順 → 氏名順。勤務日数は「記録のある日」の数。
