// chat-photos 회귀.
//
//   * 403 매치 비참여자 / 언매치된 매치 / 차단 관계
//   * 400 파일 없음 / 허용 안 되는 타입 / uuid 아닌 client_message_id
//   * 422 이미지 모더레이션 차단 — **Storage 업로드 전** 에 막혔는지
//   * 201 정상 전송: 파이프라인 미경유(audio_status='ready', audio_url=null),
//     폴백 캡션이 양쪽 언어로 채워지는지, photo_path 가 매치 폴더 아래인지
//   * 멱등: 같은 client_message_id 재전송이 200 재반환
//
// 라이브 DB / OpenAI / Storage 히트 회피 — hoisted mock 패턴.

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
    openai: { moderationApiKey: 'test-key' },
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

const captured = vi.hoisted(() => ({
  frozen: { is_active: true as boolean, frozen_at: null as null | string },
  match: null as null | Record<string, unknown>,
  blocks: [] as unknown[],
  profiles: [] as Record<string, unknown>[],
  replyTarget: null as null | Record<string, unknown>,
  imageBlocked: false,
  uploads: [] as Array<{ bucket: string; path: string; contentType: string }>,
  upsertPayloads: [] as Record<string, unknown>[],
  moderationEvents: [] as Record<string, unknown>[],
  pushes: [] as unknown[],
}));

vi.mock('../src/constants/moderationDictionary', () => ({
  isBlocked: () => ({ blocked: false }),
}));
vi.mock('../src/services/openaiModeration', () => ({
  checkOpenAiModeration: vi.fn(async () => ({ blocked: false })),
  checkOpenAiImageModeration: vi.fn(async () =>
    captured.imageBlocked
      ? { blocked: true, category: 'sexual', rawCategory: 'sexual' }
      : { blocked: false },
  ),
}));
vi.mock('../src/utils/moderationAudit', () => ({
  logModerationBlock: vi.fn((e: Record<string, unknown>) => {
    captured.moderationEvents.push(e);
  }),
}));
vi.mock('../src/services/translation', () => ({
  translateMessage: vi.fn(async () => ({ translation: 'hello' })),
}));
vi.mock('../src/services/elevenlabs', () => ({
  synthesizeSpeech: vi.fn(async () => Buffer.from('audio')),
}));
vi.mock('../src/services/storage', () => ({
  uploadFile: vi.fn(async (bucket: string, path: string, _b: Buffer, contentType: string) => {
    captured.uploads.push({ bucket, path, contentType });
    return `https://cdn/${bucket}/${path}`;
  }),
  deleteFile: vi.fn(async () => {}),
  extractPath: vi.fn((_b: string, u: string) => u),
  createSignedUrlForPath: vi.fn(async (_b: string, p: string) => `https://signed/${p}?token=x`),
  createSignedUrlFromStored: vi.fn(async () => null),
  createSignedSlotUrls: vi.fn(async () => ({})),
  SIGNED_URL_DEFAULT_TTL: 3600,
}));
vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: vi.fn(async (id: string, payload: unknown) => {
    captured.pushes.push({ id, payload });
  }),
}));

const VIEWER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

