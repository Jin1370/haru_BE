-- ========== auto-freeze marker + audit log ==========
-- message-moderation-v1 sprint (PR2 — 누적 신고 자동 freeze + audit).
--
-- profiles.is_active=false 는 voice-first-message-gate / push-notifications /
-- auth.ts(deleteAccount) 가 이미 사용 중이라 의미가 중복된다 (deleted vs frozen 구분 불가).
-- frozen_at 컬럼을 별도로 두어 운영 추적 + admin freeze 해제 SOP 의 단일 진실원.
-- deleted_at 와는 의미가 다르다:
--   * deleted_at: 사용자 본인이 계정 탈퇴 (auth.ts deleteAccount)
--   * frozen_at:  운영(자동/수동)이 계정 비활성

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.profiles.frozen_at IS
  'message-moderation-v1 (PR2): 자동/수동 freeze 시각. is_active=false 와 함께 set. '
  '운영 추적 + admin 해제 SOP 의 단일 진실원. NULL = 정상 활성.';

-- 신고 누적 카운트 핫패스 인덱스. routes/report.ts 가 매 신고마다
-- `SELECT count(*) FROM reports WHERE reported_user_id = X` 를 호출하므로
-- reported_user_id 가 leading column 인 인덱스가 필요.
-- mig 009 에서 reports 의 컬럼명이 `reported_id` 이므로 일관성 유지.
CREATE INDEX IF NOT EXISTS idx_reports_reported_pending
  ON public.reports(reported_id);

-- ========== freeze_events audit table ==========
-- safety-security-reviewer 권고 수용 (사용자 결정): freeze 발동 audit log.
-- 침묵 통지 정책 (외부 통지 X, 앱 내 모달 1회) 의 법적 근거:
--   사용자가 "왜 freeze 됐는지" 추후 CS 채널로 문의 시 reporter_ids/timestamp/
--   report_count_at_trigger 를 근거로 응대 가능.
-- 정보통신망법 21조 통지 의무 / EU AI Act 21조 자동 결정 통지 의무의
-- "자동화된 결정의 근거를 보존" 요건 충족 (05a_safety_policy_for_plan.md 항목 5).
--
-- 컬럼:
--   * frozen_user_id           : 자동 freeze 된 사용자
--   * report_count_at_trigger  : 발동 시점의 총 신고 수 (=레코드 개수)
--   * reporter_ids             : UNIQUE 신고자 ID 배열 (admin 검토용)
--   * triggered_at             : 발동 시각

CREATE TABLE IF NOT EXISTS public.freeze_events (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  frozen_user_id            UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  report_count_at_trigger   INT NOT NULL CHECK (report_count_at_trigger >= 1),
  reporter_ids              UUID[] NOT NULL,
  triggered_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.freeze_events IS
  'message-moderation-v1 (PR2): 자동 freeze 발동 audit log. 침묵 통지 정책의 법적 근거 '
  '(05a_safety_policy_for_plan.md 항목 5). CS 응대 시 사용자가 "왜 freeze" 문의하면 '
  'reporter_ids/timestamp 근거 제공.';

CREATE INDEX IF NOT EXISTS idx_freeze_events_user_at
  ON public.freeze_events(frozen_user_id, triggered_at DESC);

-- RLS: service_role 전용. moderation_blocks (mig 020) 와 동일 정책 — 정책 자체를
-- 두지 않아 anon/authenticated 의 INSERT/SELECT/UPDATE/DELETE 가 모두 deny 된다.
-- 본인이 자기 freeze_events 를 조회하면 어떤 신고자가 신고했는지 노출되어
-- 보복 위험 — service_role (BE/admin) 만 접근.
ALTER TABLE public.freeze_events ENABLE ROW LEVEL SECURITY;

-- Realtime publication 미포함 — FE 가 본 테이블을 realtime 으로 구독할 일 없음.
