-- 목소리 미등록 리마인더 1회 발송 마킹 (src/jobs/remindVoiceSetup.ts).
-- NULL = 아직 안 보냄. 재발송은 정책상 없음 (한 번만 찔러본다).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS voice_reminder_sent_at TIMESTAMPTZ;
