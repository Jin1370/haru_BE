// discover-pass-reset + discover-like-limit sprint 회귀.
//
// (1) DELETE /api/discover/passes — pass 스와이프 리셋 (기존 6케이스).
// (2) POST /api/discover/swipe — 하루 like 예산 캡 + 매치완성 like/pass 면제 (신규).
// (3) GET  /api/discover/quota — 오늘 소모한 like 예산 카운트 (신규).
//
// 라이브 DB(live integration) 대신 모듈 경계 mock 패턴 — voiceIntroModeration.test.ts
// 와 동일. supabase / env / pushNotifications 를 hoisted mock 으로 잡아
//   * pass 삭제 쿼리 체인(swiper_id + direction='pass' eq)
//   * like 예산 소모 여부(counts_toward_limit) 가 swipe 시점에 확정 저장되는지
//   * 매치 완성 like / pass 가 캡을 우회(면제)하는지
//   * quota count 가 캡과 동일 정의(direction='like' AND counts_toward_limit=true)로 세는지
// 를 검증한다.

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
      dailyLikeLimit: 15,
    },
    admin: { dashboardEnabled: false, secret: '' },
    moderation: { autoFreezeReportThreshold: 3 },
    voice: { recloneMonthlyCap: 2, recloneWindowDays: 30 },
    auth: { emailConfirmRedirectUrl: 'http://localhost/cb' },
    // rateLimit 미들웨어가 src/index.ts import 시점에 읽는다 — 누락 시 suite 로드 실패.
    rateLimit: {
      authWindowMin: 15,
      authMax: 50,
      waitlistWindowMin: 60,
      waitlistMax: 30,
    },
  },
}));

// 매치 성사 시 fire-and-forget 로 호출되는 push — 실 네트워크 회피용 no-op mock.
vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

// ── supabase mock — 라우트별 쿼리 체인을 table + op + eq/opts 로 분기해 결과 반환 ──
const captured = vi.hoisted(() => ({
  // 공통 (freeze 가드)
  frozen: { is_active: true as boolean, frozen_at: null as null | string },

  // POST /swipe
  reciprocal: { data: null as null | { id: string }, error: null as null | { code?: string; message: string } },
  budgetCount: { count: 0, error: null as null | { message: string } }, // counts_toward_limit=true count (cap + quota-like)
  passCount: { count: 0, error: null as null | { message: string } },   // direction='pass' count (quota only)
  insertError: null as null | { code?: string; message: string },       // swipes insert
  matchInsert: { data: null as null | Record<string, unknown>, error: null as null | { code?: string; message: string } },
  matchExisting: { data: null as null | Record<string, unknown>, error: null as null | { message: string } },

  // DELETE /passes
  deleteResult: { count: 0, error: null as null | { message: string } },

  // captured artifacts
  swipeInsertPayload: null as null | Record<string, unknown>,
  budgetCountEqs: [] as Array<{ col: string; val: unknown }>,
  deleteEqCalls: [] as Array<{ col: string; val: unknown }>,
  deleteOptions: null as unknown,
}));

