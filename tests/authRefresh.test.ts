// POST /api/auth/refresh 회귀 (2026-09-21 prod 무한로딩 사고).
//
// 공유 GoTrueClient 의 refreshSession 이 굳어 /refresh 가 영구 무응답이 됐고,
// FE 가 모든 요청을 갱신 대기에 묶어 전 화면 무한로딩 → 강제 로그아웃이 났다.
// GoTrue 직접 fetch 로 교체하면서 지켜야 할 계약:
//   * GoTrue 4xx → 401 (세션 사망) — 재시도 없음
//   * 도달 실패 / 5xx → 1회 재시도 후 503 (일시적, FE 는 세션 유지)
//   * 요청에 시간제한 signal 이 반드시 실린다 (무한 대기 금지)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const frozen = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../src/config/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'abortSignal']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: { frozen_at: frozen.value }, error: null });
  return { supabase: chain, supabaseAuth: {} };
});

import { app } from '../src/index';

const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const TOKENS = { access_token: 'new-at', refresh_token: 'new-rt', user: { id: 'u1' } };

let gotrue: ReturnType<typeof vi.fn>;

beforeEach(() => {
  frozen.value = null;
  gotrue = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/auth/v1/token')
      ? gotrue(input, init)
      : realFetch(input, init)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const post = (body: object = { refresh_token: 'old-rt' }) =>
  request(app).post('/api/auth/refresh').send(body);

describe('POST /api/auth/refresh', () => {
  it('정상 → 200 + 새 토큰, 시간제한 signal 동봉', async () => {
    gotrue.mockResolvedValueOnce(json(200, TOKENS));
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access_token: 'new-at', refresh_token: 'new-rt' });
    const init = gotrue.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'old-rt' });
  });

  it('GoTrue 4xx (무효 토큰) → 401, 재시도 안 함', async () => {
    gotrue.mockResolvedValue(json(400, { msg: 'Refresh token is not valid' }));
    const res = await post();
    expect(res.status).toBe(401);
    expect(gotrue).toHaveBeenCalledTimes(1);
  });

  it('도달 실패 1회 → 재시도해서 200', async () => {
    gotrue
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, TOKENS));
    const res = await post();
    expect(res.status).toBe(200);
    expect(gotrue).toHaveBeenCalledTimes(2);
  });

  it('도달 실패 2회 → 503 (401 아님 — FE 가 세션을 버리면 안 됨)', async () => {
    gotrue.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post();
    expect(res.status).toBe(503);
    expect(gotrue).toHaveBeenCalledTimes(2);
  });

  it('GoTrue 5xx 2회 → 503', async () => {
    gotrue.mockImplementation(async () => json(500, {}));
    const res = await post();
    expect(res.status).toBe(503);
    expect(gotrue).toHaveBeenCalledTimes(2);
  });

  it('정지 계정 → 403 account_frozen', async () => {
    frozen.value = '2026-09-01T00:00:00Z';
    gotrue.mockResolvedValueOnce(json(200, TOKENS));
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_frozen');
  });

  it('refresh_token 누락 → 400, GoTrue 호출 안 함', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(gotrue).not.toHaveBeenCalled();
  });
});
