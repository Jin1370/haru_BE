// message-reactions 회귀.
//
// PUT /api/matches/:matchId/messages/:messageId/reaction
//   * 403 매치 비참여자
//   * 404 다른 매치의 메시지 id (match_id 정합성)
//   * 403 본인 발신 메시지 (리액션 주체 = 발신자의 반대편 이라는 전제 보호)
//   * 200 리액션 set / null 해제 (UPDATE payload 검증)
//   * 400 허용되지 않은 값 (zod enum)
//   * 500 UPDATE error 가시화 (mig 054 미적용 같은 schema drift 를 silent-success
//     로 가리지 않는지 — 200 이면 FE 낙관 업데이트가 그대로 굳는다)
//
// 라이브 DB 히트 회피 — swipe.test.ts / messageIdempotent.test.ts 와 동일한
// 모듈 경계 hoisted mock 패턴.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── env mock ──
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
    discover: { passResetEnabled: true, dailyLikeLimit: 15 },
    campaign: { botUserId: null, postUrls: { ko: '', ja: '', en: '' } },
    admin: { dashboardEnabled: false, secret: '' },
    moderation: { autoFreezeReportThreshold: 3 },
    voice: { recloneMonthlyCap: 2, recloneWindowDays: 30 },
    auth: { emailConfirmRedirectUrl: 'http://localhost/cb' },
    rateLimit: {
      authWindowMin: 15,
      authMax: 50,
      waitlistWindowMin: 60,
      waitlistMax: 30,
    },
  },
}));

// ── 파이프라인 외부 서비스 mock (본 라우트는 안 타지만 import 시점 초기화 회피) ──
vi.mock('../src/constants/moderationDictionary', () => ({
  isBlocked: () => ({ blocked: false }),
}));
vi.mock('../src/services/openaiModeration', () => ({
  checkOpenAiModeration: vi.fn(async () => ({ blocked: false })),
}));
vi.mock('../src/utils/moderationAudit', () => ({
  logModerationBlock: vi.fn(),
}));
vi.mock('../src/services/translation', () => ({
  translateMessage: vi.fn(async () => ({ translation: 'hello' })),
}));
vi.mock('../src/services/elevenlabs', () => ({
  synthesizeSpeech: vi.fn(async () => Buffer.from('audio')),
}));
vi.mock('../src/services/storage', () => ({
  uploadFile: vi.fn(async () => 'https://cdn/audio.mp3'),
}));
vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

// ── supabase mock ──
const VIEWER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

const captured = vi.hoisted(() => ({
  frozen: { is_active: true as boolean, frozen_at: null as null | string },
  match: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  // messages select(id, sender_id) — match_id 정합성 포함
  messageSelect: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  // messages update(...).select().single()
  updateResult: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  updatePayloads: [] as Record<string, unknown>[],
  updateEqs: [] as Array<{ col: string; val: unknown }>,
}));

vi.mock('../src/config/supabase', () => {
  function resolveTerminal(b: any): any {
    const t = b._table;
    if (t === 'matches') return captured.match;
    if (t === 'blocks') return { data: [], error: null };
    if (t === 'profiles') return { data: captured.frozen, error: null };
    if (t === 'messages') {
      if (b._op === 'update') {
        captured.updatePayloads.push(b._payload);
        captured.updateEqs = b._eqs;
        return captured.updateResult;
      }
      return captured.messageSelect;
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select' as 'select' | 'update',
      _eqs: [] as Array<{ col: string; val: unknown }>,
      _payload: undefined as unknown,
      select() {
        return b;
      },
      update(payload: Record<string, unknown>) {
        b._op = 'update';
        b._payload = payload;
        return b;
      },
      eq(col: string, val: unknown) {
        b._eqs.push({ col, val });
        return b;
      },
      or() { return b; },
      in() { return b; },
      is() { return b; },
      limit() { return b; },
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
        async getUser(token: string) {
          if (!token) return { data: { user: null }, error: { message: 'no token' } };
          return { data: { user: { id: token } }, error: null };
        },
        admin: {
          async getUserById() {
            return { data: { user: null }, error: { message: 'noop' } };
          },
        },
      },
    },
    supabaseAuth: {
      from: () => makeBuilder('noop'),
      auth: {
        async getUser(token: string) {
          if (!token) return { data: { user: null }, error: { message: 'no token' } };
          return { data: { user: { id: token } }, error: null };
        },
      },
    },
  };
});

