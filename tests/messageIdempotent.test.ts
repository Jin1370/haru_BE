// idempotent-send sprint 회귀.
//
// POST /api/matches/:matchId/messages 의 멱등화:
//   * 동기 201 신규 (voice-clone 미보유 발신자, 새 id)
//   * 동기 200 재반환 (같은 client_message_id 재전송 → 동일 row)
//   * 409 IDOR probe (타 사용자 소유 id → 내용 미노출)
//   * 옛 FE 하위호환 (client_message_id 미포함 → 서버 randomUUID 폴백)
//   * 모더레이션 재시도 여전히 422 (멱등 short-circuit 이 모더레이션 우회 안 함)
//   * async 202 stub (voice-clone 보유, 새 id)
//   * async retry-after-commit 200 (이미 INSERT 된 내 row → 재합성 없이 반환)
//   * in-flight beginProcessing / endProcessing 가드 (직접 단위)
//
// 라이브 DB 히트 회피 — swipe.test.ts / voiceIntroModeration.test.ts 와 동일한
// 모듈 경계 hoisted mock 패턴. supabase / env / 외부 서비스(번역/TTS/Storage/push)
// / 모더레이션을 mock 으로 잡는다.

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

// ── 모더레이션 mock — 'BLOCKME' 포함 시만 차단 ──
vi.mock('../src/constants/moderationDictionary', () => ({
  isBlocked: (text: string) =>
    text.includes('BLOCKME')
      ? { blocked: true, category: 'sexual', language: 'ko' }
      : { blocked: false },
}));
vi.mock('../src/services/openaiModeration', () => ({
  checkOpenAiModeration: vi.fn(async () => ({ blocked: false })),
}));
vi.mock('../src/utils/moderationAudit', () => ({
  logModerationBlock: vi.fn(),
}));

// ── 파이프라인 외부 서비스 mock (async 경로 fire-and-forget) ──
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
const RECIPIENT = '22222222-2222-4222-8222-222222222222';

const captured = vi.hoisted(() => ({
  frozen: { is_active: true as boolean, frozen_at: null as null | string },
  match: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  blocked: { data: [] as unknown[], error: null as null | { message: string } },
  senderProfile: null as null | Record<string, unknown>,
  recipientProfile: null as null | Record<string, unknown>,
  // messages upsert(...).select()
  upsertResult: {
    data: null as null | Record<string, unknown>[],
    error: null as null | { message: string },
  },
  // messages scoped select (id+match_id+sender_id).maybeSingle() — committed 및 재반환
  scopedSelect: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  // messages foreign select (id only).maybeSingle()
  foreignSelect: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  },
  upsertPayloads: [] as Record<string, unknown>[],
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
      if (idEq && idEq.val === RECIPIENT) {
        return { data: captured.recipientProfile, error: null };
      }
      return { data: captured.senderProfile, error: null };
    }
    if (t === 'messages') {
      if (b._op === 'upsert') {
        captured.upsertPayloads.push(b._upsertPayload);
        return captured.upsertResult;
      }
      const eqCols = b._eqs.map((e: any) => e.col);
      if (eqCols.includes('match_id') && eqCols.includes('sender_id')) {
        return captured.scopedSelect;
      }
      return captured.foreignSelect;
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select' as 'select' | 'insert' | 'upsert' | 'delete',
      _cols: undefined as undefined | string,
      _selectOpts: undefined as unknown,
      _eqs: [] as Array<{ col: string; val: unknown }>,
      _upsertPayload: undefined as unknown,
      select(cols?: string, opts?: unknown) {
        if (b._op !== 'insert' && b._op !== 'upsert' && b._op !== 'delete') b._op = 'select';
        if (cols !== undefined) b._cols = cols;
        if (opts !== undefined) b._selectOpts = opts;
        return b;
      },
      insert(payload: Record<string, unknown>) {
        b._op = 'insert';
        b._upsertPayload = payload;
        return b;
      },
      upsert(payload: Record<string, unknown>) {
        b._op = 'upsert';
        b._upsertPayload = payload;
        return b;
      },
      delete() {
        b._op = 'delete';
        return b;
      },
      eq(col: string, val: unknown) {
        b._eqs.push({ col, val });
        return b;
      },
      or() { return b; },
      in() { return b; },
      is() { return b; },
      gte() { return b; },
      lt() { return b; },
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
    supabaseAuth: { from: () => makeBuilder('noop') },
  };
});

import { app } from '../src/index';
import { beginProcessing, endProcessing } from '../src/routes/message';

const MATCH_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authHeader(userId = VIEWER) {
  return { Authorization: `Bearer ${userId}` };
}

beforeEach(() => {
  captured.frozen = { is_active: true, frozen_at: null };
  captured.match = {
    data: { id: MATCH_ID, user1_id: VIEWER, user2_id: RECIPIENT, unmatched_at: null },
    error: null,
  };
  captured.blocked = { data: [], error: null };
  captured.senderProfile = {
    language: 'ko',
    elevenlabs_voice_id: null,
    display_name: 'Alice',
    gender: 'male',
  };
  captured.recipientProfile = { language: 'en' };
  captured.upsertResult = { data: null, error: null };
  captured.scopedSelect = { data: null, error: null };
  captured.foreignSelect = { data: null, error: null };
  captured.upsertPayloads = [];
});

