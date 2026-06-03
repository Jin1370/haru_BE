// discover-pass-reset sprint — DELETE /api/discover/passes 회귀.
//
// 기능: viewer 의 direction='pass' 스와이프 행 일괄 삭제 → pass 했던 후보 재등장.
//   * like 행·매치 무변경 (direction='pass' eq 로 본인 pass 행만 타겟)
//   * IDOR 차단 (.eq('swiper_id', viewer))
//   * env 게이트 (DISCOVER_PASS_RESET_ENABLED=false → 403 pass_reset_disabled)
//   * { count: 'exact' } 삭제 행 수 반환
//
// 라이브 DB(live integration) 대신 모듈 경계 mock 패턴 — voiceIntroModeration.test.ts
// 와 동일. supabase / env 를 hoisted mock 으로 잡아 (a) delete 쿼리 체인에 정확히
// swiper_id + direction='pass' eq 가 걸리는지 (b) env 토글 시 403 분기를 검증.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── env mock (mutable) — passResetEnabled 를 per-test 토글 ──
const envState = vi.hoisted(() => ({ passResetEnabled: true }));
vi.mock('../src/config/env', () => ({
  env: {
    port: 3000,
    nodeEnv: 'test',
    supabase: {
      url: 'http://localhost',
      serviceRoleKey: 'test-service-role',
      anonKey: '',
      jwtSecret: 'test-jwt-secret',
    },
    elevenlabs: { apiKey: 'test' },
    openai: { moderationApiKey: '' },
    image: { azureBaseUrl: '', azureApiKey: '', azureApiVersion: '2025-04-01-preview' },
    vertexAi: { projectId: 'test', location: 'us-central1' },
    discover: {
      get passResetEnabled() {
        return envState.passResetEnabled;
      },
    },
    admin: { dashboardEnabled: false, secret: '' },
    moderation: { autoFreezeReportThreshold: 3 },
    voice: { recloneMonthlyCap: 2, recloneWindowDays: 30 },
    auth: { emailConfirmRedirectUrl: 'http://localhost/cb' },
  },
}));

// ── supabase mock — profiles(select for requireNotFrozen) + swipes(delete) ──
const captured = vi.hoisted(() => ({
  deleteEqCalls: [] as Array<{ col: string; val: unknown }>,
  deleteOptions: null as unknown,
  deleteResult: { count: 0, error: null as null | { message: string } },
}));

vi.mock('../src/config/supabase', () => {
  function makeBuilder(table: string): any {
    const builder: any = {
      _table: table,
      _op: 'select' as 'select' | 'delete',
      select(_cols?: string) {
        builder._op = 'select';
        return builder;
      },
      delete(opts?: unknown) {
        builder._op = 'delete';
        captured.deleteOptions = opts ?? null;
        captured.deleteEqCalls = [];
        return builder;
      },
      eq(col: string, val: unknown) {
        if (builder._op === 'delete' && table === 'swipes') {
          captured.deleteEqCalls.push({ col, val });
        }
        return builder;
      },
      // requireNotFrozen: profiles.select(...).eq(...).maybeSingle()
      async maybeSingle() {
        // not frozen
        return { data: { is_active: true, frozen_at: null }, error: null };
      },
      // route: swipes.delete().eq().eq() awaited directly (thenable)
      then(resolve: any) {
        if (table === 'swipes' && builder._op === 'delete') {
          return Promise.resolve(captured.deleteResult).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return builder;
  }
  return {
    supabase: {
      from: (table: string) => makeBuilder(table),
      auth: {
        // authMiddleware 가 Bearer 토큰을 supabase.auth.getUser 로 검증.
        // 토큰 문자열을 그대로 userId 로 사용 (test 용 단순화).
        async getUser(token: string) {
          if (!token) {
            return { data: { user: null }, error: { message: 'no token' } };
          }
          return { data: { user: { id: token } }, error: null };
        },
        admin: {
          async getUserById() {
            return { data: { user: null }, error: { message: 'noop' } };
          },
        },
      },
    },
    supabaseAuth: { from: () => makeBuilder('noop') },
  };
});

// app 은 mock 이 hoist 된 뒤 import (vitest hoisting 으로 vi.mock 이 먼저 평가됨).
import { app } from '../src/index';

// supabase.auth.getUser mock 이 토큰 문자열을 그대로 userId 로 반환하므로
// Bearer 값 = userId.
const VIEWER = '11111111-1111-1111-1111-111111111111';
function authToken(userId = VIEWER): string {
  return userId;
}

beforeEach(() => {
  envState.passResetEnabled = true;
  captured.deleteEqCalls = [];
  captured.deleteOptions = null;
  captured.deleteResult = { count: 0, error: null };
});

describe('DELETE /api/discover/passes — pass 스와이프 리셋', () => {
  it('(a) 정상 삭제 + reset_count 반환', async () => {
    captured.deleteResult = { count: 7, error: null };
    const res = await request(app)
      .delete('/api/discover/passes')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset_count: 7 });
    // { count: 'exact' } 옵션이 delete 에 전달됐는지
    expect(captured.deleteOptions).toEqual({ count: 'exact' });
  });

  it('(b) 비인증 → 401', async () => {
    const res = await request(app).delete('/api/discover/passes');
    expect(res.status).toBe(401);
  });

  it('(c) env 비활성 → 403 pass_reset_disabled', async () => {
    envState.passResetEnabled = false;
    const res = await request(app)
      .delete('/api/discover/passes')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pass_reset_disabled');
    // 비활성 시 delete 쿼리 자체가 실행되지 않아야 함 (라우트 진입 전 차단)
    expect(captured.deleteEqCalls).toHaveLength(0);
  });

  it('(d) like 행/매치 미삭제 보장 — delete 쿼리에 direction=pass eq 가 걸린다', async () => {
    captured.deleteResult = { count: 3, error: null };
    await request(app)
      .delete('/api/discover/passes')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    const directionEq = captured.deleteEqCalls.find((c) => c.col === 'direction');
    expect(directionEq).toBeDefined();
    expect(directionEq!.val).toBe('pass');
    // like 를 타겟하는 eq 는 절대 없어야 함
    expect(captured.deleteEqCalls.some((c) => c.val === 'like')).toBe(false);
  });

  it('(e) IDOR 차단 — 본인 swiper_id 만 삭제', async () => {
    captured.deleteResult = { count: 1, error: null };
    await request(app)
      .delete('/api/discover/passes')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    const swiperEq = captured.deleteEqCalls.find((c) => c.col === 'swiper_id');
    expect(swiperEq).toBeDefined();
    expect(swiperEq!.val).toBe(VIEWER);
  });

  it('(f) supabase delete error → 500 가시화 (silent-success 금지)', async () => {
    captured.deleteResult = { count: 0, error: { message: 'db down' } };
    const res = await request(app)
      .delete('/api/discover/passes')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db down');
  });
});
