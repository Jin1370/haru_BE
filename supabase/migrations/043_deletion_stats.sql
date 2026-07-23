-- 탈퇴 시점 활동 요약 스냅샷 (deletion_stats).
--
-- 배경:
--   deleteAccount 가 swipes / user_preferences / profile_photos 를 즉시 삭제하고
--   profiles 를 anonymize 하므로, "가입 직후 이탈한 유저가 탈퇴 전에 뭘 해봤는지"
--   (스와이프는 해봤는지, 보이스 클론은 만들었는지) 를 사후에 알 방법이 없다.
--   raw row 를 일정 기간 보존하는 대신, 탈퇴 라우트가 지우기 전에 카운트/boolean
--   만 세서 1 row 스냅샷으로 남긴다 — PIPA §3 / GDPR Art.5(1)(c) 최소화 정합.
--
-- 보존:
--   cleanupAuditTables.ts 의 365 일 sweep 에 등록 (deleted_at 기준).
--   moderation_blocks / freeze_events / reports / blocks 와 동일 정책.
--
-- 격리:
--   RLS 정책 0개 → anon/authenticated 전면 deny. service_role(BE)만 접근.
--   FK ON DELETE CASCADE 는 dev 계정 hard delete(cleanup-dev-accounts) 정리용
--   — 실유저 deleteAccount 는 profiles 를 anonymize 만 하므로 미발화.

CREATE TABLE public.deletion_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  swipe_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  received_like_count INTEGER NOT NULL DEFAULT 0,
  had_voice_clone BOOLEAN NOT NULL DEFAULT false,
  had_voice_intro BOOLEAN NOT NULL DEFAULT false,
  photo_count INTEGER NOT NULL DEFAULT 0,
  preferences_set BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE public.deletion_stats ENABLE ROW LEVEL SECURITY;
-- 정책을 의도적으로 만들지 않는다 → deny-by-default.
