import { z } from 'zod';

// Whitelisted nationalities (ISO-3166-1 alpha-2). Locked at launch policy
// review — adding a new country requires product + i18n + safety sign-off.
// Keep in sync with FE `src/constants/nationalities.ts`.
export const NATIONALITY_CODES = [
  'KR', 'JP', 'US', 'GB', 'CA', 'AU', 'PH', 'SG', 'TH', 'IN',
] as const;

// Whitelisted spoken languages (BCP-47 short codes). Drives both profile
// `languages[]` and `user_preferences.preferred_languages_detail`. App UI
// locales (ko/ja/en) are tracked separately in i18n.
// Keep in sync with FE `src/constants/languages.ts`.
export const LANGUAGE_CODES = ['ko', 'ja', 'en', 'th', 'hi'] as const;

// 1 = beginner, 2 = intermediate (daily conversation),
// 3 = native (fluent / unrestricted conversation).
export const languageProficiencySchema = z.object({
  code: z.enum(LANGUAGE_CODES),
  level: z.number().int().min(1).max(3),
});

export const profileUpsertSchema = z.object({
  display_name: z.string().min(1).max(50),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['male', 'female', 'other']),
  nationality: z.enum(NATIONALITY_CODES),
  // Legacy primary language (used by the translation/TTS pipeline). Optional
  // when `languages[]` is supplied — the route derives it from languages[0].
  language: z.enum(LANGUAGE_CODES).optional(),
  // Multi-language with proficiency. When present, languages[0] becomes the
  // primary `language`. Required to be non-empty if provided.
  languages: z.array(languageProficiencySchema).min(1).max(10).optional(),
  voice_intro: z.string().max(500).nullable().optional(),
  interests: z.array(z.string().max(30)).max(10).optional(),
}).refine((data) => data.language || (data.languages && data.languages.length > 0), {
  message: 'Either language or languages must be provided',
  path: ['language'],
});
