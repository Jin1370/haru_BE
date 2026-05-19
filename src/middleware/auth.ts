import { Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { AuthRequest } from '../types';

// 어드민 임퍼소네이션 캐시 — 같은 dev 계정에 반복 호출 시
// auth.admin.getUserById HTTP 콜 절약. 프로세스 lifetime 동안만 유효.
// 출시 빌드에서는 env.admin.dashboardEnabled=false 라 사용 자체가 안 됨.
const devSeedCache = new Map<string, boolean>();

async function isDevSeedAccount(userId: string): Promise<boolean> {
  const cached = devSeedCache.get(userId);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    devSeedCache.set(userId, false);
    return false;
  }
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const ok = meta.is_dev_seed === true;
  devSeedCache.set(userId, ok);
  return ok;
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
    if (typeof providedSecret === 'string' && providedSecret === env.admin.secret) {
      if (typeof impersonate === 'string' && impersonate.length > 0) {
        const ok = await isDevSeedAccount(impersonate);
        if (!ok) {
          res.status(403).json({ error: 'Impersonation allowed only for dev seed accounts' });
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

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    console.error('[Auth] Token verification failed:', error?.message);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.userId = data.user.id;
  next();
}
