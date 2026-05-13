-- push-notifications sprint
--
-- Expo Push Token 등록 테이블 + user_preferences 옵트아웃 컬럼 2종.
--
-- device_tokens 정책:
--   * 사용자당 다기기 허용 (UNIQUE 는 expo_push_token 자체에).
--   * expo_push_token UNIQUE: 같은 기기가 다른 계정에 로그인하면 BE 가 upsert
--     로 user_id 를 갱신해 마지막 owner 가 잡힌다 (Expo 는 같은 기기에 같은
--     토큰을 재발급).
--   * RLS: 본인 토큰만 SELECT/INSERT/DELETE 가능. UPDATE 정책 없음 —
--     last_seen_at 갱신은 service-role 라우트가 직접 수행.
--   * ON DELETE CASCADE: auth.users 삭제 시 자동 정리 (계정 탈퇴 cleanup).

CREATE TABLE public.device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_tokens_user_id_idx ON public.device_tokens(user_id);

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_tokens_owner_select ON public.device_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY device_tokens_owner_insert ON public.device_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY device_tokens_owner_delete ON public.device_tokens
  FOR DELETE USING (auth.uid() = user_id);

-- 옵트아웃: 별도 테이블 대신 user_preferences (mig 002) 확장.
-- 기존 owner SELECT/UPDATE 정책이 자동 적용 — 추가 정책 불필요.
-- default true: 권한 grant 후 새 사용자는 기본 ON 상태로 알림 수신.
ALTER TABLE public.user_preferences
  ADD COLUMN notify_messages BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN notify_matches  BOOLEAN NOT NULL DEFAULT true;

-- Realtime publication 변경 없음 — device_tokens 는 realtime 구독 대상이 아니다.
