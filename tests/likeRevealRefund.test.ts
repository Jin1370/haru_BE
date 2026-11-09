// 받은 좋아요 유료 공개 환급 — 쓴 그대로(무료·유료) 돌려주고, 두 번 돌려주지 않는다.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  reveal: null as { paid: boolean; free_spent: number; paid_spent: number } | null,
  inserted: [] as any[],
  refs: new Set<string>(),
  deleted: false,
}));

vi.mock('../src/config/supabase', () => {
  const chain = (result: () => unknown) => {
    const q: any = { eq: () => q, maybeSingle: () => Promise.resolve(result()) };
    return q;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => chain(() => ({ data: state.reveal, error: null })),
        insert: (rows: any[]) => {
          if (rows.some((r) => state.refs.has(r.ref))) {
            return Promise.resolve({ error: { code: '23505', message: 'dup' } });
          }
          rows.forEach((r) => state.refs.add(r.ref));
          state.inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
        delete: () => {
          state.deleted = table === 'like_reveals';
          const q: any = { eq: () => q, then: (f: any) => f({ error: null }) };
          return q;
        },
      }),
    },
  };
});

const { refundLikeReveal } = await import('../src/services/stars');

beforeEach(() => {
  state.reveal = null;
  state.inserted = [];
  state.refs = new Set();
  state.deleted = false;
});

describe('refundLikeReveal', () => {
  it('무료 1 + 유료 1 로 공개했으면 같은 구성으로 돌려주고 공개를 지운다', async () => {
    state.reveal = { paid: true, free_spent: 1, paid_spent: 1 };
    expect(await refundLikeReveal('me', 'liker')).toBe(2);
    expect(state.inserted.map((r) => [r.delta, r.paid, r.kind])).toEqual([
      [1, false, 'refund'],
      [1, true, 'refund'],
    ]);
    expect(state.deleted).toBe(true);
  });

  it('유료로만 썼으면 유료 줄 하나만', async () => {
    state.reveal = { paid: true, free_spent: 0, paid_spent: 2 };
    expect(await refundLikeReveal('me', 'liker')).toBe(2);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ delta: 2, paid: true });
  });

  it('같은 공개는 두 번 돌려주지 않는다', async () => {
    state.reveal = { paid: true, free_spent: 2, paid_spent: 0 };
    await refundLikeReveal('me', 'liker');
    expect(await refundLikeReveal('me', 'liker')).toBe(0);
    expect(state.inserted).toHaveLength(1);
  });

  it('무료 카드(paid=false)나 공개 기록이 없으면 돌려주지 않는다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0 };
    expect(await refundLikeReveal('me', 'liker')).toBe(0);
    state.reveal = null;
    expect(await refundLikeReveal('me', 'liker')).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });
});
