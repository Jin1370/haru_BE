import { z } from 'zod';

// Whitelisted nationalities (ISO-3166-1 alpha-2). Locked at launch policy
// review — adding a new country requires product + i18n + safety sign-off.
// Keep in sync with FE `src/constants/nationalities.ts`.
export const NATIONALITY_CODES = [
  'KR', 'JP', 'US', 'GB', 'CA', 'AU', 'PH', 'SG', 'TH', 'IN',
] as const;

// Whitelisted spoken languages (BCP-47 short codes). Drives both profile
// `language` and `user_preferences.preferred_languages`. App UI locales
// (ko/ja/en) are tracked separately in i18n.
// Keep in sync with FE `src/constants/languages.ts`.
export const LANGUAGE_CODES = ['ko', 'ja', 'en', 'th', 'hi'] as const;

// Profile registration is single-language at launch — chat, translation, and
// TTS all key off the user's primary language, so multi-language with
// proficiency levels added complexity that never affected behaviour. Mig 009
// collapsed the model down to a scalar code.
export const profileUpsertSchema = z.object({
  display_name: z.string().min(1).max(50),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['male', 'female', 'other']),
  nationality: z.enum(NATIONALITY_CODES),
  language: z.enum(LANGUAGE_CODES),
  voice_intro: z.string().max(500).nullable().optional(),
  // mig 011 후속 — preset bypass 메커니즘 (voice-intro-preset-bypass sprint).
  // BE 가 자체 카탈로그(bioPhrasesCatalog)에서 lookup 해 Gemini 호출을 스킵.
  // 미상 id (FE가 신규 추가, BE가 미반영 = OTA 비대칭) 는 reject 하지 않고
  // service 단에서 Gemini 폴백으로 흡수한다 — 사용자 경험 깨짐 방지.
  voice_intro_phrase_id: z.string().min(1).max(64).nullable().optional(),
  interests: z.array(z.string().max(30)).max(10).optional(),
});

// photo-reorder-no-reconvert sprint — PATCH /api/profile/photos/order.
// order = 본인 소유 사진 id 의 배열. 배열의 인덱스가 곧 새 position
// (order[0] → position 0 = 메인). id 배열 채택 근거: position 배열은 stale
// position 을 보내면 엉뚱한 row 를 옮기지만 id 는 row 의 안정적 식별자.
// 길이 1~5 (MAX_PHOTOS), 중복 금지. 완전성(전체 row 포함)/소유권/position0-ready
// 검증은 RPC(mig 030) 가 담당.
export const photoOrderSchema = z.object({
  order: z
    .array(z.string().uuid())
    .min(1)
    .max(5)
    .refine((a) => new Set(a).size === a.length, { message: 'duplicate photo id' }),
});
