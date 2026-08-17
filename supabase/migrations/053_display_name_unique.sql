-- 닉네임(display_name) 중복 금지.
-- 대소문자 무시(lower) — 'Jun' 과 'jun' 은 같은 닉네임으로 본다.
-- 탈퇴 계정은 auth.ts:deleteAccount 가 display_name='' 로 anonymize 하므로
-- 빈 문자열은 제외한다(여러 탈퇴 계정이 서로 충돌하지 않게).
--
-- 적용 전 기존 중복 확인 (0행이어야 성공):
--   SELECT lower(display_name), count(*) FROM profiles
--   WHERE display_name <> '' GROUP BY 1 HAVING count(*) > 1;
-- 중복이 있으면 먼저 손으로 정리한 뒤 실행한다(자동 rename 은 하지 않는다).

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_display_name_unique
  ON profiles (lower(display_name))
  WHERE display_name <> '';
