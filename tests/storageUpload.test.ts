import { describe, it, expect, vi, beforeEach } from 'vitest';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../src/config/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({ upload, getPublicUrl: (p: string) => ({ data: { publicUrl: `https://x/${p}` } }) }),
    },
  },
}));
vi.mock('../src/utils/retry', () => ({
  retryOnce: async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch { return await fn(); }
  },
}));

import { uploadFile } from '../src/services/storage';

const netErr = { name: 'StorageUnknownError', message: 'fetch failed' };
const apiErr = { name: 'StorageApiError', message: 'Payload too large' };

describe('uploadFile retry', () => {
  beforeEach(() => upload.mockReset());

  it('네트워크 에러는 같은 경로로 1회 재시도', async () => {
    upload.mockResolvedValueOnce({ error: netErr }).mockResolvedValueOnce({ error: null });
    await expect(uploadFile('b', 'a/1.mp3', Buffer.from('x'), 'audio/mpeg')).resolves.toBe('https://x/a/1.mp3');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0]).toBe('a/1.mp3');
  });

  it('2연속 네트워크 에러는 기존 메시지로 throw', async () => {
    upload.mockResolvedValue({ error: netErr });
    await expect(uploadFile('b', 'p', Buffer.from('x'), 't')).rejects.toThrow('Storage upload failed: fetch failed');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('4xx 는 재시도 없이 즉시 실패', async () => {
    upload.mockResolvedValue({ error: apiErr });
    await expect(uploadFile('b', 'p', Buffer.from('x'), 't')).rejects.toThrow('Storage upload failed: Payload too large');
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
