-- chat-photos: 채팅 사진 전송.
--
-- 사진은 메시지의 한 종류라 별도 테이블을 만들지 않고 messages 에 컬럼을 붙인다.
-- 사진 메시지는 번역/TTS 파이프라인을 안 탄다 (캡션이 없어 번역할 게 없고,
-- 폴백 캡션을 TTS 가 읽으면 안 된다) — audio_status='ready' + audio_url=NULL 로
-- 기존 "텍스트 전용" 경로를 그대로 쓴다.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS photo_purged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS photo_width INTEGER,
  ADD COLUMN IF NOT EXISTS photo_height INTEGER;

-- 버킷은 **private**. voice-messages 는 public 이지만 채팅 사진은 실물 사진이라
-- 리스크 등급이 다르다 — public 이면 URL 이 한 번 새는 순간 영구히 유효해진다.
-- 읽기는 요청 시점에 발급하는 짧은 TTL 서명 URL 로만 (voice-intro-audio 와 동일).
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-photos', 'chat-photos', false)
ON CONFLICT (id) DO NOTHING;

-- 30일 sweep 대상 조회용 부분 인덱스 (purgeExpiredAudio 의 idx_messages_audio_expiry 대응).
CREATE INDEX IF NOT EXISTS idx_messages_photo_expiry
  ON messages (created_at)
  WHERE photo_path IS NOT NULL AND photo_purged_at IS NULL;

-- moderation_blocks.surface 에 채팅 사진 차단 값 추가. 프로필 사진 변환 거부
-- ('photo') 와 나눠야 운영 리뷰에서 표면별 빈도가 섞이지 않는다.
ALTER TABLE moderation_blocks DROP CONSTRAINT IF EXISTS moderation_blocks_surface_check;
ALTER TABLE moderation_blocks ADD CONSTRAINT moderation_blocks_surface_check
  CHECK (surface IN ('message', 'voice_intro', 'photo', 'chat_photo'));
