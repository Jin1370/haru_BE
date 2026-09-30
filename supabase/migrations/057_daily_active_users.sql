-- 057: 일별 활성 사용자 (DAU) 기록.
-- authMiddleware 가 JWT 인증 통과 시 (user_id, KST 날짜) 를 하루 1 행 upsert.
-- 앱을 열면 반드시 인증 API 를 부르므로 "그날 앱을 연 사용자" 의 근사치.
-- 어드민 임퍼소네이션 요청은 기록하지 않는다.
--
-- profiles FK 없음: 가입 직후 프로필 생성 전 요청도 기록되어야 하고, FK 위반
-- 에러가 매 요청 로그로 새지 않게 한다. 탈퇴 시 정리는 auth.ts:deleteAccount
-- 가 동기 DELETE, 보존은 cleanupAuditTables 의 365 일 sweep.
CREATE TABLE IF NOT EXISTS daily_active_users (
  user_id UUID NOT NULL,
  day     DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_active_users_day ON daily_active_users (day);

-- 정책 0 = anon/authenticated deny, service_role 전용.
ALTER TABLE daily_active_users ENABLE ROW LEVEL SECURITY;
