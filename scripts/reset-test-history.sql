-- 本番開始前：テスト期間の勤怠・履歴・申請を消す（旧 npasResetTestHistory と同じ）
-- スタッフ名簿・PIN・管理者は残す。
-- ⚠️ 実行前に必ずバックアップを取ること（README「本番開始前のテストデータ削除」参照）。
DELETE FROM correction_requests;
DELETE FROM clock_sessions;
DELETE FROM attendance;
DELETE FROM audit_log;
DELETE FROM sessions WHERE kind = 'staff';
