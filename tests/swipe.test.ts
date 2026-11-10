// 탐색·받은 좋아요 스와이프 회귀.
//
// (1) POST /api/discover/swipe — 플레이리스트 대화 신청 / 받은 좋아요 탭 / 상대 소멸.
// (2) GET  /api/discover/quota — 유료화 필드만.
// (3) POST /api/discover/likes-received/reveal — 무료 카드.
// (4) splitLikeCards — 받은 좋아요 카드 순서.
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
const envState = vi.hoisted(() => ({
  passResetEnabled: true,
  unlimitedLikeCodes: [] as string[],
  unlimitedLikeCodeDays: 30,
  unlimitedLikeUserIds: [] as string[],
  hiddenUserIds: [] as string[],
  monetizationEnabled: false,
}));
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
    gemini: { apiKey: 'test' },
    monetization: {
      get enabled() {
        return envState.monetizationEnabled;
      },
      revenuecatWebhookAuth: '',
    },
    discover: {
      get passResetEnabled() {
        return envState.passResetEnabled;
      },
      dailyLikeLimit: 15,
      get unlimitedLikeCodes() {
        return envState.unlimitedLikeCodes;
      },
      get unlimitedLikeCodeDays() {
        return envState.unlimitedLikeCodeDays;
      },
      get unlimitedLikeUserIds() {
        return envState.unlimitedLikeUserIds;
      },
      get hiddenUserIds() {
        return envState.hiddenUserIds;
      },
    },
    // 캠페인 봇 비활성 — isCampaignBot() 이 항상 false 라 스와이프 경로는 무영향.
    campaign: { botUserId: null, postUrls: { ko: '', ja: '', en: '' } },
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
  // like 예산 면제 조회 (hasUnlimitedLikes) — 초대코드 + 가입 경과일
  referral: {
    data: null as null | { referral_code: string | null; created_at?: string },
    error: null as null | { message: string },
  },

  // POST /swipe
  existing: { data: null as null | { id: string; reset_at: string | null }, error: null as null | { message: string } },
  // 오늘 플레이리스트 + 멤버십 (source=playlist 대화 신청)
  todayPlaylists: { data: [{ id: 1, idx: 0 }] as Array<{ id: number; idx: number }>, error: null as null | { message: string } },
  member: { data: [{ candidate_id: '22222222-2222-4222-8222-222222222222' }] as Array<{ candidate_id: string }>, error: null as null | { message: string } },
  reveal: { data: null as null | { liker_id: string }, error: null as null | { message: string } },
  lastFree: { data: [] as Array<{ revealed_at: string }>, error: null as null | { message: string } }, // 마지막 무료 카드 사용
  revealInsertPayload: null as null | Record<string, unknown>,
  pinUpsertPayload: null as null | Record<string, unknown>,
  target: { is_active: true, frozen_at: null } as null | { is_active: boolean; frozen_at: string | null }, // 스와이프 상대
  blocks: { data: [] as Array<{ blocker_id: string }>, error: null as null | { message: string } },
  spend: { data: 10 as unknown, error: null as null | { message: string } },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  swipeUpdatePayload: null as null | Record<string, unknown>,
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
    if (t === 'blocks') return captured.blocks;
    if (t === 'discover_playlists') return captured.todayPlaylists;
    if (t === 'discover_playlist_items') return captured.member;
    if (t === 'profiles') {
      if (b._eqs.some((e: any) => e.col === 'id' && e.val === '22222222-2222-4222-8222-222222222222')) {
        return { data: captured.target, error: null };
      }
      // .in() 체인 = 매치 push 의 display_name 조회. 그 외 = freeze 가드 maybeSingle.
      if (b._hasIn) return { data: [], error: null };
      // 파트너 코드 면제 조회 (hasUnlimitedLikes) — freeze 가드와 컬럼으로 구분.
      if (typeof b._cols === 'string' && b._cols.includes('referral_code')) {
        return captured.referral;
      }
      return { data: captured.frozen, error: null };
    }
    if (t === 'swipes') {
      if (b._op === 'insert') return { error: captured.insertError };
      if (b._op === 'delete' || b._op === 'update') return captured.deleteResult;
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
      // 기존 스와이프 조회 (POST /swipe 0단계 — 다시보기 판정)
      if (b._cols === 'id, reset_at') return captured.existing;
      // count 없는 select+single = reciprocal 조회
      return captured.reciprocal;
    }
    if (t === 'like_reveals') {
      if (b._op === 'insert') return { error: null };
      return b._cols === 'revealed_at' ? captured.lastFree : captured.reveal;
    }
    if (t === 'star_ledger') return b._op === 'insert' ? { error: null } : { data: [], error: null };
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
        b._cols = _cols;
        if (opts !== undefined) b._selectOpts = opts;
        return b;
      },
      insert(payload: Record<string, unknown>) {
        b._op = 'insert';
        if (table === 'swipes') captured.swipeInsertPayload = payload;
        if (table === 'like_reveals') captured.revealInsertPayload = payload;
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
        if ((b._op === 'delete' || b._op === 'update') && table === 'swipes') {
          captured.deleteEqCalls.push({ col, val });
        }
        return b;
      },
      update(_payload: Record<string, unknown>, opts?: unknown) {
        b._op = 'update';
        if (table === 'swipes') captured.swipeUpdatePayload = _payload;
        captured.deleteOptions = opts ?? null;
        captured.deleteEqCalls = [];
        return b;
      },
      upsert(payload: Record<string, unknown>) {
        if (table === 'like_card_pins') captured.pinUpsertPayload = payload;
        return b;
      },
      is() { return b; },
      limit() { return b; },
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

  // authMiddleware 가 Bearer 토큰을 supabaseAuth.auth.getUser 로 검증한다
  // (539b5c9 에서 supabase → supabaseAuth 로 이동). 토큰 문자열을 그대로 userId 로
  // 사용 (test 용 단순화).
  async function getUser(token: string) {
    if (!token) {
      return { data: { user: null }, error: { message: 'no token' } };
    }
    return { data: { user: { id: token } }, error: null };
  }

  return {
    supabase: {
      from: (table: string) => makeBuilder(table),
      async rpc(name: string, args: unknown) {
        captured.rpcCalls.push({ name, args });
        if (name === 'spend_stars') return captured.spend;
        return { data: [{ free: 0, paid: 0 }], error: null };
      },
      auth: {
        getUser,
        admin: {
          async getUserById() {
            return { data: { user: null }, error: { message: 'noop' } };
          },
        },
      },
    },
    supabaseAuth: { from: () => makeBuilder('noop'), auth: { getUser } },
  };
});