describe('POST messages — 동기 경로 (voice-clone 미보유)', () => {
  it('(1) 새 id → 201 + row 삽입 + payload.id = client_message_id', async () => {
    captured.upsertResult = {
      data: [{ id: CLIENT_ID, match_id: MATCH_ID, sender_id: VIEWER, audio_status: 'pending', original_text: 'hi' }],
      error: null,
    };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'hi', client_message_id: CLIENT_ID });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CLIENT_ID);
    expect(captured.upsertPayloads).toHaveLength(1);
    expect(captured.upsertPayloads[0].id).toBe(CLIENT_ID);
    expect(captured.upsertPayloads[0].audio_status).toBe('pending');
  });

  it('(2) 같은 client_message_id 재전송 (0 rows) → 200 동일 row', async () => {
    captured.upsertResult = { data: [], error: null }; // ON CONFLICT DO NOTHING
    captured.scopedSelect = {
      data: { id: CLIENT_ID, match_id: MATCH_ID, sender_id: VIEWER, audio_status: 'pending', original_text: 'hi' },
      error: null,
    };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'hi', client_message_id: CLIENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CLIENT_ID);
  });

  it('(3) IDOR probe — 타 사용자 소유 id (scoped 미스) → 409 + 내용 미노출', async () => {
    captured.upsertResult = { data: [], error: null }; // 전역 id 충돌
    captured.scopedSelect = { data: null, error: null }; // 내 (match+sender) 소유 아님

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'probe', client_message_id: CLIENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_message');
    // 원문/타인 row 내용은 절대 노출되지 않는다.
    expect(res.body.original_text).toBeUndefined();
    expect(res.body.id).toBeUndefined();
  });

  it('(4) 옛 FE 하위호환 — client_message_id 미포함 → 서버 UUID 폴백 + 201', async () => {
    captured.upsertResult = {
      data: [{ id: 'srv', match_id: MATCH_ID, sender_id: VIEWER, audio_status: 'pending' }],
      error: null,
    };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'legacy' });

    expect(res.status).toBe(201);
    expect(captured.upsertPayloads).toHaveLength(1);
    expect(captured.upsertPayloads[0].id).toMatch(UUID_RE);
  });

  it('(5) upsert supabase 에러 → 500 (silent-success 금지)', async () => {
    captured.upsertResult = { data: null, error: { message: 'db down' } };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'hi', client_message_id: CLIENT_ID });

    expect(res.status).toBe(500);
  });
});

describe('POST messages — 모더레이션 정합', () => {
  it('(6) 금지어 + client_message_id (재시도) → 여전히 422, INSERT 미도달', async () => {
    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'BLOCKME now', client_message_id: CLIENT_ID });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('message_blocked');
    // 멱등 short-circuit 이 모더레이션을 우회하지 않는다 → upsert 자체가 없어야 함.
    expect(captured.upsertPayloads).toHaveLength(0);
  });
});

describe('POST messages — 비동기 경로 (voice-clone 보유)', () => {
  beforeEach(() => {
    captured.senderProfile = {
      language: 'ko',
      elevenlabs_voice_id: 'voice-1',
      display_name: 'Alice',
      gender: 'male',
    };
  });

  it('(7) 새 id → 202 stub (id=client_message_id, audio_status=pending)', async () => {
    captured.scopedSelect = { data: null, error: null }; // committed 없음
    captured.foreignSelect = { data: null, error: null }; // 위조 없음
    // 백그라운드 파이프라인 upsert 는 이 값을 흡수 (assert 대상 아님).
    captured.upsertResult = { data: [{ id: CLIENT_ID }], error: null };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'hi voice', client_message_id: CLIENT_ID });

    expect(res.status).toBe(202);
    expect(res.body.id).toBe(CLIENT_ID);
    expect(res.body.audio_status).toBe('pending');
  });

  it('(8) retry-after-commit — 이미 INSERT 된 내 row → 200, 재합성 없음', async () => {
    captured.scopedSelect = {
      data: { id: CLIENT_ID, match_id: MATCH_ID, sender_id: VIEWER, audio_status: 'ready', audio_url: 'https://cdn/x.mp3' },
      error: null,
    };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'hi voice', client_message_id: CLIENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CLIENT_ID);
    expect(res.body.audio_status).toBe('ready');
    // committed 반환 경로라 파이프라인/upsert 미발화.
    expect(captured.upsertPayloads).toHaveLength(0);
  });

  it('(9) 위조 id — foreign 존재(scoped 미스) → 409, 파이프라인 미발화', async () => {
    captured.scopedSelect = { data: null, error: null };
    captured.foreignSelect = { data: { id: CLIENT_ID }, error: null };

    const res = await request(app)
      .post(`/api/matches/${MATCH_ID}/messages`)
      .set(authHeader())
      .send({ text: 'forge', client_message_id: CLIENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_message');
    expect(captured.upsertPayloads).toHaveLength(0);
  });
});

describe('in-flight 가드 (beginProcessing / endProcessing)', () => {
  it('(10) 같은 id 두 번째 beginProcessing → false, endProcessing 후 재획득 true', async () => {
    const id = 'inflight-test-id';
    expect(beginProcessing(id)).toBe(true);
    expect(beginProcessing(id)).toBe(false); // 이미 in-flight → skip
    endProcessing(id);
    expect(beginProcessing(id)).toBe(true); // 해제 후 재획득
    endProcessing(id);
  });
});
