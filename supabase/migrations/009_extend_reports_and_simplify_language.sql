-- 원본 009_extend_report_reasons.sql + 009_simplify_language_model.sql 를
-- 단일 파일로 통합 (Supabase CLI 의 schema_migrations 가 version=<prefix>
-- 를 PRIMARY KEY 로 사용하기 때문에 같은 prefix 두 파일은 충돌).
-- 두 변경은 다른 테이블(reports vs profiles/user_preferences)에 독립적이라
-- 합쳐도 의미 동등.

-- ---------- Part A — 신고 카테고리 확장 ----------
--   underage             — 미성년자 의심 (즉시 운영자 검토 필요)
--   voice_impersonation  — 보이스 도용/악용 (haru 도메인 특화)

ALTER TABLE reports DROP CONSTRAINT reports_reason_check;

ALTER TABLE reports ADD CONSTRAINT reports_reason_check
  CHECK (reason IN (
    'spam',
    'inappropriate',
    'fake_profile',
    'harassment',
    'underage',
    'voice_impersonation',
    'other'
  ));

-- ---------- Part B — 언어 모델 단순화 ----------
--
-- 다중 + level → 단일 scalar (profile) / 코드 배열 (preference).
--
-- 배경:
--   * 프로필 등록은 사실상 단일 언어로 운영되어 왔고 (translation/TTS 파이프라인
--     이 항상 languages[0] 만 사용), level 필드는 UI 에서 더 이상 노출하지
--     않으므로 의미 없는 비교 가지였다. 매칭 선호도 측면에서도 단순 코드
--     포함 여부만 사용한다.
--   * mig 008 에서 옛 scalar `profiles.language` 와 codes-only
--     `user_preferences.preferred_languages` 를 모두 drop 했다. 본 마이그레이션
--     은 동일한 컬럼명을 다시 도입하지만 의미는 다르다 — rollback 이 아니라
--     "단순화된 형태로의 재도입" 이다.
--     - `profiles.language TEXT`              : 화이트리스트(ko/ja/en/th/hi)
--                                              중 정확히 한 개. NOT NULL 강제는
--                                              백필 검증 후 별도 단계로 미룸
--                                              (현재는 NULLABLE).
--     - `user_preferences.preferred_languages TEXT[]` : 다중 코드, level 없음.
--                                                      빈 배열 = 제약 없음.

-- 1) profiles.language (scalar) 추가 + languages 첫 항목에서 백필 + languages drop.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS language TEXT;

UPDATE public.profiles
SET language = languages->0->>'code'
WHERE language IS NULL
  AND jsonb_typeof(languages) = 'array'
  AND jsonb_array_length(languages) > 0;

ALTER TABLE public.profiles
  DROP COLUMN languages;

COMMENT ON COLUMN public.profiles.language IS
  '주 사용 언어 코드 (ko/ja/en/th/hi 화이트리스트, mig 009 에서 단순화). '
  '번역·TTS 파이프라인의 source 기준이자 디스커버 SQL 필터의 viewer-자국어 하드 제외 키.';

-- 2) user_preferences.preferred_languages (코드 배열) 추가
--    + preferred_languages_detail 의 코드만 백필 + detail drop.
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS preferred_languages TEXT[] NOT NULL DEFAULT '{}';

UPDATE public.user_preferences
SET preferred_languages = COALESCE(
  (
    SELECT array_agg(entry->>'code')
    FROM jsonb_array_elements(preferred_languages_detail) AS entry
    WHERE entry ? 'code'
  ),
  '{}'::text[]
)
WHERE jsonb_typeof(preferred_languages_detail) = 'array'
  AND jsonb_array_length(preferred_languages_detail) > 0;

ALTER TABLE public.user_preferences
  DROP COLUMN preferred_languages_detail;

COMMENT ON COLUMN public.user_preferences.preferred_languages IS
  '선호 언어 코드 배열 (ko/ja/en/th/hi 화이트리스트, mig 009 에서 단순화). '
  '레벨 개념 없음. 빈 배열 = 언어 제약 없음. '
  '디스커버 티어 정렬 신호로만 사용 (사전 SQL 필터 아님).';
