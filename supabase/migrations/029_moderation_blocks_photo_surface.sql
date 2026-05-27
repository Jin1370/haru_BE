-- ========== photo-watercolor-pipeline sprint ==========
-- moderation_blocks.surface CHECK 제약 확장 — 'photo' 추가.
--
-- 배경:
--   * mig 024 의 surface CHECK 는 ('message', 'voice_intro') 만 허용.
--   * photo-watercolor-pipeline 의 모더레이션 거부 audit (gpt-image-2 safety
--     filter 가 거부 응답) 는 surface='photo' 로 기록 → mig 024 CHECK 위반 회피.
--   * mig 024 직접 수정 ❌ (forward-only). 신규 mig 029 로 CONSTRAINT DROP +
--     ADD 패턴.
--
-- 호환성:
--   * 기존 surface='message' / 'voice_intro' row 는 그대로 통과.
--   * 운영자 dashboard 통합 view + 후속 정책 (누적 차단 ≥ N → admin 알림) 의
--     source-of-truth 단일화는 mig 024 의 사상 그대로 확장.
--
-- RLS / Realtime / 인덱스 영향: 0. CHECK 제약 ADD/DROP 만.
--
-- forward-only. mig 001~028 수정 금지.

ALTER TABLE public.moderation_blocks
  DROP CONSTRAINT IF EXISTS moderation_blocks_surface_check;

ALTER TABLE public.moderation_blocks
  ADD CONSTRAINT moderation_blocks_surface_check
  CHECK (surface IN ('message', 'voice_intro', 'photo'));

COMMENT ON COLUMN public.moderation_blocks.surface IS
  'photo-watercolor-pipeline sprint (mig 029): surface 화이트리스트 확장. '
  '''message'' (chat) | ''voice_intro'' (profile bio) | ''photo'' (profile photo, '
  'gpt-image-2 safety filter rejection). DEFAULT ''message'' 유지 (mig 024 정합).';
