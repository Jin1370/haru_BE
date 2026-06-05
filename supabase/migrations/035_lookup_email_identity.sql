-- ========== signup latency: email existence probe ==========
--
-- 회원가입 핸들러(routes/auth.ts)의 findEmailIdentity 가 "이미 가입·확인된
-- 사용자가 재가입을 시도하는지" 판별하려고 admin.listUsers 를 페이지당 1000명씩
-- 순차 스캔했다 (최대 50페이지). 신규 유저는 정렬상 뒤쪽 페이지에 있을 수 있어
-- 매 가입마다 수백 ms ~ 수 초가 가산되고, robo/테스트 계정이 쌓일수록 악화된다.
-- auth.users 는 email UNIQUE 인덱스가 있으므로 단건 조회로 O(1) 처리한다.
-- (auth.ts:79 의 TODO "SELECT ... FROM auth.users WHERE email = $1" 를 정산.)
--
-- SECURITY DEFINER: auth.users 는 auth 스키마(소유 supabase_auth_admin) 라
--   service_role 직접 SELECT 권한이 없을 수 있다. 함수 소유자(postgres) 권한으로
--   실행해 auth.users 를 읽는다. search_path='' 로 검색 경로 오염 차단(식별자 전부
--   스키마 한정).
--
-- 권한: service_role 만 (mig 028/030 RPC 정책과 동일). BE 가 service_role client 로
--   호출. 함수가 이메일 존재/확인 여부 2비트만 반환하므로 enumeration 표면 최소.
--
-- forward-only. mig 001~034 수정 금지.

CREATE OR REPLACE FUNCTION public.lookup_email_identity(p_email TEXT)
RETURNS TABLE (user_exists BOOLEAN, is_confirmed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    COUNT(*) > 0                                              AS user_exists,
    COALESCE(bool_or(u.email_confirmed_at IS NOT NULL), FALSE) AS is_confirmed
  FROM auth.users u
  WHERE lower(u.email) = lower(p_email);
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_email_identity(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lookup_email_identity(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.lookup_email_identity(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_email_identity(TEXT) TO service_role;
