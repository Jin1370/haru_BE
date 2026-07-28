-- 선호 국적에서 "본인과 같은 언어권" 국가를 제거한다 (일회성 청소).
--
-- 배경: 디스커버/받은 좋아요는 viewer 와 language 가 같은 후보를 하드 제외한다
-- (src/routes/swipe.ts). 언어는 국적에서 파생되므로(mig 042: KR→ko, JP→ja,
-- TH→th, IN→hi, 그 외 en) 같은 언어권 국가를 선호로 골라둬도 매칭될 후보가
-- 없다. FE 는 이제 그런 국가를 picker 에서 아예 숨기지만, 정책 이전에 저장된
-- 행에는 값이 남아 있다 — 예: 미국 사용자의 preferred_nationalities = {GB}.
--
-- 동작상 무해하지만(BE 가 이미 무시) 화면에 보이지 않는 유령 값이라 데이터를
-- 정리한다. 본인 국적 자신도 같은 규칙에 걸려 함께 제거된다(ko 는 KR 뿐 등).
--
-- 언어 파생 CASE 는 mig 042 의 백필 + FE constants/nationalities.ts 의
-- languageForNationality 와 동일해야 한다. 국적 목록이 늘어나면 셋 다 갱신.

UPDATE user_preferences up
SET preferred_nationalities = COALESCE(
  (
    SELECT array_agg(code ORDER BY ord)
    FROM unnest(up.preferred_nationalities) WITH ORDINALITY AS t(code, ord)
    WHERE CASE code
            WHEN 'KR' THEN 'ko'
            WHEN 'JP' THEN 'ja'
            WHEN 'TH' THEN 'th'
            WHEN 'IN' THEN 'hi'
            ELSE 'en'
          END IS DISTINCT FROM p.language
  ),
  '{}'::text[]  -- 전부 제거되면 빈 배열 = "제약 없음" (선호 미설정과 동일 의미)
)
FROM profiles p
WHERE p.id = up.user_id
  AND up.preferred_nationalities IS NOT NULL
  AND array_length(up.preferred_nationalities, 1) > 0
  AND p.language IS NOT NULL
  -- 실제로 지울 게 있는 행만 건드린다 (no-op UPDATE 회피).
  AND EXISTS (
    SELECT 1
    FROM unnest(up.preferred_nationalities) AS code
    WHERE CASE code
            WHEN 'KR' THEN 'ko'
            WHEN 'JP' THEN 'ja'
            WHEN 'TH' THEN 'th'
            WHEN 'IN' THEN 'hi'
            ELSE 'en'
          END = p.language
  );
