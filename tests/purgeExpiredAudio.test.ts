// audio-expiry sweep eligibility 회귀.
//
// 규칙: "마지막 활동(발송 / 청취 / 재합성)으로부터 30일". 옛 규칙은 청취 기록이
// 있는 row 만 대상으로 삼아 끝내 안 들은 음성이 영구 잔존했다.
//
// 라이브 DB 대신 supabase / storage 모듈 경계 mock — SELECT 체인에 걸린 필터를
// 그대로 기록해 검증한다 (swipe.test.ts 의 hoisted mock 패턴).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  filters: [] as Array<[string, ...unknown[]]>,
  rows: [] as Array<{ id: string; audio_url: string; audio_refreshed_at: string | null }>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/config/supabase', () => {
  const builder = (kind: 'select' | 'update') => {
    const self: Record<string, unknown> = {};
    for (const m of ['select', 'not', 'is', 'lt', 'or', 'eq']) {
      self[m] = (...args: unknown[]) => {
        if (kind === 'select') state.filters.push([m, ...args]);
        return self;
      };
    }
    self.limit = () => Promise.resolve({ data: state.rows, error: null });
    // update 체인은 .not() 이 종단 — thenable 로 노출.
    self.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return self;
  };
  return {
    supabase: {
      from: () => ({
        select: (...args: unknown[]) => {
          const b = builder('select') as Record<string, (...a: unknown[]) => unknown>;
          return b.select(...args);
        },
        update: (payload: Record<string, unknown>) => {
          state.updates.push(payload);
          return builder('update');
        },
      }),
    },
  };
});

const deleted: string[] = [];
vi.mock('../src/services/storage', () => ({
  deleteFile: async (_bucket: string, path: string) => {
    deleted.push(path);
  },
  extractPath: (_bucket: string, url: string) => url.split('/').pop() as string,
}));

import { purgeExpiredAudio } from '../src/jobs/purgeExpiredAudio';

const find = (op: string, column: string) =>
  state.filters.find((f) => f[0] === op && String(f[1]).startsWith(column));

describe('purgeExpiredAudio eligibility', () => {
  beforeEach(() => {
    state.filters = [];
    state.rows = [];
    state.updates = [];
    deleted.length = 0;
  });

  it('보낸 지 30일 경과를 1차 조건으로 건다 (미청취 음성도 대상)', async () => {
    await purgeExpiredAudio();

    const createdAt = find('lt', 'created_at');
    expect(createdAt).toBeDefined();
    const cutoff = new Date(String(createdAt![2]));
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // 옛 규칙 잔재: listened_at NOT NULL 강제는 미청취 음성을 영구 잔존시킨다.
    expect(state.filters).not.toContainEqual(['not', 'listened_at', 'is', null]);
  });

  it('청취 / 재합성 이력이 있으면 그 시점으로부터도 30일을 요구한다', async () => {
    await purgeExpiredAudio();

    const ors = state.filters.filter((f) => f[0] === 'or').map((f) => String(f[1]));
    // 둘 다 "IS NULL OR < cutoff" — 체이닝된 .or() 는 서로 AND 로 결합된다.
    expect(ors.some((o) => o.startsWith('listened_at.is.null,listened_at.lt.'))).toBe(true);
    expect(
      ors.some((o) => o.startsWith('audio_refreshed_at.is.null,audio_refreshed_at.lt.')),
    ).toBe(true);
  });

  it('활성 음성 보유 + 미퍼지 row 만 훑는다', async () => {
    await purgeExpiredAudio();
    expect(state.filters).toContainEqual(['not', 'audio_url', 'is', null]);
    expect(state.filters).toContainEqual(['is', 'audio_purged_at', null]);
  });

  it('대상 row 는 Storage 삭제 후 audio_url=null + audio_purged_at 마킹', async () => {
    state.rows = [{ id: 'm1', audio_url: 'https://x/voice-messages/m1.mp3', audio_refreshed_at: null }];

    const result = await purgeExpiredAudio();

    expect(deleted).toEqual(['m1.mp3']);
    expect(result).toMatchObject({ purged: 1, failed: 0 });
    expect(state.updates[0]).toMatchObject({ audio_url: null });
    expect(state.updates[0].audio_purged_at).toEqual(expect.any(String));
  });
});
