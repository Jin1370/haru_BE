// 실패 메시지 재시도 회귀 (2026-08-21).
//
// POST /api/matches/:matchId/messages/:messageId/audio 의 통과 조건을 넓혔다:
//   (a) 30 일 폐기 (ready + audio_purged_at) — 기존, 매치 참여자 누구나
//   (b) 파이프라인 실패 (failed)            — 신규, 송신자 본인만
//
// 핵심 회귀 방어: 텍스트 전용 정상 메시지(캠페인봇 응모 안내 = ready +
// audio_url null + 폐기 아님)는 계속 409 여야 한다. "audio_url 이 null 이면
// 허용" 으로 넓히면 봇 안내 URL 이 그대로 음성 합성된다.
//
// 라이브 DB 히트 회피 — messageIdempotent.test.ts 의 모듈 경계 hoisted mock 패턴.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/env', () => ({
  env: {
    port: 3000,
    nodeEnv: 'test',
    supabase: { url: 'http://localhost', serviceRoleKey: 'k', anonKey: '', jwtSecret: 's' },
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

vi.mock('../src/services/translation', () => ({
  translateMessage: vi.fn(async () => ({ translation: 'hello' })),
}));
vi.mock('../src/services/elevenlabs', () => ({
  synthesizeSpeech: vi.fn(async () => Buffer.from('audio')),
}));
vi.mock('../src/services/storage', () => ({
  uploadFile: vi.fn(async () => 'https://cdn/audio_v1.mp3'),
}));
vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';

const captured = vi.hoisted(() => ({
  frozen: { is_active: true as boolean, frozen_at: null as null | string },
  match: null as null | Record<string, unknown>,
  message: null as null | Record<string, unknown>,
  updatePayloads: [] as Record<string, unknown>[],
}));

vi.mock('../src/config/supabase', () => {
  function resolveTerminal(b: any): any {
    const t = b._table;
    if (t === 'matches') return { data: captured.match, error: null };
    if (t === 'profiles') {
      if (typeof b._cols === 'string' && b._cols.includes('is_active')) {
        return { data: captured.frozen, error: null };
      }
      // 송신자 select 만 elevenlabs_voice_id 를 요청한다.
      if (typeof b._cols === 'string' && b._cols.includes('elevenlabs_voice_id')) {
        return {
          data: {
            elevenlabs_voice_id: 'v1',
            gender: 'male',
            birth_date: '1990-01-01',
            display_name: 'Alice',
          },
          error: null,
        };
      }
      return { data: { gender: 'female', birth_date: '1992-01-01' }, error: null };
    }
    if (t === 'messages') {
      if (b._op === 'update') {
        captured.updatePayloads.push(b._payload);
        return { data: { ...captured.message, ...b._payload }, error: null };
      }
      // 대상 메시지 조회는 id 로 좁힌다. 그 외(대화 컨텍스트 로드)는 빈 목록.
      if (b._eqs.some((e: any) => e.col === 'id')) return { data: captured.message, error: null };
      return { data: [], error: null };
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select',
      _cols: undefined,
      _eqs: [] as Array<{ col: string; val: unknown }>,
      _payload: undefined,
      select(cols?: string) {
        if (b._op !== 'update') b._op = 'select';
        if (cols !== undefined) b._cols = cols;
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
      not() { return b; },
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

const MATCH_ID = '33333333-3333-4333-8333-333333333333';
const MSG_ID = '44444444-4444-4444-8444-444444444444';

const baseMessage = {
  id: MSG_ID,
  match_id: MATCH_ID,
  sender_id: SENDER,
  original_text: '안녕',
  original_language: 'ko',
  translated_language: 'en',
  translated_text: null,
  emotion: null,
  audio_url: null,
  audio_purged_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
};

const call = (userId: string) =>
  request(app)
    .post(`/api/matches/${MATCH_ID}/messages/${MSG_ID}/audio`)
    .set({ Authorization: `Bearer ${userId}` });

beforeEach(() => {
  captured.frozen = { is_active: true, frozen_at: null };
  captured.match = { id: MATCH_ID, user1_id: SENDER, user2_id: RECIPIENT, unmatched_at: null };
  captured.message = null;
  captured.updatePayloads = [];
});

describe('재합성 라우트 게이트', () => {
  it('텍스트 전용 정상 메시지(캠페인봇 안내 = ready + 폐기 아님)는 409 — 안내문이 합성되면 안 된다', async () => {
    captured.message = { ...baseMessage, audio_status: 'ready' };
    const res = await call(RECIPIENT);
    expect(res.status).toBe(409);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('failed 메시지를 송신자 아닌 사람이 부르면 403 — 남의 합성 비용 태우기 차단', async () => {
    captured.message = { ...baseMessage, audio_status: 'failed' };
    const res = await call(RECIPIENT);
    expect(res.status).toBe(403);
    expect(captured.updatePayloads).toHaveLength(0);
  });

  it('failed 메시지를 송신자가 부르면 200 + ready 승격 + 번역문 채움', async () => {
    captured.message = { ...baseMessage, audio_status: 'failed' };
    const res = await call(SENDER);
    expect(res.status).toBe(200);
    expect(captured.updatePayloads).toHaveLength(1);
    expect(captured.updatePayloads[0].audio_status).toBe('ready');
    expect(captured.updatePayloads[0].translated_text).toBe('hello');
    expect(captured.updatePayloads[0].audio_url).toBe('https://cdn/audio_v1.mp3');
  });

  it('폐기 재합성(기존 동작)은 audio_status 를 건드리지 않는다', async () => {
    captured.message = {
      ...baseMessage,
      audio_status: 'ready',
      audio_purged_at: '2026-07-01T00:00:00.000Z',
    };
    const res = await call(RECIPIENT);
    expect(res.status).toBe(200);
    expect(captured.updatePayloads).toHaveLength(1);
    expect(captured.updatePayloads[0].audio_status).toBeUndefined();
    expect(captured.updatePayloads[0].translated_text).toBeUndefined();
  });
});
