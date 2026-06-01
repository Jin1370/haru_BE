-- 프리미엄 entitlement (런칭 쿠폰 + 향후 구독이 공유하는 토대).
-- premium_until 이 NULL 또는 과거면 무료 티어, 미래면 프리미엄
-- (음성 30통/일 · 받은좋아요 무제한 · 광고 없음).
--
-- 쿠폰 = premium_until 을 보조금 기간 이하 시각으로 set → 그 시각에 자동 만료
--        (별도 해제 작업 없이 무료 티어로 graceful 복귀 = 빼앗기 아님).
-- 구독 = 결제 갱신 시 premium_until 을 다음 결제일로 연장(향후).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
