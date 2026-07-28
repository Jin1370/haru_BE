-- 가입 시 입력하는 추천 코드 (한일교류회 등 파트너별 유입 추적 + 정산 근거).
-- 최초 프로필 생성 시에만 기록되며(BE 라우트가 !prev 분기로 강제), 이후 수정 불가.
-- 정산 대상 = referral_code 보유 + gender='female' + is_active + 최소 1회 메시지 발신.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- 파트너별 GROUP BY 집계 핫패스 (전체 스캔 회피). 코드 없는 행(대다수)은 제외.
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code
  ON profiles (referral_code)
  WHERE referral_code IS NOT NULL;