vi.mock('../src/config/supabase', () => {
  function resolveTerminal(b: any): any {
    const t = b._table;
    if (t === 'profiles') {
      // .in() 체인 = 매치 push 의 display_name 조회. 그 외 = freeze 가드 maybeSingle.
      if (b._hasIn) return { data: [], error: null };
      return { data: captured.frozen, error: null };
    }
    if (t === 'swipes') {
      if (b._op === 'insert') return { error: captured.insertError };
      if (b._op === 'delete') return captured.deleteResult;
      // select
      const hasCount = b._selectOpts && b._selectOpts.count;
      if (hasCount) {
        if (b._eqs.some((e: any) => e.col === 'direction' && e.val === 'pass')) {
          return captured.passCount;
        }
        // counts_toward_limit=true 예산 count (POST 캡 + GET quota-like 공유)
        captured.budgetCountEqs = b._eqs;
        return captured.budgetCount;
      }
      // count 없는 select+single = reciprocal 조회
      return captured.reciprocal;
    }
    if (t === 'matches') {
      if (b._op === 'insert') return captured.matchInsert;
      return captured.matchExisting;
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select' as 'select' | 'insert' | 'delete',
      _selectOpts: undefined as unknown,
      _eqs: [] as Array<{ col: string; val: unknown }>,
      _hasIn: false,
      select(_cols?: string, opts?: unknown) {
        if (b._op !== 'insert' && b._op !== 'delete') b._op = 'select';
        if (opts !== undefined) b._selectOpts = opts;
        return b;
      },
      insert(payload: Record<string, unknown>) {
        b._op = 'insert';
        if (table === 'swipes') captured.swipeInsertPayload = payload;
        return b;
      },
      delete(opts?: unknown) {
        b._op = 'delete';
        captured.deleteOptions = opts ?? null;
        captured.deleteEqCalls = [];
        return b;
      },
      eq(col: string, val: unknown) {
        b._eqs.push({ col, val });
        if (b._op === 'delete' && table === 'swipes') {
          captured.deleteEqCalls.push({ col, val });
        }
        return b;
      },
      gte() { return b; },
      lt() { return b; },
      in() { b._hasIn = true; return b; },
      or() { return b; },
      order() { return b; },
      async single() { return resolveTerminal(b); },
      async maybeSingle() { return resolveTerminal(b); },
      then(resolve: any) { return Promise.resolve(resolveTerminal(b)).then(resolve); },
    };
    return b;
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
const SWIPED = '22222222-2222-4222-8222-222222222222';
function authToken(userId = VIEWER): string {
  return userId;
}

beforeEach(() => {
  envState.passResetEnabled = true;
  captured.frozen = { is_active: true, frozen_at: null };
  captured.reciprocal = { data: null, error: null };
  captured.budgetCount = { count: 0, error: null };
  captured.passCount = { count: 0, error: null };
  captured.insertError = null;
  captured.matchInsert = { data: null, error: null };
  captured.matchExisting = { data: null, error: null };
  captured.deleteResult = { count: 0, error: null };
  captured.swipeInsertPayload = null;
  captured.budgetCountEqs = [];
  captured.deleteEqCalls = [];
  captured.deleteOptions = null;
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

describe('POST /api/discover/swipe — 하루 like 예산 캡 + 면제', () => {
  it('(1) non-reciprocal like → counts_toward_limit=true 저장 + 예산<15 통과', async () => {
    captured.reciprocal = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    captured.budgetCount = { count: 5, error: null };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ direction: 'like', match: null });
    // 예산 소모 like 는 swipe 시점에 counts_toward_limit=true 확정 저장.
    expect(captured.swipeInsertPayload).not.toBeNull();
    expect(captured.swipeInsertPayload!.counts_toward_limit).toBe(true);
    // 캡 count 쿼리가 실제로 실행됐는지 (예산 소모 경로)
    expect(captured.budgetCountEqs.length).toBeGreaterThan(0);
  });

  it('(2) reciprocal like → 캡 스킵 + counts_toward_limit=false + 매치 생성 (면제)', async () => {
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };
    captured.budgetCount = { count: 99, error: null }; // 초과값 — 스킵돼야 함
    captured.matchInsert = {
      data: { id: 'match-1', user1_id: VIEWER, user2_id: SWIPED },
      error: null,
    };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(200);
    expect(res.body.match).toBeTruthy();
    expect(res.body.match.id).toBe('match-1');
    // 매치 완성 like 는 예산 면제 → counts_toward_limit=false.
    expect(captured.swipeInsertPayload!.counts_toward_limit).toBe(false);
    // 캡 count 쿼리 자체가 실행되지 않음 (consumesBudget=false → 스킵).
    expect(captured.budgetCountEqs).toHaveLength(0);
  });

  it('(3) 예산 소진(15) + non-reciprocal like → 429 daily_limit_reached', async () => {
    captured.reciprocal = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    captured.budgetCount = { count: 15, error: null };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('daily_limit_reached');
    // 캡 초과 시 INSERT 는 실행되지 않아야 함.
    expect(captured.swipeInsertPayload).toBeNull();
  });

  it('(4) 예산 소진(15) + reciprocal like → 429 아님, 통과 + 매치 (면제가 캡 우회)', async () => {
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };
    captured.budgetCount = { count: 15, error: null }; // 소진이지만 면제라 무관
    captured.matchInsert = {
      data: { id: 'match-2', user1_id: VIEWER, user2_id: SWIPED },
      error: null,
    };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(200);
    expect(res.body.match).toBeTruthy();
    expect(captured.swipeInsertPayload!.counts_toward_limit).toBe(false);
    expect(captured.budgetCountEqs).toHaveLength(0);
  });

  it('(5) pass → 캡 스킵 + counts_toward_limit=false (예산 15여도 통과)', async () => {
    captured.budgetCount = { count: 15, error: null };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'pass' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ direction: 'pass', match: null });
    expect(captured.swipeInsertPayload!.counts_toward_limit).toBe(false);
    // pass 는 reciprocal 조회도 캡 count 도 실행 안 함.
    expect(captured.budgetCountEqs).toHaveLength(0);
  });
});

describe('GET /api/discover/quota — 오늘 소모한 like 예산', () => {
  it('(6) count 쿼리에 direction=like + counts_toward_limit=true eq 체인 + limit=env(15)', async () => {
    captured.budgetCount = { count: 3, error: null };
    captured.passCount = { count: 2, error: null };

    const res = await request(app)
      .get('/api/discover/quota?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(15);
    expect(res.body.count).toBe(3);
    expect(res.body.remaining).toBe(12);

    // 예산 count 가 캡과 동일 정의(direction='like' AND counts_toward_limit=true)로
    // 세는지 — 정의 불일치("3/15인데 막힘") 구조적 차단 검증.
    const eqs = captured.budgetCountEqs;
    expect(eqs.find((e) => e.col === 'swiper_id')?.val).toBe(VIEWER);
    expect(eqs.find((e) => e.col === 'direction')?.val).toBe('like');
    expect(eqs.find((e) => e.col === 'counts_toward_limit')?.val).toBe(true);
  });
});
