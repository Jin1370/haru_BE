// 플레이리스트 알림 sweep — 현지 20시 국적만, 최근 활동 + 오늘 안 연 사람만, claim 된 사람만 발송.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  claimed: [] as Array<{ id: string }>,
  calls: [] as Array<[string, string, ...unknown[]]>,
  sent: [] as string[],
}));

vi.mock('../src/config/supabase', () => {
  const chain = (table: string, result: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ['in', 'eq', 'is', 'or', 'gte', 'gt', 'limit', 'select']) {
      self[m] = (...args: unknown[]) => {
        state.calls.push([table, m, ...args]);
        return self;
      };
    }
    self.then = (resolve: (v: unknown) => unknown) => resolve({ data: result(), error: null });
    return self;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => chain(table, () => state.rows[table] ?? []),
        update: () => chain(`${table}:update`, () => state.claimed),
      }),
    },
  };
});

vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: async (id: string) => {
    state.sent.push(id);
  },
}));

import { remindPlaylist } from '../src/jobs/remindPlaylist';

const KST_20 = Date.parse('2026-11-18T20:10:00+09:00');

beforeEach(() => {
  state.rows = {
    profiles: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    daily_active_users: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }], // d 는 오래 안 씀
    discover_playlists: [{ user_id: 'b' }], // b 는 오늘 이미 엶
  };
  state.claimed = [{ id: 'a' }]; // c 는 다른 서버가 먼저 claim
  state.calls = [];
  state.sent = [];
});

describe('remindPlaylist', () => {
  it('현지 20시가 아닌 시각엔 아무것도 안 한다', async () => {
    expect(await remindPlaylist(Date.parse('2026-11-18T00:10:00Z'))).toEqual({ sent: 0 });
    expect(state.calls).toEqual([]);
  });

  it('KST 20시 — KR/JP 대상, 최근 활동 + 안 연 사람을 그날 날짜로 claim 후 claim 된 사람만 발송', async () => {
    expect(await remindPlaylist(KST_20)).toEqual({ sent: 1 });
    expect(state.sent).toEqual(['a']);
    const nat = state.calls.find(([t, m, col]) => t === 'profiles' && m === 'in' && col === 'nationality');
    expect((nat![3] as string[]).sort()).toEqual(['JP', 'KR']);
    const claimIn = state.calls.find(([t, m]) => t === 'profiles:update' && m === 'in');
    expect(claimIn![3]).toEqual(['a', 'c']);
    const claimOr = state.calls.find(([t, m]) => t === 'profiles:update' && m === 'or');
    expect(claimOr![2]).toBe('playlist_reminder_on.is.null,playlist_reminder_on.lt.2026-11-18');
  });
});
