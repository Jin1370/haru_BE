-- ========== moderation block audit log ==========
-- message-moderation-v1 sprint (PR1 — 사전 차단 audit).
--
-- safety-security-reviewer 권고 수용 (사용자 결정): 차단 이벤트 DB 보존.
-- 메시지 원문 절대 저장 ❌ — 카테고리/언어/matched_token(≤32 chars)/timestamp/sender_id 만.
-- 보존 90일. 정기 cleanup 스크립트는 후속 카드 (v1 누적 작아 출시 후 도입).
--
-- 용도:
--   (a) 운영 통계 — 출시 후 false positive 모니터링 (matched_token 빈도 top-N)
--   (b) 누적 차단 정책 (3회 차단 시 escalation 등) 도입 시 source-of-truth — 후속 카드
--   (c) 약관·개인정보처리방침의 "차단 기록 보존 기간" 항목 법적 근거
--
-- BE 가 service_role key 로 fire-and-forget INSERT 한다. INSERT 실패는 응답 막지
-- 않음 (console.warn 으로 fallback).

CREATE TABLE IF NOT EXISTS public.moderation_blocks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category      TEXT NOT NULL CHECK (category IN ('sexual','drug','minor','self_harm')),
  language      TEXT NOT NULL,
  blocked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.moderation_blocks IS
  'message-moderation-v1 (PR1): 메시지 차단 audit log. 메시지 원문 저장 ❌. '
  '보존 90일. cleanup 스크립트는 후속 카드. '
  'safety-security-reviewer 권고 + 사용자 결정.';

-- 누적 차단 정책 (후속 카드) 의 source-of-truth 용 인덱스.
-- sender_id leading + blocked_at DESC 로 "최근 N 일간 본인 차단 카운트" 가 핫패스.
CREATE INDEX IF NOT EXISTS idx_moderation_blocks_sender_at
  ON public.moderation_blocks(sender_id, blocked_at DESC);

-- RLS: service_role 전용. anon/authenticated 는 INSERT/SELECT 모두 차단.
-- 정책 자체를 두지 않아 RLS 가 모든 비-service_role 접근을 deny — push-notifications/
-- admin sprint 의 device_tokens 와는 다른 패턴 (device_tokens 는 본인 owner 정책 보유).
-- 차단 로그는 사용자 본인에게도 노출되면 안 됨 (어떤 단어가 매칭됐는지 학습 차단).
ALTER TABLE public.moderation_blocks ENABLE ROW LEVEL SECURITY;

-- Realtime publication 미포함 — FE 가 본 테이블을 realtime 으로 구독할 일 없음.
