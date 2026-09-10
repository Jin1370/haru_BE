// message-reply 회귀.
//
// 핵심은 "인용도 본문과 같은 규칙을 통과하는가" 다. 인용은 본문을 한 번 더
// 보여주는 표면이라, 상대가 자기 메시지를 인용하는 것만으로 음성 게이트가
// 뚫리면 안 된다.
//
//   * GET: 미청취 상대 메시지 인용 → 텍스트 마스킹 (id/sender_id 만 남음)
//   * GET: 청취 완료 상대 메시지 인용 → 텍스트 노출
//   * GET: 본인 메시지 인용 → 청취 개념 없음, 항상 노출
//   * GET: 수신자에게 안 보이는 메시지(failed) 인용 → reply_to: null
//   * GET: 페이지 밖 원본은 추가 조회로 채우되 match_id 로 제한
//   * POST: 다른 매치의 메시지 id 로 답장 → 404 reply_target_not_found
//   * POST: 같은 매치면 통과 (파이프라인까지 fire)
//
// 라이브 DB 히트 회피 — hoisted mock 패턴.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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
    rateLimit: { authWindowMin: 15, authMax: 50, waitlistWindowMin: 60, waitlistMax: 30 },
  },
}));

vi.mock('../src/constants/moderationDictionary', () => ({
  isBlocked: () => ({ blocked: false }),
}));
vi.mock('../src/services/openaiModeration', () => ({
  checkOpenAiModeration: vi.fn(async () => ({ blocked: false })),
}));
vi.mock('../src/utils/moderationAudit', () => ({ logModerationBlock: vi.fn() }));
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

const VIEWER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

const captured = vi.hoisted(() => ({
  frozen: { is_active: true as boolean, frozen_at: null as null | string },
  match: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  blocked: { data: [] as unknown[], error: null as null | { message: string } },
  senderProfile: null as null | Record<string, unknown>,
  recipientProfile: null as null | Record<string, unknown>,
  // GET 목록 (or 필터 통과분)
  listRows: [] as Record<string, unknown>[],
  // 페이지 밖 원본 추가 조회 (.in('id', ...))
  quoteRows: [] as Record<string, unknown>[],
  quoteInIds: null as null | unknown[],
  quoteEqs: [] as Array<{ col: string; val: unknown }>,
  // POST 의 reply target 조회 결과
  replyTarget: null as null | Record<string, unknown>,
  replyTargetEqs: [] as Array<{ col: string; val: unknown }>,
  upsertPayloads: [] as Record<string, unknown>[],
  aroundTarget: null as null | Record<string, unknown>,
  olderRows: [] as Record<string, unknown>[],
  newerRows: [] as Record<string, unknown>[],
  afterAsc: null as null | boolean,
}));

