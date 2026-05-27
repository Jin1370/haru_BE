// photo-watercolor-pipeline sprint — photoConversion service 단위 테스트.
//
// gpt-image-2 호출은 vi.mock 으로 우회. Supabase 는 라이브 그대로 — 실제 DB UPDATE 가
// 일어났는지 SELECT 로 검증. NODE_ENV=test 에서 retry scheduler 가 등록 안 되므로
// 백그라운드 sweep 간섭 없음.
//
// mig 028 미적용 환경은 silent skip.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const EMAIL = 'apitest_photoconv@testmail.com';
let userId: string;
let skipReason: string | null = null;

// openai SDK 모킹 — images.edit 응답을 per-test 제어.
const imagesEdit = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    images = { edit: imagesEdit };
    moderations = { create: vi.fn().mockResolvedValue({ results: [{ categories: {} }] }) };
  },
  toFile: vi.fn().mockImplementation(async (buf: Buffer, name: string) => ({ name, buffer: buf })),
}));

// Storage 모킹 — uploadFile / deleteFile 가 실패 없이 통과.
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

// env.openai.moderationApiKey 가 set 되어 있어야 client 생성.
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
      skipReason = '[photo-watercolor-pipeline] mig 028 not applied — skipping photoConversion tests';
      return;
    }
  }

  const auth = await getAuthToken(EMAIL);
  userId = auth.userId;
  // 프로필 upsert (profile_photos.user_id FK 위해 필요).
  await supabase.from('profiles').upsert({
    id: userId,
    display_name: 'Photo Conv Test',
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
  try {
    await supabase.from('moderation_blocks').delete().eq('sender_id', userId);
  } catch {
    /* ignore */
  }
  await cleanupUser(userId);
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

beforeEach(() => {
  imagesEdit.mockReset();
});

async function createPendingRow(position = 0, originalPath = `${userId}/originals/test.jpg`) {
  const { data, error } = await supabase
    .from('profile_photos')
    .insert({
      user_id: userId,
      position,
      original_path: originalPath,
      status: 'processing',
    })
    .select('id')
    .single();
  if (error) throw new Error(`insert failed: ${error.message}`);
  return data.id as string;
}

describe('photoConversion — convertProfilePhoto', () => {
  it('skip if mig 028 not applied', () => {
    if (skipReason) console.warn(skipReason);
  });

  it('정상 변환 → status=ready, converted_url set, original_path=null', async () => {
    if (skipReason) return;
    imagesEdit.mockResolvedValue({
      data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }],
    });

    const rowId = await createPendingRow(0);
    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    const r = await convertProfilePhoto({
      userId,
      photoRowId: rowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    expect(r.status).toBe('ready');
    expect(r.convertedUrl).toBeDefined();

    const { data: row } = await supabase
      .from('profile_photos')
      .select('status, converted_url, original_path')
      .eq('id', rowId)
      .single();
    expect(row?.status).toBe('ready');
    expect(row?.converted_url).toBeDefined();
    expect(row?.original_path).toBeNull();
  });

  it('OpenAI safety filter 거부 (content policy) → status=rejected + audit', async () => {
    if (skipReason) return;
    const err: any = new Error('Your request was rejected as a result of our safety system');
    err.status = 400;
    err.code = 'moderation_blocked';
    imagesEdit.mockRejectedValue(err);

    const rowId = await createPendingRow(1);
    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    const r = await convertProfilePhoto({
      userId,
      photoRowId: rowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    expect(r.status).toBe('rejected');
    expect(r.failureReason).toBe('moderation_rejected');

    const { data: row } = await supabase
      .from('profile_photos')
      .select('status, failure_reason, original_path')
      .eq('id', rowId)
      .single();
    expect(row?.status).toBe('rejected');
    expect(row?.failure_reason).toBe('moderation_rejected');
    expect(row?.original_path).toBeNull();
  });

  it('네트워크/타임아웃 에러 → status=failed + retry_count++', async () => {
    if (skipReason) return;
    const err: any = new Error('Request timed out');
    err.status = 500;
    imagesEdit.mockRejectedValue(err);

    const rowId = await createPendingRow(2);
    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    const r = await convertProfilePhoto({
      userId,
      photoRowId: rowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('openai_timeout');

    const { data: row } = await supabase
      .from('profile_photos')
      .select('status, failure_reason, retry_count, original_path')
      .eq('id', rowId)
      .single();
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('openai_timeout');
    expect(row?.retry_count).toBe(1);
    // 원본 보존 (재시도 가능).
    expect(row?.original_path).toBe(`${userId}/originals/test.jpg`);
  });

  it('OpenAI 빈 응답 → status=failed (openai_error)', async () => {
    if (skipReason) return;
    imagesEdit.mockResolvedValue({ data: [] });

    const rowId = await createPendingRow(3);
    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    const r = await convertProfilePhoto({
      userId,
      photoRowId: rowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    expect(r.status).toBe('failed');
    const { data: row } = await supabase
      .from('profile_photos')
      .select('status, failure_reason')
      .eq('id', rowId)
      .single();
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('openai_error');
  });

  it('OPENAI_API_KEY 미설정 → status=failed (openai_key_missing) — fail-closed', async () => {
    if (skipReason) return;
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    try {
      const rowId = await createPendingRow(4);
      const { convertProfilePhoto } = await import('../src/services/photoConversion');
      const r = await convertProfilePhoto({
        userId,
        photoRowId: rowId,
        originalBuffer: Buffer.from('original-bytes'),
        mimeType: 'image/jpeg',
        originalPath: `${userId}/originals/test.jpg`,
      });
      expect(r.status).toBe('failed');
      expect(r.failureReason).toBe('openai_key_missing');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      vi.resetModules();
    }
  });

  it('카테고리 매핑 — message 에 "minor" 키워드 → category=minor', async () => {
    if (skipReason) return;
    const err: any = new Error('Image rejected: content policy violation (involves minor)');
    err.status = 400;
    err.code = 'content_policy_violation';
    imagesEdit.mockRejectedValue(err);

    const rowId = await createPendingRow(0); // reuse position 0 (이전 row 가 rejected 였을 수도)
    await supabase.from('profile_photos').delete().eq('id', rowId).neq('id', rowId); // no-op safety
    const newRowId = await createPendingRow(0).catch(async () => {
      // position=0 충돌 시 옛 row 삭제
      await supabase.from('profile_photos').delete().eq('user_id', userId).eq('position', 0);
      return createPendingRow(0);
    });

    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    const r = await convertProfilePhoto({
      userId,
      photoRowId: newRowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    expect(r.status).toBe('rejected');
    expect(r.rejectedCategory).toBe('minor');
  });

  it('moderation_blocks audit row 생성 (surface=photo) — mig 029 적용 시', async () => {
    if (skipReason) return;
    // mig 029 미적용 환경 (surface CHECK 가 photo 미허용) silent skip.
    const probe = await supabase
      .from('moderation_blocks')
      .insert({ sender_id: userId, category: 'sexual', language: 'unknown', surface: 'photo' })
      .select('id');
    if (probe.error) {
      console.warn('[photo-watercolor-pipeline] mig 029 not applied — skipping audit row test');
      return;
    }
    // probe row 정리
    if (probe.data?.[0]?.id) {
      await supabase.from('moderation_blocks').delete().eq('id', probe.data[0].id);
    }

    const err: any = new Error('safety system: explicit sexual content');
    err.status = 400;
    err.code = 'moderation_blocked';
    imagesEdit.mockRejectedValue(err);

    await supabase.from('profile_photos').delete().eq('user_id', userId).eq('position', 1);
    const rowId = await createPendingRow(1);
    const { convertProfilePhoto } = await import('../src/services/photoConversion');
    await convertProfilePhoto({
      userId,
      photoRowId: rowId,
      originalBuffer: Buffer.from('original-bytes'),
      mimeType: 'image/jpeg',
      originalPath: `${userId}/originals/test.jpg`,
    });

    // audit row 가시화 — 비동기 INSERT 가 완료될 시간 필요.
    await new Promise((r) => setTimeout(r, 500));
    const { data: auditRows } = await supabase
      .from('moderation_blocks')
      .select('surface, category')
      .eq('sender_id', userId)
      .eq('surface', 'photo');
    expect(auditRows?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('photoConversion — retryPendingOrFailedPhoto', () => {
  it('URL 백필 row → fetch → 변환 → status=ready', async () => {
    if (skipReason) return;
    // global.fetch 모킹.
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('downloaded-bytes').buffer,
      headers: { get: () => 'image/jpeg' },
    }) as any;

    imagesEdit.mockResolvedValue({
      data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }],
    });

    await supabase.from('profile_photos').delete().eq('user_id', userId).eq('position', 2);
    const rowId = await createPendingRow(2, 'https://example.com/photos/legacy.jpg');
    const { retryPendingOrFailedPhoto } = await import('../src/services/photoConversion');
    const r = await retryPendingOrFailedPhoto(userId, rowId, 'https://example.com/photos/legacy.jpg');

    expect(r.status).toBe('ready');
    global.fetch = origFetch;
  });

  it('download 실패 → status=failed (download_failed)', async () => {
    if (skipReason) return;
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;

    await supabase.from('profile_photos').delete().eq('user_id', userId).eq('position', 3);
    const rowId = await createPendingRow(3, 'https://example.com/photos/legacy.jpg');
    const { retryPendingOrFailedPhoto } = await import('../src/services/photoConversion');
    const r = await retryPendingOrFailedPhoto(userId, rowId, 'https://example.com/photos/legacy.jpg');

    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('download_failed');
    global.fetch = origFetch;
  });
});
