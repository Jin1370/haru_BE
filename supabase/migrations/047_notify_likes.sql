-- 받은 좋아요 푸시 알림 옵트아웃 토글. 기본 ON (기존 notify_messages/notify_matches 와 동일 정책).
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS notify_likes BOOLEAN NOT NULL DEFAULT true;
