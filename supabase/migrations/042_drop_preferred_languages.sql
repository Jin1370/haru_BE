-- 선호 언어(preferred_languages) 기능 제거 + profiles.language 를 국적 파생값으로 정합.
--
-- 배경: 언어를 사용자가 직접 고르지 않고 국적에서 파생하도록 앱이 바뀌었다
-- (KR→ko, JP→ja, TH→th, IN→hi, 그 외 en — FE constants/nationalities.ts
-- languageForNationality 와 동일). 매칭의 선호 언어 티어 차원도 제거됨
-- (선호 국적이 동일 신호를 커버 — 예: KR 국적 후보는 항상 ko).
--
-- 주의: 이 마이그 적용 전에 BE 는 user_preferences.preferred_languages 를 더 이상
-- 읽거나 쓰지 않는 코드로 배포되어 있어야 한다 (라우트/스키마에서 제거됨). 컬럼을
-- 먼저 드롭한 뒤 옛 코드가 남아있으면 upsert 가 없는 컬럼을 참조해 실패한다.

-- 1) 기존 사용자의 language 를 국적 규칙에 맞춰 재설정.
UPDATE public.profiles
SET language = CASE nationality
    WHEN 'KR' THEN 'ko'
    WHEN 'JP' THEN 'ja'
    WHEN 'TH' THEN 'th'
    WHEN 'IN' THEN 'hi'
    ELSE 'en'
  END
WHERE language IS DISTINCT FROM CASE nationality
    WHEN 'KR' THEN 'ko'
    WHEN 'JP' THEN 'ja'
    WHEN 'TH' THEN 'th'
    WHEN 'IN' THEN 'hi'
    ELSE 'en'
  END;

-- 2) 선호 언어 컬럼 폐기 (매칭에서 미사용).
ALTER TABLE public.user_preferences
  DROP COLUMN IF EXISTS preferred_languages;
