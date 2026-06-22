// LAUNCH_CHECKLIST #3 — createSignedUrlFromStored 회귀.
//
// 클론 보이스 버킷(voice-intro-audio)이 private 로 전환되면, DB 에 저장된 public
// 형식 URL 을 읽기 시점에 짧은 TTL 서명 URL 로 변환해야 한다. 이 helper 가
//   * null/빈 입력 → null (무음 카드 자연 degrade)
//   * 저장된 public URL → 경로 추출 → createSignedUrl 호출 → 서명 URL 반환
//   * 잘못된 URL / storage 에러 → null (fail-safe)
// 를 지키는지 검증한다. supabase 클라이언트만 모듈 경계 mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({
  signArgs: null as null | { bucket: string; path: string; expiresIn: number },
  signResult: { data: { signedUrl: 'https://signed.example/x?token=abc' }, error: null } as {
    data: { signedUrl: string } | null;
    error: null | { message: string };
  },
}));

vi.mock('../src/config/supabase', () => ({
  supabase: {
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string, expiresIn: number) {
            captured.signArgs = { bucket, path, expiresIn };
            return captured.signResult;
          },
        };
      },
    },
  },
  supabaseAuth: {},
}));

import { createSignedUrlFromStored, SIGNED_URL_DEFAULT_TTL } from '../src/services/storage';

const BUCKET = 'voice-intro-audio';
const STORED = `https://proj.supabase.co/storage/v1/object/public/${BUCKET}/user-123/voice-intro-ko-1700000000000.mp3`;

beforeEach(() => {
  captured.signArgs = null;
  captured.signResult = {
    data: { signedUrl: 'https://signed.example/x?token=abc' },
    error: null,
  };
});

describe('createSignedUrlFromStored', () => {
  it('returns null for null/undefined/empty input (no storage call)', async () => {
    expect(await createSignedUrlFromStored(BUCKET, null)).toBeNull();
    expect(await createSignedUrlFromStored(BUCKET, undefined)).toBeNull();
    expect(await createSignedUrlFromStored(BUCKET, '')).toBeNull();
    expect(captured.signArgs).toBeNull();
  });

  it('extracts the path from a stored public URL and signs it', async () => {
    const url = await createSignedUrlFromStored(BUCKET, STORED);
    expect(url).toBe('https://signed.example/x?token=abc');
    expect(captured.signArgs).toEqual({
      bucket: BUCKET,
      path: 'user-123/voice-intro-ko-1700000000000.mp3',
      expiresIn: SIGNED_URL_DEFAULT_TTL,
    });
  });

  it('strips an existing query string before extracting the path', async () => {
    await createSignedUrlFromStored(BUCKET, `${STORED}?token=stale`);
    expect(captured.signArgs?.path).toBe('user-123/voice-intro-ko-1700000000000.mp3');
  });

  it('honors a custom expiresIn', async () => {
    await createSignedUrlFromStored(BUCKET, STORED, 120);
    expect(captured.signArgs?.expiresIn).toBe(120);
  });

  it('returns null for a malformed URL (no public marker)', async () => {
    expect(await createSignedUrlFromStored(BUCKET, 'https://example.com/not-storage')).toBeNull();
    expect(captured.signArgs).toBeNull();
  });

  it('returns null when storage signing errors (fail-safe)', async () => {
    captured.signResult = { data: null, error: { message: 'Object not found' } };
    expect(await createSignedUrlFromStored(BUCKET, STORED)).toBeNull();
  });
});