vi.mock('../src/config/supabase', () => {
  function resolveTerminal(b: any): any {
    const t = b._table;
    if (t === 'matches') return captured.match;
    if (t === 'blocks') return captured.blocked;
    if (t === 'profiles') {
      if (typeof b._cols === 'string' && b._cols.includes('is_active')) {
        return { data: captured.frozen, error: null };
      }
      const idEq = b._eqs.find((e: any) => e.col === 'id');
      if (idEq && idEq.val === PARTNER) {
        return { data: captured.recipientProfile, error: null };
      }
      return { data: captured.senderProfile, error: null };
    }
    if (t === 'messages') {
      if (b._op === 'upsert') {
        captured.upsertPayloads.push(b._upsertPayload);
        return { data: [b._upsertPayload], error: null };
      }
      // 페이지 밖 원본 추가 조회
      if (b._in) {
        captured.quoteInIds = b._in.vals;
        captured.quoteEqs = b._eqs;
        return { data: captured.quoteRows, error: null };
      }
      // 멱등 scoped pre-check (id + match_id + sender_id, select '*') — 미커밋
      if (b._eqs.some((e: any) => e.col === 'sender_id')) {
        return { data: null, error: null };
      }
      // 답장 대상 조회 (select 'id' + id + match_id)
      if (b._cols === 'id' && b._eqs.some((e: any) => e.col === 'match_id')) {
        captured.replyTargetEqs = b._eqs;
        return { data: captured.replyTarget, error: null };
      }
      // 멱등 foreign pre-check (select 'id' + id 만) — 미사용 id
      if (b._cols === 'id') {
        return { data: null, error: null };
      }
      // around: 대상 조회 (select '*' + id + match_id, 가시성 or 필터)
      if (b._eqs.some((e: any) => e.col === 'id') && b._cols === '*') {
        return { data: captured.aroundTarget, error: null };
      }
      // around 의 두 구간
      if (b._lt) return { data: captured.olderRows, error: null };
      if (b._gte) return { data: captured.newerRows, error: null };
      // after
      if (b._gt) {
        captured.afterAsc = b._asc;
        return { data: captured.newerRows, error: null };
      }
      // GET 목록
      return { data: captured.listRows, error: null };
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select' as 'select' | 'upsert',
      _cols: undefined as undefined | string,
      _eqs: [] as Array<{ col: string; val: unknown }>,
      _in: undefined as undefined | { col: string; vals: unknown[] },
      _lt: false,
      _gt: false,
      _gte: false,
      _asc: false,
      _upsertPayload: undefined as unknown,
      select(cols?: string) {
        if (b._op !== 'upsert') b._op = 'select';
        if (cols !== undefined) b._cols = cols;
        return b;
      },
      upsert(payload: Record<string, unknown>) {
        b._op = 'upsert';
        b._upsertPayload = payload;
        return b;
      },
      update() { return b; },
      eq(col: string, val: unknown) { b._eqs.push({ col, val }); return b; },
      in(col: string, vals: unknown[]) { b._in = { col, vals }; return b; },
      or() { return b; },
      is() { return b; },
      lt() { b._lt = true; return b; },
      gt() { b._gt = true; return b; },
      gte() { b._gte = true; return b; },
      limit() { return b; },
      order(_col: string, opts?: { ascending?: boolean }) {
        b._asc = opts?.ascending ?? false;
        return b;
      },
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
const PARENT_ID = '55555555-5555-4555-8555-555555555555';
const CHILD_ID = '66666666-6666-4666-8666-666666666666';

function authHeader(userId = VIEWER) {
  return { Authorization: `Bearer ${userId}` };
}

function parent(overrides: Record<string, unknown> = {}) {
  return {
    id: PARENT_ID,
    match_id: MATCH_ID,
    sender_id: PARTNER,
    original_text: '비밀 원문',
    translated_text: '비밀 번역',
    audio_status: 'ready',
    listened_at: null,
    ...overrides,
  };
}

function child() {
  return {
    id: CHILD_ID,
    match_id: MATCH_ID,
    sender_id: VIEWER,
    original_text: '답장 본문',
    audio_status: 'ready',
    listened_at: null,
    reply_to_id: PARENT_ID,
  };
}

beforeEach(() => {
  captured.frozen = { is_active: true, frozen_at: null };
  captured.match = {
    data: { id: MATCH_ID, user1_id: VIEWER, user2_id: PARTNER, unmatched_at: null },
    error: null,
  };
  captured.blocked = { data: [], error: null };
  captured.senderProfile = {
    id: VIEWER,
    display_name: 'Me',
    gender: 'female',
    language: 'ko',
    elevenlabs_voice_id: 'voice-1',
  };
  captured.recipientProfile = { id: PARTNER, display_name: 'You', language: 'ja' };
  captured.listRows = [];
  captured.quoteRows = [];
  captured.quoteInIds = null;
  captured.quoteEqs = [];
  captured.replyTarget = { id: PARENT_ID };
  captured.replyTargetEqs = [];
  captured.upsertPayloads = [];
  captured.aroundTarget = null;
  captured.olderRows = [];
  captured.newerRows = [];
  captured.afterAsc = null;
});

describe('GET /api/matches/:matchId/messages — 답장 인용', () => {
  it('미청취 상대 메시지 인용은 텍스트가 마스킹된다 (게이트 우회 차단)', async () => {
    captured.listRows = [child(), parent()];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    expect(res.status).toBe(200);
    const quoted = res.body.find((m: any) => m.id === CHILD_ID).reply_to;
    expect(quoted.id).toBe(PARENT_ID);
    expect(quoted.original_text).toBeNull();
    expect(quoted.translated_text).toBeNull();
  });

  it('청취 완료된 상대 메시지 인용은 텍스트가 노출된다', async () => {
    captured.listRows = [child(), parent({ listened_at: '2026-01-01T00:00:00Z' })];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    const quoted = res.body.find((m: any) => m.id === CHILD_ID).reply_to;
    expect(quoted.original_text).toBe('비밀 원문');
    expect(quoted.translated_text).toBe('비밀 번역');
  });

  it('본인이 보낸 메시지 인용은 청취 개념이 없어 항상 노출된다', async () => {
    captured.listRows = [child(), parent({ sender_id: VIEWER, listened_at: null })];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    expect(res.body.find((m: any) => m.id === CHILD_ID).reply_to.original_text).toBe('비밀 원문');
  });

  it('수신자에게 안 보이는 메시지(failed) 인용은 reply_to 자체가 null', async () => {
    captured.listRows = [child(), parent({ audio_status: 'failed' })];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    expect(res.body.find((m: any) => m.id === CHILD_ID).reply_to).toBeNull();
  });

  it('페이지 밖 원본은 추가 조회로 채우되 match_id 로 제한한다', async () => {
    captured.listRows = [child()]; // 원본이 페이지에 없음
    captured.quoteRows = [parent({ listened_at: '2026-01-01T00:00:00Z' })];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    expect(captured.quoteInIds).toEqual([PARENT_ID]);
    // IDOR 경계 — 다른 매치의 메시지가 인용으로 딸려오면 안 된다
    expect(captured.quoteEqs.some((e) => e.col === 'match_id' && e.val === MATCH_ID)).toBe(true);
    expect(res.body[0].reply_to.original_text).toBe('비밀 원문');
  });

  it('reply_to_id 가 없으면 추가 조회도, reply_to 필드도 없다', async () => {
    captured.listRows = [{ ...child(), reply_to_id: null }];

    const res = await request(app).get(`/api/matches/${MATCH_ID}/messages`).set(authHeader());

    expect(captured.quoteInIds).toBeNull();
    expect(res.body[0].reply_to).toBeUndefined();
  });
});

describe('POST /api/matches/:matchId/messages — 답장 대상 검증', () => {
  it('다른 매치의 메시지에 답장하면 404 — 인용으로 남의 대화를 끌어올 수 없다', async () => {
    captured.replyTarget = null; // match_id 조건에서 0 rows

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: '안녕', reply_to_id: PARENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('reply_target_not_found');
    // 조회 조건에 match_id 가 포함돼야 경계가 성립한다
    expect(captured.replyTargetEqs.some((e) => e.col === 'match_id')).toBe(true);
  });

  it('같은 매치의 메시지면 202 로 큐잉되고 reply_to_id 가 stub 에 실린다', async () => {
    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: '안녕', reply_to_id: PARENT_ID });

    expect(res.status).toBe(202);
    expect(res.body.reply_to_id).toBe(PARENT_ID);
  });

  it('reply_to_id 가 없으면 대상 조회 자체를 하지 않는다', async () => {
    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: '안녕' });

    expect(res.status).toBe(202);
    expect(res.body.reply_to_id).toBeNull();
    expect(captured.replyTargetEqs).toEqual([]);
  });

  it('reply_to_id 가 uuid 가 아니면 400', async () => {
    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: '안녕', reply_to_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });
});

