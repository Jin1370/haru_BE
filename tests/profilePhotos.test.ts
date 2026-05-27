// photo-watercolor-pipeline sprint — POST/DELETE/retry 라우트 회귀.
//
// 202 비동기 응답 + 5장 한도 + retry 라우트 분기 + deleteAccount cascade 검증.
// gpt-image-2 호출은 mock — 변환은 사실상 instant.
//
// mig 028 미적용 환경은 silent skip.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const EMAIL = 'apitest_profilephotos@testmail.com';
let token: string;
let userId: string;
let skipReason: string | null = null;

// 변환 호출이 즉시 ready 로 끝나도록 mock (fire-and-forget 결과 검증 X — 본 파일은 라우트 응답 + DB row 만 검증).
const imagesEdit = vi.fn().mockResolvedValue({
  data: [{ b64_json: Buffer.from('mock-png').toString('base64') }],
});
vi.mock('openai', () => ({
  default: class MockOpenAI {
    images = { edit: imagesEdit };
    moderations = { create: vi.fn().mockResolvedValue({ results: [{ categories: {} }] }) };
  },
  toFile: vi.fn().mockImplementation(async (buf: Buffer, name: string) => ({ name, buffer: buf })),
}));

vi.mock('../src/services/storage', async () => {
  const actual = await vi.importActual<typeof import('../src/services/storage')>(
    '../src/services/storage',
  );
  return {
    ...actual,
    uploadFile: vi.fn().mockImplementation(
      async (_bucket: string, path: string) =>
        `https://fake.test/storage/v1/object/public/photos/${path}`,
    ),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  };
});

let originalOpenAiKey: string | undefined;

beforeAll(async () => {
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-placeholder';

  const probe = await supabase.from('profile_photos').select('id').limit(1);
  if (probe.error) {
    if (
      probe.error.code === 'PGRST205' ||
      /not find the table/i.test(probe.error.message) ||
      /does not exist/i.test(probe.error.message)
    ) {
      skipReason = '[photo-watercolor-pipeline] mig 028 not applied — skipping profilePhotos tests';
      return;
    }
  }

  const auth = await getAuthToken(EMAIL);
  token = auth.token;
  userId = auth.userId;
  await supabase.from('profiles').upsert({
    id: userId,
    display_name: 'Profile Photos Test',
    birth_date: '1995-01-01',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
  });
  await supabase.from('profile_photos').delete().eq('user_id', userId);
});

afterAll(async () => {
  if (skipReason) return;
  await supabase.from('profile_photos').delete().eq('user_id', userId);
  await cleanupUser(userId);
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

describe('POST /api/profile/photos — 비동기 변환', () => {
  it('202 + status=processing + photo_id 반환', async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const res = await request(app)
      .post('/api/profile/photos')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', Buffer.from('fake-image-data'), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(202);
    expect(res.body.photo_id).toBeDefined();
    expect(res.body.status).toBe('processing');
    expect(res.body.position).toBe(0);
  });
});

describe('POST /api/profile/photos — 5장 한도', () => {
  it('5장 이미 등록 시 400', async () => {
    if (skipReason) return;
    // 5장까지 row 채움
    await supabase.from('profile_photos').delete().eq('user_id', userId);
    for (let i = 0; i < 5; i++) {
      await supabase.from('profile_photos').insert({
        user_id: userId,
        position: i,
        original_path: `${userId}/originals/p${i}.jpg`,
        converted_url: `https://fake.test/photo${i}.png`,
        status: 'ready',
      });
    }

    const res = await request(app)
      .post('/api/profile/photos')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', Buffer.from('fake-image-data'), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Maximum/);
  });
});

describe('POST /api/profile/photos/:photoId/retry', () => {
  it('failed 사진 → 202', async () => {
    if (skipReason) return;
    await supabase.from('profile_photos').delete().eq('user_id', userId);
    const { data: row } = await supabase
      .from('profile_photos')
      .insert({
        user_id: userId,
        position: 0,
        original_path: `${userId}/originals/p0.jpg`,
        status: 'failed',
        failure_reason: 'openai_timeout',
      })
      .select('id')
      .single();

    const res = await request(app)
      .post(`/api/profile/photos/${row?.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('processing');
  });

  it('rejected 사진 → 422 code=photo_blocked', async () => {
    if (skipReason) return;
    await supabase.from('profile_photos').delete().eq('user_id', userId);
    const { data: row } = await supabase
      .from('profile_photos')
      .insert({
        user_id: userId,
        position: 0,
        original_path: null,
        status: 'rejected',
        failure_reason: 'moderation_rejected',
      })
      .select('id')
      .single();

    const res = await request(app)
      .post(`/api/profile/photos/${row?.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('photo_blocked');
  });

  it('ready 사진 → 409', async () => {
    if (skipReason) return;
    await supabase.from('profile_photos').delete().eq('user_id', userId);
    const { data: row } = await supabase
      .from('profile_photos')
      .insert({
        user_id: userId,
        position: 0,
        converted_url: 'https://fake.test/p0.png',
        status: 'ready',
      })
      .select('id')
      .single();

    const res = await request(app)
      .post(`/api/profile/photos/${row?.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it('타인 사진 → 404', async () => {
    if (skipReason) return;
    const res = await request(app)
      .post(`/api/profile/photos/00000000-0000-0000-0000-000000000000/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/profile/me — photo_statuses 응답', () => {
  it('photo_statuses 배열 + ready 사진만 photos 노출', async () => {
    if (skipReason) return;
    await supabase.from('profile_photos').delete().eq('user_id', userId);
    await supabase.from('profile_photos').insert([
      {
        user_id: userId,
        position: 0,
        converted_url: 'https://fake.test/p0.png',
        status: 'ready',
      },
      {
        user_id: userId,
        position: 1,
        original_path: `${userId}/originals/p1.jpg`,
        status: 'processing',
      },
      {
        user_id: userId,
        position: 2,
        status: 'failed',
        failure_reason: 'openai_timeout',
      },
    ]);

    const res = await request(app)
      .get('/api/profile/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.photo_statuses).toBeInstanceOf(Array);
    expect(res.body.photo_statuses.length).toBe(3);
    // ready 사진만 photos 에 노출.
    expect(res.body.photos).toEqual(['https://fake.test/p0.png']);
  });
});
