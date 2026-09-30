// DAU 기록 (mig 057): KST 날짜 경계 + 사용자당 하루 1 회만 upsert.
import { describe, it, expect, vi } from 'vitest';

const upsert = vi.hoisted(() => vi.fn(() => Promise.resolve({ error: null })));
vi.mock('../src/config/supabase', () => ({
  supabase: { from: () => ({ upsert }) },
  supabaseAuth: {},
}));

const { kstDay, recordDailyActive } = await import('../src/middleware/auth');

describe('daily active', () => {
  it('KST 자정 경계', () => {
    expect(kstDay(Date.parse('2026-09-29T14:59:59Z'))).toBe('2026-09-29');
    expect(kstDay(Date.parse('2026-09-29T15:00:00Z'))).toBe('2026-09-30');
  });

  it('같은 사용자는 하루 1 회만 쓴다', () => {
    recordDailyActive('u1');
    recordDailyActive('u1');
    recordDailyActive('u2');
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
