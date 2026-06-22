-- ============================================================================
-- 038_birth_date_adult_check.sql
-- ----------------------------------------------------------------------------
-- LAUNCH_CHECKLIST #2 — 서버측 만 18세 미만 차단의 최종 방어선.
--
-- BE 는 zod (profileUpsertSchema 의 캘린더 검증 + 라우트의 422 나이 게이트) 로
-- 1차 차단하지만, BE 는 service_role 키를 쓰므로 RLS 는 우회한다. CHECK 제약은
-- service_role 도 우회하지 못하므로, BE 코드 버그/누락으로 미성년 row 가 들어가는
-- 것까지 막는다.
--
-- CURRENT_DATE 는 STABLE 함수라 CHECK 가 retroactive 하게 재검증되지 않고
-- INSERT/UPDATE 시점에만 평가된다 — 신규/수정 row 만 게이트하려는 의도와 정확히
-- 일치한다. birth_date 는 DATE NOT NULL (mig 001) 이라 NULL 예외 처리 불필요.
--
-- 적용 전제: 현재 18세 미만 회원 없음(사용자 확인 2026-06-22). 기존 위반 row 가
-- 있으면 ADD CONSTRAINT 가 즉시 실패하므로, 그 경우 먼저 데이터 정리 필요.
--
-- Idempotent + forward-only. Safe to re-run.
-- ============================================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_birth_date_adult_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_birth_date_adult_check
  CHECK (birth_date <= CURRENT_DATE - INTERVAL '18 years');