// app 은 mock 이 hoist 된 뒤 import (vitest hoisting 으로 vi.mock 이 먼저 평가됨).
import { app } from '../src/index';
import { allocatePlaylistTopUp, applyPrefFilters, splitLikeCards } from '../src/routes/swipe';

// supabase.auth.getUser mock 이 토큰 문자열을 그대로 userId 로 반환하므로
// Bearer 값 = userId.
const VIEWER = '11111111-1111-1111-1111-111111111111';
const SWIPED = '22222222-2222-4222-8222-222222222222';
function authToken(userId = VIEWER): string {
  return userId;
}

beforeEach(() => {
  envState.passResetEnabled = true;
  envState.unlimitedLikeCodes = [];
  envState.unlimitedLikeCodeDays = 30;
  envState.unlimitedLikeUserIds = [];
  envState.hiddenUserIds = [];
  captured.frozen = { is_active: true, frozen_at: null };
  captured.referral = { data: null, error: null };
  captured.existing = { data: null, error: null };
  captured.todayPlaylists = { data: [{ id: 1, idx: 0 }], error: null };
  captured.member = { data: [{ candidate_id: SWIPED }], error: null };
  captured.reveal = { data: null, error: null };
  captured.lastFree = { data: [], error: null };
  captured.revealInsertPayload = null;
  captured.pinUpsertPayload = null;
  captured.target = { is_active: true, frozen_at: null };
  captured.blocks = { data: [], error: null };
  captured.spend = { data: 10, error: null };
  captured.rpcCalls = [];
  captured.swipeUpdatePayload = null;
  envState.monetizationEnabled = false;
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

describe('POST /api/discover/swipe — 플레이리스트 대화 신청', () => {
  it('like → source=playlist 로 기록, 한도 없음', async () => {
    captured.reciprocal = { data: null, error: { code: 'PGRST116', message: 'no rows' } };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ direction: 'like', match: null });
    expect(captured.swipeInsertPayload).toMatchObject({ direction: 'like', source: 'playlist' });
  });

  it('상대가 이미 나를 like 했으면 매치 생성', async () => {
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };
    captured.matchInsert = { data: { id: 'match-1', user1_id: VIEWER, user2_id: SWIPED }, error: null };

    const res = await request(app)
      .post('/api/discover/swipe?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, direction: 'like' });

    expect(res.status).toBe(200);
    expect(res.body.match.id).toBe('match-1');
  });
});

