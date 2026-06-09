-- ========== launch waitlist signups ==========
-- 랜딩페이지(haru_FE/web) 상단의 "무료 체험" 대기자 모집 폼이 INSERT 하는 테이블.
--
-- 수집 항목은 최소화: 메일 주소 + 기종(자유 텍스트) + 로케일 + timestamp 뿐.
-- 아직 가입 유저가 아니므로 profiles FK 없음 (auth.users 와 무관) — 따라서
-- auth.ts:deleteAccount 의 user-linked 동기 정리 룰 대상이 아니다.
--
-- 이메일은 PII 라 RLS service_role 전용 (moderation_blocks 패턴 동일):
--   정책을 두지 않아 anon/authenticated 의 SELECT/INSERT 모두 deny.
--   BE 가 service_role key 로 INSERT 한다 (routes/waitlist.ts).
-- 출시 후 정리/보존 정책(예: 출시 연락 완료분 삭제)은 운영 수동 또는 후속 크론.

CREATE TABLE IF NOT EXISTS public.waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  device_model TEXT NOT NULL,
  locale       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.waitlist IS
  '랜딩페이지 출시 대기자 모집 폼 수집 (email + device_model). 가입 유저 아님(profiles FK 없음). '
  'RLS service_role 전용. 보존/정리는 운영 정책.';

-- 같은 메일 재제출은 폭주 방지를 위해 upsert(onConflict email)로 흡수.
-- email 은 라우트에서 lowercase+trim 정규화 후 저장하므로 평문 UNIQUE 로 충분.
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email
  ON public.waitlist(email);

-- RLS: service_role 전용 — 정책 없음 = 모든 비-service_role 접근 deny.
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
