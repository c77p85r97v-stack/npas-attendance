-- 勤怠記録の削除申請に対応する（申請の種類：修正 / 削除）
ALTER TABLE correction_requests ADD COLUMN kind TEXT NOT NULL DEFAULT '修正';
