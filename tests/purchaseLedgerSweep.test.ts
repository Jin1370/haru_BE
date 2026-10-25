// 별사탕 구매 내역 5 년 sweep — 탈퇴자 줄만 지우는지 (활동 중 사용자는 잔액 보호).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  ledgerUsers: [] as string[],
  deletedProfiles: [] as string[],
  deleteIds: null as string[] | null,
}));

vi.mock('../src/config/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () =>
        table === 'star_ledger'
          ? {
              eq: () => ({
                lt: () => ({
                  limit: () =>
                    Promise.resolve({ data: state.ledgerUsers.map((user_id) => ({ user_id })), error: null }),
                }),
              }),
            }
          : {
              in: (_c: string, ids: string[]) => ({
                not: () =>
                  Promise.resolve({
                    data: ids.filter((id) => state.deletedProfiles.includes(id)).map((id) => ({ id })),
                    error: null,
                  }),
              }),
            },
      delete: () => ({
        in: (_c: string, ids: string[]) => ({
          lt: () => {
            state.deleteIds = ids;
            return Promise.resolve({ count: ids.length, error: null });
          },
        }),
      }),
    }),
  },
}));

const { sweepExpiredPurchaseLedger } = await import('../src/jobs/cleanupAuditTables');

beforeEach(() => {
  state.ledgerUsers = [];
  state.deletedProfiles = [];
  state.deleteIds = null;
});

describe('sweepExpiredPurchaseLedger', () => {
  it('탈퇴자 줄만 지우고 활동 중 사용자는 건드리지 않는다', async () => {
    state.ledgerUsers = ['active', 'gone', 'gone'];
    state.deletedProfiles = ['gone'];
    await sweepExpiredPurchaseLedger();
    expect(state.deleteIds).toEqual(['gone']);
  });

  it('오래된 줄이 활동 중 사용자 것뿐이면 DELETE 를 호출하지 않는다', async () => {
    state.ledgerUsers = ['active'];
    expect(await sweepExpiredPurchaseLedger()).toBe(0);
    expect(state.deleteIds).toBeNull();
  });
});
