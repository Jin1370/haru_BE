import { describe, it, expect } from 'vitest';
import { profileUpsertSchema, LANGUAGE_CODES } from '../src/schemas/profile';
import { preferenceSchema } from '../src/schemas/preference';

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
});

describe('preferenceSchema (mig 009 — preferred_languages: string[])', () => {
  it('accepts an empty preferred_languages array', () => {
    const parsed = preferenceSchema.parse({});
    expect(parsed.preferred_languages).toEqual([]);
  });

  it('accepts whitelisted codes', () => {
    const parsed = preferenceSchema.parse({
      preferred_languages: ['ko', 'ja'],
    });
    expect(parsed.preferred_languages).toEqual(['ko', 'ja']);
  });

  it('rejects unknown codes', () => {
    const result = preferenceSchema.safeParse({
      preferred_languages: ['ko', 'fr'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects legacy `{code, level}` proficiency objects', () => {
    const result = preferenceSchema.safeParse({
      preferred_languages: [{ code: 'ko', level: 2 }],
    } as any);
    expect(result.success).toBe(false);
  });

  it('drops the legacy preferred_languages_detail key (unknown after mig 009)', () => {
    const parsed = preferenceSchema.parse({
      preferred_languages_detail: [{ code: 'ko', level: 1 }],
    } as any);
    expect(parsed).not.toHaveProperty('preferred_languages_detail');
    expect(parsed.preferred_languages).toEqual([]);
  });
});
