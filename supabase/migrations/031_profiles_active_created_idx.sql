-- A1 (discover 스코어링 윈도우 안정화):
-- GET /api/discover 의 후보 페치가 결정적 ORDER BY created_at DESC 로 "가장 최근
-- 가입한 fetchLimit 명" 을 모집하도록 바뀌었다(routes/swipe.ts). 이 access pattern
-- (is_active=true 필터 + created_at DESC 정렬 + LIMIT) 을 지원하는 부분 인덱스.
--
-- 기존 idx_profiles_active (mig 002, is_active 단독 부분 인덱스) 는 정렬을 돕지
-- 못해 후보 수가 커지면 Sort 노드가 비싸진다. created_at DESC 정렬을 인덱스로
-- 흡수해 수천~수만 행에서도 윈도우 모집을 인덱스 스캔으로 처리.
CREATE INDEX IF NOT EXISTS idx_profiles_active_created
  ON profiles (created_at DESC)
  WHERE is_active = true;