describe('GET /messages — around / after (인용 점프)', () => {
  const row = (id: string, at: string) => ({
    id,
    match_id: MATCH_ID,
    sender_id: VIEWER,
    original_text: id,
    translated_text: null,
    audio_status: 'ready',
    listened_at: null,
    reply_to_id: null,
    created_at: at,
  });

  it('around 은 앞뒤 구간을 합쳐 최신 우선(desc) 한 덩어리로 준다', async () => {
    captured.aroundTarget = { created_at: '2026-01-02T00:00:00Z' };
    // newer 는 정방향(오래된 순)으로 뽑히고, older 는 역방향으로 뽑힌다
    captured.newerRows = [row('t', '2026-01-02T00:00:00Z'), row('n1', '2026-01-03T00:00:00Z')];
    captured.olderRows = [row('o1', '2026-01-01T00:00:00Z')];

    const res = await request(app)
      .get(`/api/matches/${MATCH_ID}/messages?around=${PARENT_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    // 최신 → 과거 순서. 대상(t)이 가운데 놓인다.
    expect(res.body.map((m: any) => m.id)).toEqual(['n1', 't', 'o1']);
  });

  it('못 보는 메시지로 around 하면 404 — 시점 probe 차단', async () => {
    captured.aroundTarget = null;

    const res = await request(app)
      .get(`/api/matches/${MATCH_ID}/messages?around=${PARENT_ID}`)
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('message_not_found');
  });

  it('after 는 정방향으로 뽑아야 "바로 다음 구간" 이 된다 (desc 로 뽑으면 건너뛴다)', async () => {
    captured.newerRows = [row('a1', '2026-01-04T00:00:00Z'), row('a2', '2026-01-05T00:00:00Z')];

    const res = await request(app)
      .get(`/api/matches/${MATCH_ID}/messages?after=${encodeURIComponent('2026-01-03T00:00:00Z')}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(captured.afterAsc).toBe(true);
    // 응답 계약은 before 와 동일하게 최신 우선
    expect(res.body.map((m: any) => m.id)).toEqual(['a2', 'a1']);
  });
});