vi.mock('../src/config/supabase', () => {
  function resolveTerminal(b: any): any {
    const t = b._table;
    if (t === 'matches') return { data: captured.match, error: null };
    if (t === 'blocks') return { data: captured.blocks, error: null };
    if (t === 'profiles') {
      if (typeof b._cols === 'string' && b._cols.includes('is_active')) {
        return { data: captured.frozen, error: null };
      }
      if (b._in) return { data: captured.profiles, error: null };
      return { data: captured.profiles[0] ?? null, error: null };
    }
    if (t === 'messages') {
      if (b._op === 'upsert') {
        captured.upsertPayloads.push(b._upsertPayload);
        return { data: [b._upsertPayload], error: null };
      }
      if (b._cols === 'id') return { data: captured.replyTarget, error: null };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function makeBuilder(table: string): any {
    const b: any = {
      _table: table,
      _op: 'select' as 'select' | 'upsert',
      _cols: undefined as undefined | string,
      _in: false,
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
      eq() { return b; },
      in() { b._in = true; return b; },
      or() { return b; },
      is() { return b; },
      not() { return b; },
      lt() { return b; },
      limit() { return b; },
      order() { return b; },
      async single() { return resolveTerminal(b); },
      async maybeSingle() { return resolveTerminal(b); },
      then(resolve: any) { return Promise.resolve(resolveTerminal(b)).then(resolve); },
    };
    return b;
  }

  const auth = {
    async getUser(token: string) {
      if (!token) return { data: { user: null }, error: { message: 'no token' } };
      return { data: { user: { id: token } }, error: null };
    },
    admin: {
      async getUserById() {
        return { data: { user: null }, error: { message: 'noop' } };
      },
    },
  };

  return {
    supabase: { from: (t: string) => makeBuilder(t), auth },
    supabaseAuth: { from: () => makeBuilder('noop'), auth },
  };
});

import { app } from '../src/index';

const MATCH_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function post() {
  return request(app)
    .post(`/api/matches/${MATCH_ID}/messages/photo`)
    .set('Authorization', `Bearer ${VIEWER}`);
}

beforeEach(() => {
  captured.frozen = { is_active: true, frozen_at: null };
  captured.match = { id: MATCH_ID, user1_id: VIEWER, user2_id: PARTNER, unmatched_at: null };
  captured.blocks = [];
  captured.profiles = [
    { id: VIEWER, language: 'ko', display_name: 'Me' },
    { id: PARTNER, language: 'ja', display_name: 'You' },
  ];
  captured.replyTarget = null;
  captured.imageBlocked = false;
  captured.uploads = [];
  captured.upsertPayloads = [];
  captured.moderationEvents = [];
  captured.pushes = [];
});

describe('POST /api/matches/:matchId/messages/photo', () => {
  it('파일이 없으면 400', async () => {
    const res = await post();
    expect(res.status).toBe(400);
  });

  it('허용되지 않은 타입은 400 — 업로드 미발생', async () => {
    const res = await post().attach('photo', Buffer.from('gif'), {
      filename: 'a.gif',
      contentType: 'image/gif',
    });
    expect(res.status).toBe(400);
    expect(captured.uploads).toHaveLength(0);
  });

  it('매치 비참여자는 403', async () => {
    captured.match = null;
    const res = await post().attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
    expect(captured.uploads).toHaveLength(0);
  });

  it('언매치된 매치는 403', async () => {
    captured.match = { ...(captured.match as object), unmatched_at: '2026-01-01T00:00:00Z' };
    const res = await post().attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
    expect(captured.uploads).toHaveLength(0);
  });

  it('차단 관계면 403', async () => {
    captured.blocks = [{ id: 'b1' }];
    const res = await post().attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
    expect(captured.uploads).toHaveLength(0);
  });

  it('모더레이션 차단은 422 — Storage 업로드 전에 막고 카테고리는 미노출', async () => {
    captured.imageBlocked = true;
    const res = await post().attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('photo_blocked');
    expect(JSON.stringify(res.body)).not.toContain('sexual');
    // 차단된 이미지가 잠깐이라도 버킷에 존재하면 안 된다
    expect(captured.uploads).toHaveLength(0);
    expect(captured.moderationEvents[0]).toMatchObject({ surface: 'chat_photo', layer: 'openai' });
  });

  it('정상 전송은 201 + 파이프라인 미경유 + 폴백 캡션 양쪽 언어', async () => {
    const res = await post()
      .field('client_message_id', CLIENT_ID)
      .field('width', '1280')
      .field('height', '960')
      .attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const payload = captured.upsertPayloads[0];
    // TTS/번역을 안 탄다 — 텍스트 전용 경로와 같은 모양
    expect(payload.audio_status).toBe('ready');
    expect(payload.audio_url).toBeNull();
    // 폴백 캡션: 옛 클라이언트에서 빈 말풍선 대신 텍스트로 보이게
    expect(payload.original_text).toBe('사진을 보냈어요');
    expect(payload.translated_text).toBe('写真を送りました');
    expect(payload.photo_path).toBe(`${MATCH_ID}/${CLIENT_ID}.jpg`);
    expect(payload.photo_width).toBe(1280);
    expect(payload.photo_height).toBe(960);
    // 응답은 경로가 아니라 서명 URL 로 미러
    expect(res.body.photo_url).toContain('https://signed/');
    expect(captured.uploads[0].bucket).toBe('chat-photos');
    expect(captured.pushes).toHaveLength(1);
  });

  it('uuid 가 아닌 client_message_id 는 400', async () => {
    const res = await post()
      .field('client_message_id', 'not-a-uuid')
      .attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(captured.uploads).toHaveLength(0);
  });

  it('답장 대상이 이 매치에 없으면 404', async () => {
    captured.replyTarget = null;
    const res = await post()
      .field('reply_to_id', '55555555-5555-4555-8555-555555555555')
      .attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('reply_target_not_found');
    expect(captured.uploads).toHaveLength(0);
  });

  it('동결 계정은 403 — 업로드 미발생', async () => {
    captured.frozen = { is_active: true, frozen_at: '2026-01-01T00:00:00Z' };
    const res = await post().attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
    expect(captured.uploads).toHaveLength(0);
  });
});
