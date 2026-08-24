// 인증 실패 분류 회귀 (2026-08-21, Sentry HARU-BACKEND-K).
//
// GET /api/discover 처리 중 supabase.auth.getUser 가 HeadersTimeoutError 로
// 깨졌다. 그때 401 을 내려보내면 FE 가 "세션 만료" 로 읽고 refresh → (같은
// 순단이라 refresh 도 실패) → onSessionExpired → 실유저 로그아웃까지 간다.
// 도달 실패는 503 이어야 세션이 살아남는다.

import { describe, it, expect } from 'vitest';
import { isTransientAuthError } from '../src/middleware/auth';

describe('isTransientAuthError', () => {
  it('Supabase Auth 도달 실패 (AuthRetryableFetchError) → 일시적', () => {
    expect(isTransientAuthError({ name: 'AuthRetryableFetchError', status: 0 })).toBe(true);
  });

  it('status 0 만 있어도 일시적 — 도달 못 했다는 뜻', () => {
    expect(isTransientAuthError({ name: 'AuthUnknownError', status: 0 })).toBe(true);
  });

  it('만료/무효 토큰 (401) 은 일시적이 아님 — 기존 401 경로 유지', () => {
    expect(isTransientAuthError({ name: 'AuthApiError', status: 401 })).toBe(false);
    expect(isTransientAuthError({ name: 'AuthApiError', status: 403 })).toBe(false);
  });

  it('에러 없음 → false', () => {
    expect(isTransientAuthError(null)).toBe(false);
    expect(isTransientAuthError(undefined)).toBe(false);
  });
});
