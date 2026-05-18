-- ========== voice-intro-moderation-unification sprint ==========
-- moderation_blocks audit 테이블에 surface 컬럼 추가 (mig 020 후속).
--
-- 배경:
--   * message-moderation-v1 (PR1) 의 mig 020 은 메시지 surface 전용으로
--     설계됐다. 본 sprint 에서 voice intro 도 동일 audit 테이블로 통합 —
--     운영자 dashboard 통합 view + 후속 정책(누적 차단 ≥ N → admin 알림)
--     의 source-of-truth 단일화.
--   * surface='message' DEFAULT 로 기존 row 안전 백필 (PR1 도입 후 본 마이그
--     적용 시점까지 누적된 차단 이력은 모두 메시지 surface).
--   * CHECK 제약으로 화이트리스트 강제 (오타/위조 surface 차단).
--
-- RLS 영향: 0. service_role 전용 정책 유지 — 컬럼 추가는 RLS 변경 트리거 안 함.
-- Realtime publication 영향: 0. mig 020 에서 publication 미포함 정책 유지.
-- 인덱스: 현 sender_id+blocked_at 인덱스로 surface 통계 query 충분 (counter
--   filter 만 추가). surface 단독 인덱스는 9~10K row 누적 전까진 불필요.
--
-- forward-only. mig 001~023 수정 금지.

ALTER TABLE public.moderation_blocks
  ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'message'
  CHECK (surface IN ('message', 'voice_intro'));

COMMENT ON COLUMN public.moderation_blocks.surface IS
  'voice-intro-moderation-unification sprint: 차단 발생 surface. '
  '''message'' (chat) | ''voice_intro'' (profile bio). DEFAULT ''message'' 로 '
  'mig 020 이후 누적 row 자동 백필.';
