// POST /api/voice/clone 재등록 시 보이스 한마디 재생성 회귀.
//
// 검증 대상:
//   * 재녹음(기존 voice_id 보유) + voice_intro 존재 → 기존 문구 그대로 새 voice_id 로 재합성
//   * 최초 등록(기존 voice_id 없음) → 트리거 안 함 (마법사 순서상 PUT /me 가 담당)
//   * voice_intro 없음 → 트리거 안 함
//   * 프리셋 문구 → 카탈로그 손번역 주입 (Gemini 스킵), 커스텀 문구 → undefined
//
// swipe.test.ts 와 동일한 모듈 경계 mock 패턴 (라이브 DB 미히트).

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
    discover: {
      passResetEnabled: true,
      dailyLikeLimit: 15,
      unlimitedLikeCodes: [] as string[],
      unlimitedLikeCodeDays: 30,
      unlimitedLikeUserIds: [] as string[],
    },
    admin: { dashboardEnabled: false, secret: '' },
    moderation: { autoFreezeReportThreshold: 3 },
    voice: { recloneMonthlyCap: 2, recloneWindowDays: 30 },
    auth: { emailConfirmRedirectUrl: 'http://localhost/cb' },
    rateLimit: { authWindowMin: 15, authMax: 50, waitlistWindowMin: 60, waitlistMax: 30 },
  },
}));

const mocks = vi.hoisted(() => ({
  // profiles 행 (consent / reclone / freeze 가드 조회가 모두 여기서 읽힌다)
  profile: {} as Record<string, unknown>,
  regenCalls: [] as unknown[][],
}));

vi.mock('../src/services/elevenlabs', () => ({
  createVoiceClone: vi.fn(async () => 'new-voice-id'),
  deleteVoiceClone: vi.fn(async () => {}),
}));

vi.mock('../src/services/voiceIntro', () => ({
  generateVoiceIntroAudios: vi.fn(async (...args: unknown[]) => {
    mocks.regenCalls.push(args);
  }),
  normalizeAuthorLanguage: (l: string) => l,
  VOICE_INTRO_BUCKET: 'voice-intro-audio',
}));

vi.mock('../src/config/supabase', () => {
  function makeBuilder() {
    const b: any = {
      _cols: '',
      select(cols?: string) {
        b._cols = cols ?? '';
        return b;
      },
      update() {
        b._update = true;
        return b;
      },
      insert() {
        return b;
      },
      eq() {
        return b;
      },
      async single() {
        if (b._update) return { data: null, error: null };
        return { data: mocks.profile, error: null };
      },
      async maybeSingle() {
        if (b._update) return { data: null, error: null };
        return { data: mocks.profile, error: null };
      },
      then(resolve: any) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    supabase: {
      from: () => makeBuilder(),
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
    supabaseAuth: { from: () => makeBuilder() },
  };
});

import { app } from '../src/index';

const USER = '11111111-1111-1111-1111-111111111111';
// FE 가드(dBFS/bitrate) 를 통과하는 최소 크기 더미 오디오.
const AUDIO = Buffer.alloc(200 * 1024, 1);

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    is_active: true,
    frozen_at: null,
    voice_consent_at: '2026-07-01T00:00:00.000Z',
    elevenlabs_voice_id: 'old-voice-id',
    voice_reclone_count: 0,
    voice_reclone_window_start: null,
    voice_intro: '고민 듣는 거 좋아해요.\n뭐든지 얘기해주세요.',
    language: 'ko',
    gender: 'female',
    ...overrides,
  };
}

async function postClone() {
  return request(app)
    .post('/api/voice/clone')
    .set('Authorization', `Bearer ${USER}`)
    .attach('audio', AUDIO, { filename: 'v.wav', contentType: 'audio/wav' });
}

beforeEach(() => {
  mocks.regenCalls = [];
  mocks.profile = baseProfile();
});

describe('POST /api/voice/clone — 재등록 시 보이스 한마디 재생성', () => {
  it('재녹음 + 프리셋 문구 → 기존 문구·새 voice_id 로 재생성, 카탈로그 번역 주입', async () => {
    const res = await postClone();

    expect(res.status).toBe(200);
    expect(mocks.regenCalls).toHaveLength(1);
    const [userId, text, voiceId, language, presetTranslations, gender] = mocks.regenCalls[0];
    expect(userId).toBe(USER);
    // 기존 문구 그대로 (사용자가 다시 입력하지 않는다).
    expect(text).toBe('고민 듣는 거 좋아해요.\n뭐든지 얘기해주세요.');
    expect(voiceId).toBe('new-voice-id');
    expect(language).toBe('ko');
    expect(gender).toBe('female');
    // 프리셋이면 Gemini 스킵 — 카탈로그 3언어 손번역이 그대로 넘어간다.
    expect((presetTranslations as Record<string, string>).ja).toBe(
      '悩みを聞くのが好きです。\n何でも相談してくださいね。',
    );
  });

  it('커스텀 문구 → presetTranslations undefined (Gemini 경로)', async () => {
    mocks.profile = baseProfile({ voice_intro: '직접 쓴 한마디예요.' });

    await postClone();

    expect(mocks.regenCalls).toHaveLength(1);
    expect(mocks.regenCalls[0][4]).toBeUndefined();
  });

  it('최초 등록(기존 voice_id 없음) → 재생성 트리거 안 함', async () => {
    mocks.profile = baseProfile({ elevenlabs_voice_id: null });

    const res = await postClone();

    expect(res.status).toBe(200);
    expect(mocks.regenCalls).toHaveLength(0);
  });

  it('voice_intro 미설정 → 재생성 트리거 안 함', async () => {
    mocks.profile = baseProfile({ voice_intro: null });

    await postClone();

    expect(mocks.regenCalls).toHaveLength(0);
  });
});
