-- voice-first-message-gate sprint
--
-- 수신자가 메시지의 음성을 1회 끝까지 재생한 시각. NULL = 아직 안 들음 →
-- ChatBubble 이 텍스트(original_text + translated_text)를 가리고 편지 UI 만
-- 노출. 송신자 본인은 이 컬럼을 보지 않으므로 (FE 분기 isMine == false 만
-- 게이팅) 기존 송신자 UX 무영향.
--
-- read_at 과 의미 분리:
--   * read_at — 채팅방 진입 시 일괄 PATCH 로 set. "수신자가 채팅방을 열었음".
--   * listened_at — 메시지 단위로 1회 POST 로 set. "수신자가 그 메시지의
--     음성을 끝까지 재생했음".

ALTER TABLE public.messages
  ADD COLUMN listened_at TIMESTAMPTZ NULL;

-- 백필: 이미 read_at IS NOT NULL 인 메시지는 listened_at = read_at 으로 set.
-- 의미적으로는 "음성 청취" 의 증거가 아니지만, 기존 채팅 이력을 다시 게이팅
-- 하는 UX 회귀 (어제 받은 모든 메시지가 다시 잠김) 를 막기 위한 일회성 보정.
-- read_at 미발생 메시지(상대가 아직 안 읽음)는 NULL 유지 → 채팅방 첫 진입 시
-- 정상 게이팅 흐름 적용.
UPDATE public.messages
   SET listened_at = read_at
 WHERE read_at IS NOT NULL
   AND listened_at IS NULL;

-- 인덱스 추가 안 함 — listened_at 쿼리 경로는 단건 UPDATE/SELECT 만이며,
-- 일괄 조회 시에도 messages(match_id, created_at) 인덱스가 매치 단위 필터를
-- 충분히 좁힌다. 향후 분석 쿼리(listened rate 등) 필요 시 별도 마이그레이션.

-- Realtime publication 변경 불필요 —
-- mig 001 의 `ALTER PUBLICATION supabase_realtime ADD TABLE messages` 가 이미
-- messages 전체 컬럼을 publish 한다. REPLICA IDENTITY DEFAULT 이므로 UPDATE
-- payload 의 `new` 에 listened_at 이 포함된다. FE 는 `new.listened_at` 만
-- 보면 충분하므로 REPLICA IDENTITY FULL 도 불필요.

-- RLS 정책 변경 없음 — messages UPDATE 정책은 신설하지 않는다.
-- read_at 과 동일 패턴: service role 라우트가 수신자 권한(sender_id != auth.uid())
-- 을 직접 검증한 뒤 UPDATE. RLS UPDATE 정책 추가 시 라우트 측 권한과의 중복.