import { app } from '../src/index';

const MATCH_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

function url(matchId = MATCH_ID, messageId = MESSAGE_ID) {
  return `/api/matches/${matchId}/messages/${messageId}/reaction`;
}

function authHeader(userId = VIEWER) {
  return { Authorization: `Bearer ${userId}` };
}

beforeEach(() => {
  captured.frozen = { is_active: true, frozen_at: null };
  captured.match = {
    data: { id: MATCH_ID, user1_id: VIEWER, user2_id: PARTNER, unmatched_at: null },
    error: null,
  };
  // 기본값: 상대(PARTNER)가 보낸 메시지 — 리액션 대상으로 적법
  captured.messageSelect = {
    data: { id: MESSAGE_ID, sender_id: PARTNER },
    error: null,
  };
  captured.updateResult = {
    data: { id: MESSAGE_ID, match_id: MATCH_ID, sender_id: PARTNER, reaction: 'heart' },
    error: null,
  };
  captured.updatePayloads = [];
  captured.updateEqs = [];
});

describe('PUT /api/matches/:matchId/messages/:messageId/reaction', () => {
  it('매치 비참여자는 403 — 메시지 조회조차 안 한다', async () => {
    captured.match = { data: null, error: null };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'heart' });

    expect(res.status).toBe(403);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('다른 매치의 메시지 id 는 404 — match_id 정합성으로 쓰기 차단', async () => {
    // select 가 match_id 조건을 포함하므로 다른 매치 메시지는 0 rows
    captured.messageSelect = { data: null, error: { message: 'no rows' } };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'heart' });

    expect(res.status).toBe(404);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('본인이 보낸 메시지에는 403 — 리액션 주체는 발신자의 반대편', async () => {
    captured.messageSelect = { data: { id: MESSAGE_ID, sender_id: VIEWER }, error: null };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'heart' });

    expect(res.status).toBe(403);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('상대 메시지에 리액션을 남기면 200 + reaction 단일 컬럼만 UPDATE', async () => {
    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'laugh' });

    expect(res.status).toBe(200);
    expect(captured.updatePayloads).toHaveLength(1);
    // audio_status / audio_url 을 건드리지 않아야 한다 (expo-audio player 회수 무관)
    expect(Object.keys(captured.updatePayloads[0])).toEqual(['reaction']);
    expect(captured.updatePayloads[0].reaction).toBe('laugh');
    // UPDATE 조건에 match_id 재포함 — (2) 이후 경합에도 다른 매치로 안 새게
    expect(captured.updateEqs.map((e) => e.col)).toContain('match_id');
  });

  it('reaction: null 은 해제 — 같은 컬럼에 null 을 쓴다', async () => {
    captured.updateResult = {
      data: { id: MESSAGE_ID, match_id: MATCH_ID, sender_id: PARTNER, reaction: null },
      error: null,
    };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: null });

    expect(res.status).toBe(200);
    expect(captured.updatePayloads[0]).toEqual({ reaction: null });
    expect(res.body.reaction).toBeNull();
  });

  it('허용되지 않은 값은 400 — zod enum 이 걸러 UPDATE 미발화', async () => {
    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'poop' });

    expect(res.status).toBe(400);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('UPDATE error 는 500 으로 가시화 — schema drift 를 silent-success 로 안 가린다', async () => {
    // mig 054 미적용 환경: reaction 컬럼 부재 → supabase 가 error 반환
    captured.updateResult = {
      data: null,
      error: { message: `column "reaction" of relation "messages" does not exist` },
    };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'heart' });

    expect(res.status).toBe(500);
  });

  it('동결 계정은 403 — requireNotFrozen 가드가 먼저 걸린다', async () => {
    captured.frozen = { is_active: true, frozen_at: '2026-01-01T00:00:00Z' };

    const res = await request(app)
      .put(url())
      .set(authHeader())
      .send({ reaction: 'heart' });

    expect(res.status).toBe(403);
    expect(captured.updatePayloads).toHaveLength(0);
  });
});
