// 스토어 환불 시 별사탕 회수 — 지급 기록의 개수·사용자로 마이너스 한 줄, 재전송은 한 번만.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  purchase: null as null | { user_id: string; delta: number },
  inserted: [] as any[],
  refs: new Set<string>(),
}));

vi.mock('../src/config/supabase', () => {
  const q: any = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => Promise.resolve({ data: state.purchase, error: null }),
  };
  return {
    supabase: {
      from: () => ({
        ...q,
        insert: (row: any) => {
          const key = `${row.kind}:${row.ref}`;
          if (state.refs.has(key)) return Promise.resolve({ error: { code: '23505', message: 'dup' } });
          state.refs.add(key);
          state.inserted.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    },
  };
});

import { revokePurchase } from '../src/services/stars';

beforeEach(() => {
  state.purchase = null;
  state.inserted = [];
  state.refs = new Set();
});

describe('revokePurchase', () => {
  it('지급한 개수만큼 유료 마이너스 한 줄', async () => {
    state.purchase = { user_id: 'u1', delta: 30 };
    expect(await revokePurchase('tx1')).toBe('revoked');
    expect(state.inserted).toEqual([{ user_id: 'u1', delta: -30, paid: true, kind: 'purchase_refund', ref: 'tx1' }]);
  });

  it('같은 환불이 다시 와도 한 번만', async () => {
    state.purchase = { user_id: 'u1', delta: 30 };
    await revokePurchase('tx1');
    expect(await revokePurchase('tx1')).toBe('duplicate');
    expect(state.inserted).toHaveLength(1);
  });

  it('지급 기록 없는 거래는 아무것도 안 함', async () => {
    expect(await revokePurchase('tx-unknown')).toBe('not_found');
    expect(state.inserted).toHaveLength(0);
  });
});
