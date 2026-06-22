-- ============================================================================
-- 039_consent_records.sql
-- ----------------------------------------------------------------------------
-- LAUNCH_CHECKLIST #5 — 동의 기록.
--
-- 가입 시 동의 모달(이용약관 / 개인정보·국외이전 / 음성 생체정보)에서 받은
-- 동의를 서버에 기록한다. 누가·언제·어느 버전에 동의했는지 입증 가능하게 함.
--   * terms_accepted_at      — 약관 + 개인정보(국외이전 포함) 동의 시각
--   * consent_policy_version — 동의 당시 정책/약관 버전 (CONSENT_POLICY_VERSION)
--   * voice_consent_at       — 음성(생체정보) 처리 별도 동의 시각 (PIPA §23)
--
-- 음성 클론(POST /api/voice/clone)은 voice_consent_at 이 set 된 경우에만 허용
-- (server-authoritative — 동의 모달 우회 직접 호출 차단).
--
-- Idempotent + forward-only. Safe to re-run.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS consent_policy_version TEXT        NULL,
  ADD COLUMN IF NOT EXISTS voice_consent_at       TIMESTAMPTZ NULL;
