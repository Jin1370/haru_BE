// 받은 좋아요 공개 환급 — 쓴 그대로(무료·유료) 돌려주고, 두 번 돌려주지 않는다.
// 공개 기록은 어느 경우에도 지우지 않는다 (상대가 돌아오면 열린 카드로 나온다).
// 무료로 연 카드는 언제 열었든 무료 카드 한 장, 24시간 타이머는 건드리지 않는다 (mig 069).

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Reveal = {
  paid: boolean;
  free_spent: number;
  paid_spent: number;
  free_credit?: boolean;
  free_refunded?: boolean;
};

const state = vi.hoisted(() => ({
  reveal: null as Reveal | null,
  updateRows: 1, // 조건부 갱신이 바꾼 줄 수 (0 = 다른 요청이 먼저 돌려줌)
  grantError: null as null | { message: string },
  inserted: [] as any[],
  refs: new Set<string>(),
  deleted: false,
  updates: [] as Record<string, unknown>[],
  rpcCalls: [] as string[],
}));

vi.mock('../src/config/supabase', () => {
  const thenable = (result: () => unknown) => {
    const q: any = {
      eq: () => q,
      select: () => q,
      maybeSingle: () => Promise.resolve(result()),
      then: (f: any, r: any) => Promise.resolve(result()).then(f, r),
    };
    return q;
  };
  return {
    supabase: {
      rpc: (name: string) => {
        state.rpcCalls.push(name);
        return Promise.resolve({ error: state.grantError });
      },
      from: (table: string) => ({
        select: () => thenable(() => ({ data: state.reveal, error: null })),
        insert: (rows: any[]) => {
          if (rows.some((r) => state.refs.has(r.ref))) {
            return Promise.resolve({ error: { code: '23505', message: 'dup' } });
          }
          rows.forEach((r) => state.refs.add(r.ref));
          state.inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          if (table === 'like_reveals') state.updates.push(payload);
          return thenable(() => ({
            data: Array.from({ length: state.updateRows }, () => ({ liker_id: 'liker' })),
            error: null,
          }));
        },
        delete: () => {
          state.deleted = table === 'like_reveals';
          return thenable(() => ({ error: null }));
        },
      }),
    },
  };
});

const { refundLikeReveal } = await import('../src/services/stars');

beforeEach(() => {
  state.reveal = null;
  state.updateRows = 1;
  state.grantError = null;
  state.inserted = [];
  state.refs = new Set();
  state.deleted = false;
  state.updates = [];
  state.rpcCalls = [];
});

describe('refundLikeReveal', () => {
  it('무료 1 + 유료 1 로 공개했으면 같은 구성으로 돌려주고 공개 기록은 남긴다', async () => {
    state.reveal = { paid: true, free_spent: 1, paid_spent: 1 };
    expect((await refundLikeReveal('me', 'liker')).stars).toBe(2);
    expect(state.inserted.map((r) => [r.delta, r.paid, r.kind])).toEqual([
      [1, false, 'refund'],
      [1, true, 'refund'],
    ]);
    expect(state.deleted).toBe(false);
  });

  it('유료로만 썼으면 유료 줄 하나만', async () => {
    state.reveal = { paid: true, free_spent: 0, paid_spent: 2 };
    expect((await refundLikeReveal('me', 'liker')).stars).toBe(2);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ delta: 2, paid: true });
  });

  it('같은 공개는 두 번 돌려주지 않는다', async () => {
    state.reveal = { paid: true, free_spent: 2, paid_spent: 0 };
    await refundLikeReveal('me', 'liker');
    expect((await refundLikeReveal('me', 'liker')).stars).toBe(0);
    expect(state.inserted).toHaveLength(1);
  });

  it('무료로 연 카드 — 한 장을 쌓고, 타이머(paid)는 건드리지 않는다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0, free_credit: false, free_refunded: false };
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: true });
    expect(state.updates).toEqual([{ free_refunded: true }]);
    expect(state.rpcCalls).toEqual(['grant_like_free_credit']);
    expect(state.deleted).toBe(false);
  });

  it('돌려받은 무료 카드로 연 카드도 사라지면 다시 한 장을 쌓는다', async () => {
    state.reveal = { paid: true, free_spent: 0, paid_spent: 0, free_credit: true, free_refunded: false };
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: true });
    expect(state.rpcCalls).toEqual(['grant_like_free_credit']);
    expect(state.inserted).toHaveLength(0);
  });

  it('이미 돌려준 무료 카드는 다시 주지 않는다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0, free_credit: false, free_refunded: true };
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: false });
    expect(state.rpcCalls).toEqual([]);
  });

  it('다른 요청이 먼저 돌려줬으면(갱신된 줄 0) 쌓지 않는다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0, free_credit: false, free_refunded: false };
    state.updateRows = 0;
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: false });
    expect(state.rpcCalls).toEqual([]);
  });

  it('쌓기에 실패하면 표시를 되돌려 돌려준 것으로 치지 않는다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0, free_credit: false, free_refunded: false };
    state.grantError = { message: 'boom' };
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: false });
    expect(state.updates).toEqual([{ free_refunded: true }, { free_refunded: false }]);
  });

  it('공개 기록이 없으면 아무것도 돌려주지 않는다', async () => {
    state.reveal = null;
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: false });
    expect(state.deleted).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});
