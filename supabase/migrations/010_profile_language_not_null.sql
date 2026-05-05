-- profiles.language NOT NULL 강제.
--
-- 배경:
--   mig 009 에서 `profiles.language TEXT` 컬럼을 NULLABLE 로 도입하고
--   기존 데이터를 백필했다. zod 스키마(`profileUpsertSchema.language`) 는
--   이미 필수이므로 신규 가입은 NULL 이 들어올 수 없지만, 옛 placeholder
--   row 가 있으면 NULL 이 잔존 가능.
--
-- 본 마이그레이션은 백필 검증 후 NOT NULL 제약을 강제한다. NULL 행이
-- 있으면 ALTER 가 실패하므로, 그 경우 사전에 처리 필요:
--   SELECT id FROM public.profiles WHERE language IS NULL;
-- 누락 행을 화이트리스트(ko/ja/en/th/hi) 중 하나로 채우거나 삭제 후 재실행.
--
-- forward-only. mig 001~009 는 수정하지 않는다.

ALTER TABLE public.profiles
  ALTER COLUMN language SET NOT NULL;
