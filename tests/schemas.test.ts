import { describe, it, expect } from 'vitest';
import { profileUpsertSchema, LANGUAGE_CODES, isAdultBirthDate } from '../src/schemas/profile';

// Pure unit tests against the zod schemas — no DB or HTTP. After mig 009 the
// language model collapsed to scalar `language` on profile and `string[]` on
// preferences; these guards lock the new shape so a regression to the old
// JSONB / level-based model fails loudly here instead of at runtime.

describe('profileUpsertSchema (mig 009 — single scalar language)', () => {
  const validBase = {
    display_name: 'Tester',
    birth_date: '1995-06-15',
    gender: 'male' as const,
    nationality: 'KR' as const,
    language: 'ko' as const,
  };

  it('accepts a minimal valid payload', () => {
    const parsed = profileUpsertSchema.parse(validBase);
    expect(parsed.language).toBe('ko');
  });

  it('rejects missing language (required after mig 009)', () => {
    const { language: _drop, ...withoutLanguage } = validBase;
    const result = profileUpsertSchema.safeParse(withoutLanguage);
    expect(result.success).toBe(false);
  });

  it('rejects unknown language codes (whitelist enforcement)', () => {
    const result = profileUpsertSchema.safeParse({ ...validBase, language: 'fr' });
    expect(result.success).toBe(false);
  });

  it('rejects legacy `languages` JSONB-shape input (no longer in schema)', () => {
    // The old schema accepted languages: [{code, level}]. New zod object should
    // strip it (default zod behaviour) — the cleaned value must not include it
    // so the BE upsert won't accidentally write to a dropped column.
    const result = profileUpsertSchema.parse({
      ...validBase,
      languages: [{ code: 'ko', level: 3 }],
    } as any);
    expect(result).not.toHaveProperty('languages');
  });

  it('exposes the launch whitelist exactly (ko/ja/en/th/hi)', () => {
    expect([...LANGUAGE_CODES].sort()).toEqual(['en', 'hi', 'ja', 'ko', 'th']);
  });

  // LAUNCH_CHECKLIST #5 — 가입 동의 플래그는 옵셔널 boolean. 미전송(프로필 수정)
  // 시 통과해야 기존 동의 기록을 덮어쓰지 않는다.
  it('accepts optional consent flags', () => {
    const parsed = profileUpsertSchema.parse({
      ...validBase,
      terms_consent: true,
      voice_consent: true,
    });
    expect(parsed.terms_consent).toBe(true);
    expect(parsed.voice_consent).toBe(true);
  });

  it('accepts payloads without consent flags (edit path)', () => {
    const parsed = profileUpsertSchema.parse(validBase);
    expect(parsed.terms_consent).toBeUndefined();
    expect(parsed.voice_consent).toBeUndefined();
  });
});

// LAUNCH_CHECKLIST #2 — 서버측 만 18세 미만 차단. 스키마는 형식·캘린더 유효성을
// 거르고(400), 나이 거부는 라우트가 isAdultBirthDate 로 422 응답한다.
describe('birth_date validation (LAUNCH_CHECKLIST #2)', () => {
  const base = {
    display_name: 'Tester',
    gender: 'male' as const,
    nationality: 'KR' as const,
    language: 'ko' as const,
  };

  it('rejects a malformed date (regex)', () => {
    const result = profileUpsertSchema.safeParse({ ...base, birth_date: '95-6-15' });
    expect(result.success).toBe(false);
  });

  it('rejects a calendar-impossible date that passes the regex (2020-99-99)', () => {
    const result = profileUpsertSchema.safeParse({ ...base, birth_date: '2020-99-99' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-leap-year Feb 29 that rolls over (2021-02-29)', () => {
    const result = profileUpsertSchema.safeParse({ ...base, birth_date: '2021-02-29' });
    expect(result.success).toBe(false);
  });

  it('accepts a genuine leap day (2000-02-29)', () => {
    const result = profileUpsertSchema.safeParse({ ...base, birth_date: '2000-02-29' });
    expect(result.success).toBe(true);
  });

  describe('isAdultBirthDate', () => {
    function isoYearsAgo(years: number, dayShift = 0): string {
      const now = new Date();
      const d = new Date(
        Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + dayShift),
      );
      return d.toISOString().slice(0, 10);
    }

    it('accepts someone who turned 18 exactly today', () => {
      expect(isAdultBirthDate(isoYearsAgo(18))).toBe(true);
    });

    it('accepts someone well over 18', () => {
      expect(isAdultBirthDate('1990-01-01')).toBe(true);
    });

    it('rejects someone one day short of 18', () => {
      expect(isAdultBirthDate(isoYearsAgo(18, 1))).toBe(false);
    });

    it('rejects a clearly underage birth date', () => {
      expect(isAdultBirthDate(isoYearsAgo(15))).toBe(false);
    });
  });
});

