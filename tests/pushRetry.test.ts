import { describe, it, expect, vi, afterEach } from 'vitest';
import { postToExpo } from '../src/services/pushNotifications';

const res = (status: number) => new Response('{}', { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('postToExpo', () => {
  it('2xx 면 재시도 안 함', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4xx 는 우리 페이로드 문제라 재시도 안 함', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(400));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 는 1회만 재시도하고 두 번째 결과를 반환', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx 가 두 번 나면 포기 (무한 재시도 없음)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(503));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('네트워크 에러는 중복 푸시 위험이라 재시도 안 하고 throw', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNRESET'));
    await expect(postToExpo([{ to: 'x' }])).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