describe('GET /api/discover/quota', () => {
  it('유료화 OFF 면 monetization_enabled 만', async () => {
    const res = await request(app)
      .get('/api/discover/quota?tz_offset_minutes=0')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ monetization_enabled: false });
  });
});

describe('POST /api/discover/swipe — 별사탕 유료화 ON (mig 059)', () => {
  const swipe = (body: Record<string, unknown>) =>
    request(app)
      .post('/api/discover/swipe?tz_offset_minutes=-540')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ swiped_id: SWIPED, ...body });

  beforeEach(() => {
    envState.monetizationEnabled = true;
  });

  it.each([
    ['오늘 플레이리스트에 없는 상대', () => { captured.member = { data: [], error: null }; }],
    ['오늘 연 플레이리스트가 없음 (자정 지남)', () => { captured.todayPlaylists = { data: [], error: null }; }],
  ])('%s → 403 not_in_playlist, 기록 없음', async (_label, arrange) => {
    arrange();

    const res = await swipe({ direction: 'like' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_in_playlist');
    expect(captured.swipeInsertPayload).toBeNull();
  });

  it('받은 좋아요 탭 좋아요 — 공개 안 했으면 403 like_not_revealed (무료 카드가 있어도)', async () => {
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };
    captured.reveal = { data: null, error: null };

    const res = await swipe({ direction: 'like', source: 'likes' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('like_not_revealed');
  });

  it('받은 좋아요 탭 좋아요 — 공개했으면 매치', async () => {
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };
    captured.reveal = { data: { liker_id: SWIPED }, error: null };
    captured.matchInsert = { data: { id: 'm1', user1_id: VIEWER, user2_id: SWIPED }, error: null };

    const res = await swipe({ direction: 'like', source: 'likes' });

    expect(res.status).toBe(200);
    expect(res.body.match.id).toBe('m1');
    expect(captured.swipeInsertPayload).toMatchObject({ source: 'likes' });
    expect(captured.revealInsertPayload).toBeNull();
  });

  it.each([
    ['탈퇴', () => { captured.target = { is_active: false, frozen_at: null }; }],
    ['정지', () => { captured.target = { is_active: false, frozen_at: '2026-11-05T00:00:00Z' }; }],
    ['차단', () => { captured.blocks = { data: [{ blocker_id: SWIPED }], error: null }; }],
  ])('%s 상대 — 기록·차감·매치·무료 카드 사용 없이 넘어간다', async (_label, arrange) => {
    arrange();
    captured.reciprocal = { data: { id: 'recip-1' }, error: null };

    const res = await swipe({ direction: 'like', source: 'likes' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ direction: 'like', match: null, skipped: true });
    expect(captured.swipeInsertPayload).toBeNull();
    expect(captured.revealInsertPayload).toBeNull();
    expect(captured.rpcCalls.some((c) => c.name === 'spend_stars')).toBe(false);
  });

  it('다시보기로 돌아온 사람 — 기존 행을 갱신한다', async () => {
    captured.existing = { data: { id: 'row-1', reset_at: '2026-10-01T00:00:00Z' }, error: null };

    const res = await swipe({ direction: 'like' });

    expect(res.status).toBe(200);
    expect(captured.swipeInsertPayload).toBeNull();
    expect(captured.swipeUpdatePayload).toMatchObject({ source: 'playlist', reset_at: null });
  });

  it('이미 스와이프한 사람 (reset 안 됨) → 409', async () => {
    captured.existing = { data: { id: 'row-1', reset_at: null }, error: null };

    const res = await swipe({ direction: 'like' });

    expect(res.status).toBe(409);
  });
});

describe('applyPrefFilters — 나이 상한 (FE 라벨 `40+` 정합)', () => {
  // gte/lte 호출만 기록하는 최소 stub 쿼리.
  function recorder() {
    const calls: { fn: string; col: string; val: any }[] = [];
    const q: any = {
      in(col: string, val: any) { calls.push({ fn: 'in', col, val }); return q; },
      lte(col: string, val: any) { calls.push({ fn: 'lte', col, val }); return q; },
      gte(col: string, val: any) { calls.push({ fn: 'gte', col, val }); return q; },
    };
    return { q, calls };
  }

  it('max_age=40 (슬라이더 상한) 이면 상한 필터를 걸지 않는다 — 41세+ 도 노출', () => {
    const { q, calls } = recorder();
    applyPrefFilters(q, { min_age: 18, max_age: 40 });
    expect(calls.find((c) => c.fn === 'gte')).toBeUndefined();
    // 하한(18세 이상)은 그대로 유지.
    expect(calls.find((c) => c.fn === 'lte')?.col).toBe('birth_date');
  });

  it('max_age=39 이면 상한 필터를 적용한다', () => {
    const { q, calls } = recorder();
    applyPrefFilters(q, { min_age: 18, max_age: 39 });
    expect(calls.find((c) => c.fn === 'gte')?.col).toBe('birth_date');
  });
});

