// audit sweep 의 일시적 네트워크 실패 재시도 회귀.
//
// 2026-08-20 Sentry HARU-BACKEND-H: freeze_events sweep 이 `TypeError: fetch
// failed` 로 죽고 console.error → Sentry 이벤트가 됐다. cutoff DELETE 는
// 멱등이라 1 회 재시도 후에도 실패할 때만 가시화한다.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  results: [] as Array<{ count?: number; error: { message: string } | null }>,
  calls: 0,
}));

vi.mock('../src/config/supabase', () => ({
  supabase: {
    from: () => ({
      delete: () => ({
        lt: () => {
          state.calls += 1;
          return Promise.resolve(state.results.shift() ?? { count: 0, error: null });
        },
      }),
    }),
  },
}));

const { sweepAuditTables } = await import('../src/jobs/cleanupAuditTables');

const fail = { count: undefined, error: { message: 'TypeError: fetch failed' } };
const ok = (count: number) => ({ count, error: null });

beforeEach(() => {
  state.calls = 0;
  state.results = [];
  vi.restoreAllMocks();
});

const TABLES = 5; // AUDIT_TABLES 길이

describe('sweepAuditTable 재시도', () => {
  it('정상이면 테이블당 1 회만 호출', async () => {
    const r = await sweepAuditTables();
    expect(state.calls).toBe(TABLES);
    expect(r.errors).toBe(0);
  });

  it('일시적 실패는 재시도해서 성공하면 error 로 안 센다', async () => {
    // 병렬 실행이라 순서를 못 박는다 — 첫 5 개 응답을 모두 실패로 두고
    // 재시도분(6~10) 을 성공으로 둔다.
    state.results = [...Array(TABLES).fill(fail), ...Array(TABLES).fill(ok(3))];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sweepAuditTables();
    expect(state.calls).toBe(TABLES * 2);
    expect(r.errors).toBe(0);
    expect(r.freezeDeleted).toBe(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it('두 번 다 실패하면 그때 console.error 로 가시화', async () => {
    state.results = Array(TABLES * 2).fill(fail);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sweepAuditTables();
    expect(state.calls).toBe(TABLES * 2);
    expect(r.errors).toBe(TABLES);
    expect(spy).toHaveBeenCalledTimes(TABLES);
  });
});
