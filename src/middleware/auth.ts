import { Response, NextFunction } from 'express';
import { supabase, supabaseAuth } from '../config/supabase';
import { env } from '../config/env';
import { resolveAdminOperator } from '../routes/admin';
import { AuthRequest } from '../types';

// 어드민 임퍼소네이션 캐시 — 같은 dev 계정에 반복 호출 시
// auth.admin.getUserById HTTP 콜 절약. 프로세스 lifetime 동안만 유효.
// 출시 빌드에서는 env.admin.dashboardEnabled=false 라 사용 자체가 안 됨.
const devSeedCache = new Map<string, { isSeed: boolean; owner: string | null }>();

// dev seed 여부 + 소유 운영자(user_metadata.dev_owner) 를 함께 캐시.
async function loadDevSeedInfo(
  userId: string,
): Promise<{ isSeed: boolean; owner: string | null }> {
  const cached = devSeedCache.get(userId);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    const miss = { isSeed: false, owner: null };
    devSeedCache.set(userId, miss);
    return miss;
  }
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const info = {
    isSeed: meta.is_dev_seed === true,
    owner: typeof meta.dev_owner === 'string' ? meta.dev_owner : null,
  };
  devSeedCache.set(userId, info);
  return info;
}

// Supabase Auth 에 **도달 자체를 못한** 실패인지 판정. auth-js 는 이 경우
// AuthRetryableFetchError (status 0) 를 돌려준다 — 토큰이 무효한 401/403 과는
// 성격이 정반대라 응답 코드를 갈라야 한다. isAuthRetryableFetchError 는 런타임에
// 존재하지만 supabase-js 타입 선언에 없어 형태로 판정한다.
export function isTransientAuthError(
  error: { name?: string; status?: number } | null | undefined,
): boolean {
  if (!error) return false;
  return error.name === 'AuthRetryableFetchError' || error.status === 0;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // ===== 어드민 임퍼소네이션 경로 (dev/QA 전용) =====
  //
  // 활성 조건 (3중 게이트):
  //   1. ADMIN_DASHBOARD_ENABLED=true (env)
  //   2. X-Admin-Secret 헤더가 ADMIN_SECRET 와 일치
  //   3. X-Admin-Impersonate user_id 의 user_metadata.is_dev_seed === true
  //      (실유저 임퍼소네이션 차단 — 사쿠라 방지)
  //
  // 정상 동작:
  //   * 위 3개 모두 통과 → req.userId = impersonate target, next()
  //   * 1·2 통과 + 3 실패 → 403 (실유저 임퍼소네이션 시도 차단)
  //   * 1·2 중 하나라도 실패 → 일반 JWT 경로로 fallthrough
  if (env.admin.dashboardEnabled) {
    const providedSecret = req.headers['x-admin-secret'];
    const impersonate = req.headers['x-admin-impersonate'];
    const operator = resolveAdminOperator(req.headers['x-admin-user'], providedSecret);
    if (operator !== undefined) {
      if (typeof impersonate === 'string' && impersonate.length > 0) {
        const info = await loadDevSeedInfo(impersonate);
        if (!info.isSeed) {
          res.status(403).json({ error: 'Impersonation allowed only for dev seed accounts' });
          return;
        }
        // 소유자 격리 — 목록에서 가려도 id 만 알면 직접 호출할 수 있으므로 여기서 강제.
        if (operator !== null && info.owner !== operator) {
          res.status(403).json({ error: 'This dev account belongs to another operator' });
          return;
        }
        req.userId = impersonate;
        next();
        return;
      }
      // secret 만 있고 impersonate 가 없으면 일반 경로로 fallthrough
      // (예: 어드민 로그인 검증 라우트는 별도 처리)
    }
  }

  // ===== 일반 JWT 경로 (기존 동작) =====
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  // supabaseAuth 를 쓰는 이유: config/supabase.ts 의 15초 fetch 타임아웃이 걸린
  // 클라이언트다. 인증 호출이 undici 기본 headersTimeout(300초)까지 매달리면
  // FE 는 이미 타임아웃 → 로그아웃이다.
  //
  // 1회 재시도: undici 는 유휴 keep-alive 소켓이 끊긴 걸 다음 요청에서야 알아채고
  // TypeError: fetch failed 로 던진다 (Fly 머신 suspend/wake 직후에 잦다 —
  // Sentry HARU-BACKEND-V, GET /api/matches). 새 커넥션으로 한 번 더 보내면 그대로
  // 성공하므로 503 을 내리기 전에 딱 한 번 다시 시도한다. auth-js 의 _getUser 는
  // 자체 재시도가 없어 여기서 해야 한다. 지연 없이 즉시 — 소켓 문제라 기다릴 이유가 없다.
  let { data, error } = await supabaseAuth.auth.getUser(token);
  if (isTransientAuthError(error)) {
    ({ data, error } = await supabaseAuth.auth.getUser(token));
  }

  // "토큰이 무효하다" 와 "지금 확인을 못 했다" 를 구분한다.
  //
  // supabase-js 는 Supabase Auth 에 도달조차 못한 경우(네트워크 순단, DNS,
  // HeadersTimeoutError)도 error 로 돌려주는데, 이걸 401 로 뭉뚱그리면 FE 가
  // "세션 만료" 로 해석해 refresh → (같은 순단이라 refresh 도 실패) →
  // onSessionExpired → **실유저 로그아웃** 까지 간다. 몇 초짜리 네트워크
  // 딸꾹질이 로그아웃 사고가 되는 셈 (2026-08-21 HARU-BACKEND-K:
  // GET /api/discover 의 auth.getUser 가 HeadersTimeoutError).
  //
  // 도달 실패는 503 — FE 의 401 분기를 안 타므로 세션이 유지되고, 사용자는
  // 화면을 다시 당기면 된다.
  if (isTransientAuthError(error)) {
    console.error('[Auth] Auth service unreachable:', error?.message);
    res.status(503).json({ error: 'Auth service temporarily unavailable' });
    return;
  }

  if (error || !data.user) {
    // 만료/무효 토큰은 클라이언트 정상 상태 (FE 가 401 → refresh → 재시도) —
    // warn 으로 남겨 Sentry(captureConsole error-only) 이벤트에서 제외.
    console.warn('[Auth] Token verification failed:', error?.message);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.userId = data.user.id;
  recordDailyActive(data.user.id);
  next();
}

// DAU 기록 (mig 057). 사용자당 하루 1 회만 DB 에 쓴다 — 응답은 기다리지 않는다.
// 날짜는 KST (주 사용자 한·일 모두 UTC+9). 임퍼소네이션 경로는 기록 안 함.
// ponytail: 인스턴스별 메모리 Set 이라 재시작/다중 머신이면 하루 몇 번 더 쓴다 —
// PK (user_id, day) + ignoreDuplicates 라 중복 행은 안 생겨 무해.
let dauDay = '';
const dauSeen = new Set<string>();

export function kstDay(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

export function recordDailyActive(userId: string): void {
  const day = kstDay();
  if (day !== dauDay) {
    dauDay = day;
    dauSeen.clear();
  }
  if (dauSeen.has(userId)) return;
  dauSeen.add(userId);
  // 실패해도 재시도 안 함 (그 인스턴스에서 그날 1 번만 로그) — mig 미적용 시
  // 매 요청 에러 로그가 Sentry 로 쏟아지는 걸 막는다.
  supabase
    .from('daily_active_users')
    .upsert({ user_id: userId, day }, { onConflict: 'user_id,day', ignoreDuplicates: true })
    .then(({ error }) => {
      if (error) console.error('[dau] upsert failed', error.message);
    });
}
