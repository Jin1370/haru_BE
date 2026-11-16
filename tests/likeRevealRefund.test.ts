// 받은 좋아요 공개 환급 — 쓴 그대로(무료·유료) 돌려주고, 두 번 돌려주지 않는다.
// 공개 기록은 어느 경우에도 지우지 않는다 (상대가 돌아오면 열린 카드로 나온다).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  reveal: null as { paid: boolean; free_spent: number; paid_spent: number } | null,
  inserted: [] as any[],
  refs: new Set<string>(),
  deleted: false,
  updated: null as Record<string, unknown> | null,
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
        update: (payload: Record<string, unknown>) => {
          if (table === 'like_reveals') state.updated = payload;
          const q: any = { eq: () => q, then: (f: any) => f({ error: null }) };
          return q;
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
  state.updated = null;
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

  it('무료 카드(paid=false)는 공개 기록을 남긴 채 무료 타이머 계산에서만 빼 무료 카드를 돌려준다', async () => {
    state.reveal = { paid: false, free_spent: 0, paid_spent: 0 };
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: true });
    expect(state.deleted).toBe(false);
    expect(state.updated).toEqual({ paid: true });
    expect(state.inserted).toHaveLength(0);
  });

  it('공개 기록이 없으면 아무것도 돌려주지 않는다', async () => {
    state.reveal = null;
    expect(await refundLikeReveal('me', 'liker')).toEqual({ stars: 0, freeRestored: false });
    expect(state.deleted).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});
