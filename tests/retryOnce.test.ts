// 외부 호출 1회 재시도 헬퍼 회귀 (2026-08-21).
//
// 메시지 파이프라인(번역 → TTS)이 몇 초짜리 네트워크 순단에 audio_status='failed'
// 로 확정되던 문제. 실패했을 때만 돌고, 딱 1 회이며, 두 번째 실패는 그대로 throw
// 해서 호출처의 기존 에러 처리(Sentry 보고 등)가 발화해야 한다.

import { describe, it, expect, vi } from 'vitest';
import { retryOnce } from '../src/utils/retry';

describe('retryOnce', () => {
  it('성공하면 1 회만 호출 — 정상 경로에 영향 없음', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retryOnce(fn, 'test', 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('1차 실패 후 재시도해서 성공 — 호출처는 실패를 모른다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await expect(retryOnce(fn, 'test', 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // console.error 가 아니라 warn — 살아난 건은 Sentry 이벤트가 되면 안 된다.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('두 번 다 실패하면 두 번째 에러를 throw (무한 재시도 없음)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    await expect(retryOnce(fn, 'test', 0)).rejects.toThrow('second');
    expect(fn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
