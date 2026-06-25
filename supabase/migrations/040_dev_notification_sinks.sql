-- dev/QA 전용: 한 테스터 폰으로 여러 dev seed 계정의 푸시 알림을 모아 받기 위한
-- sink 매핑 테이블.
--
-- 배경:
--   어드민 대시보드는 임퍼소네이션으로 ~10개 dev seed 계정을 한 화면에서 운용한다.
--   그 계정들은 폰에 로그인된 적이 없어 device_tokens 가 0개 → 메시지를 받아도
--   sendPushToUser 가 토큰을 못 찾아 푸시가 안 나간다 (테스터가 알 방법 없음).
--
-- 해결:
--   테스터 폰에 로그인된 실계정의 expo_push_token 을 모든 dev seed 계정 앞으로
--   복제해 둔다. sendPushToUser 는 device_tokens 외에 이 테이블도 (어드민 활성
--   시에만) 조회해 토큰을 합쳐 발송한다. label 에 수신 계정 표시명을 담아 한 폰에
--   여러 계정 알림이 섞여도 "어느 계정이 받았는지" 를 알림 제목으로 구분한다.
--
-- 격리/안전:
--   * 실유저 push 경로(device_tokens)·UNIQUE 제약·onConflict 동작 일절 무변경.
--   * 본 테이블은 ADMIN_DASHBOARD_ENABLED=true 일 때만 BE 가 읽고/쓴다.
--     출시 빌드(미설정)에서는 쿼리 자체가 실행되지 않아 prod 푸시 경로 무영향.
--   * RLS 정책 0개 → deny-by-default. service_role(어드민 라우트)만 접근.
--   * dev_user_id ON DELETE CASCADE: dev 계정 hard delete(cleanup-dev-accounts)
--     시 자동 정리. 실유저 deleteAccount 는 anonymize 만 하지만 실유저는 애초에
--     sink 행을 가지지 않으므로 정리 대상 아님.

CREATE TABLE public.dev_notification_sinks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dev_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dev_user_id, expo_push_token)
);

CREATE INDEX dev_notification_sinks_dev_user_id_idx
  ON public.dev_notification_sinks(dev_user_id);

ALTER TABLE public.dev_notification_sinks ENABLE ROW LEVEL SECURITY;
-- 정책을 의도적으로 만들지 않는다 → anon/authenticated 전면 deny.
-- service_role 키를 쓰는 BE 어드민 라우트만 읽고 쓴다.
