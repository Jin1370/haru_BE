// 목소리 미등록 리마인더 sweep eligibility + 1회성 보장 회귀.
// 라이브 DB 대신 supabase / push 모듈 경계 mock (purgeExpiredAudio.test.ts 패턴).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  filters: [] as Array<[string, ...unknown[]]>,
  profiles: [] as Array<{ id: string }>,
  tokens: [] as Array<{ user_id: string }>,
  claimed: [] as Array<{ id: string }>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/config/supabase', () => {
  const chain = (table: string, kind: 'select' | 'update') => {
    const self: Record<string, unknown> = {};
    for (const m of ['is', 'eq', 'lt', 'in']) {
      self[m] = (...args: unknown[]) => {
        if (kind === 'select' && table === 'profiles') state.filters.push([m, ...args]);
        if (kind === 'update' && table === 'profiles') state.filters.push([`update:${m}`, ...args]);
        return self;
      };
    }
    self.limit = () => Promise.resolve({ data: state.profiles, error: null });
    // device_tokens 는 .in() 이 종단, update 체인은 .select() 가 종단.
    self.select = () => Promise.resolve({ data: state.claimed, error: null });
    self.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: table === 'device_tokens' ? state.tokens : null, error: null });
    return self;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => chain(table, 'select'),
        update: (payload: Record<string, unknown>) => {
          state.updates.push(payload);
          return chain(table, 'update');
        },
      }),
    },
  };
});

const pushed: string[] = [];
vi.mock('../src/services/pushNotifications', () => ({
  sendPushToUser: async (id: string) => {
    pushed.push(id);
  },
}));

import { remindVoiceSetup, nationalitiesAtSendHour } from '../src/jobs/remindVoiceSetup';

// 12:00 UTC = KST/JST 21:00 → KR/JP 만 발송 window.
const KR_EVENING = Date.UTC(2026, 7, 4, 12, 5, 0);

describe('remindVoiceSetup', () => {
  beforeEach(() => {
    state.filters = [];
    state.profiles = [];
    state.tokens = [];
    state.claimed = [];
    state.updates = [];
    pushed.length = 0;
    vi.useFakeTimers().setSystemTime(KR_EVENING);
  });

  it('현지 저녁 9시인 국적만 대상 (반시간 offset 포함)', () => {
    expect(nationalitiesAtSendHour(KR_EVENING)).toEqual(['KR', 'JP']);
    // IN(+5:30) 은 15:30 UTC 대에 21시대가 된다.
    expect(nationalitiesAtSendHour(Date.UTC(2026, 7, 4, 16, 5, 0))).toContain('IN');
    // 아무 국적도 21시가 아닌 tick 은 쿼리 자체를 안 돌린다.
    expect(nationalitiesAtSendHour(Date.UTC(2026, 7, 4, 6, 5, 0))).toEqual([]);
  });

  it('발송 window 밖 tick 은 DB 를 건드리지 않는다', async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 4, 6, 5, 0));
    const result = await remindVoiceSetup();
    expect(result).toEqual({ sent: 0 });
    expect(state.filters).toEqual([]);
  });

  it('미등록 + 미발송 + 가입 1h 경과 + 활성 사용자만 훑는다', async () => {
    await remindVoiceSetup();

    expect(state.filters).toContainEqual(['is', 'elevenlabs_voice_id', null]);
    expect(state.filters).toContainEqual(['is', 'voice_reminder_sent_at', null]);
    expect(state.filters).toContainEqual(['eq', 'is_active', true]);
    expect(state.filters).toContainEqual(['in', 'nationality', ['KR', 'JP']]);

    const createdAt = state.filters.find((f) => f[0] === 'lt' && f[1] === 'created_at');
    expect(createdAt).toBeDefined();
    const hours = (Date.now() - new Date(String(createdAt![2])).getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThan(1.1);
  });

  it('푸시 토큰 없는 사용자는 발송도 마킹도 하지 않는다', async () => {
    state.profiles = [{ id: 'u1' }];
    state.tokens = [];

    const result = await remindVoiceSetup();

    expect(result).toEqual({ sent: 0 });
    expect(pushed).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('claim 이 성공한 사용자에게만 발송한다 (동시 sweep 중복 차단)', async () => {
    state.profiles = [{ id: 'u1' }, { id: 'u2' }];
    state.tokens = [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }];
    state.claimed = [{ id: 'u1' }]; // u2 는 다른 워커가 먼저 claim

    const result = await remindVoiceSetup();

    expect(result).toEqual({ sent: 1 });
    expect(pushed).toEqual(['u1']);
    // 마킹은 발송 전에, voice_reminder_sent_at IS NULL 가드와 함께.
    expect(state.updates[0].voice_reminder_sent_at).toEqual(expect.any(String));
    expect(state.filters).toContainEqual(['update:is', 'voice_reminder_sent_at', null]);
  });
});