describe('POST /api/discover/likes-received/reveal — 무료 카드', () => {
  const reveal = (body: Record<string, unknown>) =>
    request(app)
      .post('/api/discover/likes-received/reveal')
      .set('Authorization', `Bearer ${authToken(VIEWER)}`)
      .send({ liker_id: SWIPED, ...body });

  beforeEach(() => {
    envState.monetizationEnabled = true;
    captured.reciprocal = { data: { id: 'like-1' }, error: null }; // 상대가 나를 like
  });

  it('무료 기회가 있으면 차감 없이 paid=false 로 공개 기록', async () => {
    const res = await reveal({ free: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revealed: true });
    expect(captured.revealInsertPayload).toEqual({ viewer_id: VIEWER, liker_id: SWIPED, paid: false });
    expect(captured.rpcCalls.some((c) => c.name === 'reveal_like')).toBe(false);
  });

  it('24시간 안에 무료 카드를 이미 봤으면 409 free_unavailable, 기록 없음', async () => {
    captured.lastFree = { data: [{ revealed_at: new Date(Date.now() - 3600_000).toISOString() }], error: null };

    const res = await reveal({ free: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('free_unavailable');
    expect(captured.revealInsertPayload).toBeNull();
  });
});

describe('splitLikeCards — 받은 좋아요 카드 순서', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]; // 점수순

  it('공개한 카드는 공개(본) 시각 순, 그 뒤 미공개자 전원이 점수순', () => {
    const at = new Map([
      ['c', '2026-11-09T10:00:00Z'],
      ['a', '2026-11-09T12:00:00Z'],
    ]);
    const { visible, locked } = splitLikeCards(rows, at, null);
    expect(visible.map((r) => r.id)).toEqual(['c', 'a']);
    expect(locked.map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('고정된 다음 무료 카드는 점수 높은 새 인사가 와도 맨 앞', () => {
    const { locked } = splitLikeCards(rows, new Map(), 'c');
    expect(locked.map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('고정된 카드가 열리면 점수 1위가 맨 앞', () => {
    const { visible, locked } = splitLikeCards(rows, new Map([['c', '2026-11-09T10:00:00Z']]), 'c');
    expect(visible.map((r) => r.id)).toEqual(['c']);
    expect(locked.map((r) => r.id)).toEqual(['a', 'b', 'd']);
  });

  it('모두 공개했으면 잠긴 카드 없음', () => {
    const all = new Map(rows.map((r, i) => [r.id, `2026-11-09T1${i}:00:00Z`]));
    expect(splitLikeCards(rows, all, null).locked).toEqual([]);
  });
});

describe('allocatePlaylistTopUp — 덜 찬 칸 먼저 채우기', () => {
  const ids = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${i}`);

  it('먼저 연 칸부터 10명까지 채우고 남은 후보만 새 칸 몫', () => {
    // 3번 칸(1명)과 7번 칸(2명)을 열어 둔 상태에서 후보 20명이 생김. 입력 순서와 무관하게 id 순.
    const { fills, rest } = allocatePlaylistTopUp([7, 3], new Map([[3, 1], [7, 2]]), ids(20));
    expect(fills).toEqual([
      { playlistId: 3, add: ids(9) },
      { playlistId: 7, add: ids(20).slice(9, 17) },
    ]);
    expect(rest).toEqual(ids(20).slice(17));
  });

  it('꽉 찬 칸은 건너뛰고, 후보가 모자라면 앞 칸만 채운다', () => {
    const { fills, rest } = allocatePlaylistTopUp([1, 2], new Map([[1, 10], [2, 4]]), ids(3));
    expect(fills).toEqual([{ playlistId: 2, add: ids(3) }]);
    expect(rest).toEqual([]);
  });

  it('연 칸이 없으면 전부 새 칸 몫', () => {
    expect(allocatePlaylistTopUp([], new Map(), ids(5))).toEqual({ fills: [], rest: ids(5) });
  });
});
