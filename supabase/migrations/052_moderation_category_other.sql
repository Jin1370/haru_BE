-- moderation_blocks.category CHECK 제약 확장 — 'other' 추가.
--
-- 배경:
--   * mig 020 의 category CHECK 는 ('sexual','drug','minor','self_harm') 4값만 허용.
--   * 이 4값은 message-moderation-v1 의 사전/OpenAI text moderation 카테고리 매핑에
--     맞춰 설계된 것 — 사전 layer 는 카테고리가 곧 raw 이라 정확했다.
--   * 그러나 photo surface (mig 029, photo-watercolor-pipeline) 는 gpt-image 계열이
--     거부 카테고리를 구조화 필드로 반환하지 않아 error.message 문자열 키워드
--     heuristic 에 의존한다. 키워드 미매칭 시 `photoConversion.ts` 가 'sexual' 로
--     폴백했고, 'other' 칸이 CHECK 에 없다는 것이 그 폴백 선택의 직접 원인이었다.
--   * 실제 오분류 사례: 저작권 캐릭터(named character likeness) 사진 거부 →
--     message 에 minor/self-harm/drug 키워드 부재 → 'sexual' 기록.
--     운영자 daily review 에서 무고한 사용자가 성적 콘텐츠 차단으로 집계된다.
--
-- 효과 범위:
--   * 차단 동작 자체는 무변경 (거부는 그대로 status='rejected' + 422).
--   * audit 라벨 정확도만 개선 — 'other' = "제공자가 거부했으나 사유 미상".
--   * 기존 4값 row 는 그대로 통과. 백필 없음 (과거 'sexual' 기록 중 어느 것이
--     오분류인지 구별할 원본 정보가 남아있지 않다 — 원본은 거부 즉시 폐기됨).
--
-- RLS / Realtime / 인덱스 영향: 0. CHECK 제약 DROP + ADD 만.
--
-- forward-only. mig 001~051 수정 금지.

ALTER TABLE public.moderation_blocks
  DROP CONSTRAINT IF EXISTS moderation_blocks_category_check;

ALTER TABLE public.moderation_blocks
  ADD CONSTRAINT moderation_blocks_category_check
  CHECK (category IN ('sexual', 'drug', 'minor', 'self_harm', 'other'));

COMMENT ON COLUMN public.moderation_blocks.category IS
  'mig 052: category 화이트리스트 확장. ''sexual'' | ''drug'' | ''minor'' | '
  '''self_harm'' (message/voice_intro 의 사전·OpenAI 매핑 카테고리) | ''other'' '
  '(제공자가 거부했으나 사유 판정 불가 — 주로 photo surface 의 gpt-image '
  'heuristic 미매칭). ''other'' 를 성적 콘텐츠로 오집계하지 않기 위한 칸.';
