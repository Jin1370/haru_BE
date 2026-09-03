import { createClient } from '@supabase/supabase-js';
import { env } from './env';

// Service role client — RLS 우회, 데이터 CRUD 전용
export const supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Fly 머신은 유휴 시 suspend 되고, wake 직후 첫 아웃바운드 호출이 응답 헤더를 못 받아
// undici 기본 headersTimeout(300초)까지 매달리는 일이 있다 (Sentry HARU-BACKEND-5,
// `POST /api/auth/refresh` 의 HeadersTimeoutError). 300초면 FE 는 이미 타임아웃 →
// clearTokens() → 강제 로그아웃. 인증 호출은 전부 짧으므로 15초로 끊어 supabase-js 내장
// 재시도(200/400/800ms 백오프)가 새 커넥션으로 곧바로 복구하게 한다.
// service-role 클라이언트에는 걸지 않는다 — Storage 업로드가 오간다.
//
// 5초인 이유: 이 타임아웃이 노리는 건 "느린 응답" 이 아니라 **죽은 커넥션** 이다.
// suspend 는 메모리 스냅샷이라 wake 후 undici 풀의 keep-alive 소켓이 살아있는 걸로
// 복원되는데, 상대와 중간 NAT 은 이미 그 연결을 잊었다. RST 가 오면 즉시 fetch failed
// 로 튕기지만(HARU-BACKEND-V), 아무 응답도 안 오면 TCP 재전송 타임아웃(분 단위)까지
// 매달린다 — 그때 이 값이 그대로 사용자 대기 시간이 된다 (HARU-BACKEND-X, 옛 15초:
// authMiddleware 1회 재시도까지 30초 > FE 25초 타임아웃이라 FE 가 503 을 받지도 못했다).
// 정상 auth 호출은 수백 ms 라 5초도 10배 이상 여유고, 끊은 만큼 재시도가 빨리 붙는다.
const AUTH_FETCH_TIMEOUT_MS = 5_000;
const authFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
};

// Auth client — 사용자 인증 전용 (anon key 사용, 없으면 service role fallback)
export const supabaseAuth = createClient(
  env.supabase.url,
  env.supabase.anonKey || env.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: authFetch },
  },
);
