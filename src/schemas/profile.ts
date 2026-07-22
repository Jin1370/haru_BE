import { z } from 'zod';

// Whitelisted nationalities (ISO-3166-1 alpha-2). Locked at launch policy
// review — adding a new country requires product + i18n + safety sign-off.
// Keep in sync with FE `src/constants/nationalities.ts`.
export const NATIONALITY_CODES = [
  'KR', 'JP', 'US', 'GB', 'CA', 'AU', 'PH', 'SG', 'TH', 'IN',
] as const;

// Whitelisted spoken languages (BCP-47 short codes). Drives profile
// `language` (derived from nationality — see FE languageForNationality).
// App UI locales (ko/ja/en) are tracked separately in i18n.
// Keep in sync with FE `src/constants/languages.ts`.
export const LANGUAGE_CODES = ['ko', 'ja', 'en', 'th', 'hi'] as const;

// Profile registration is single-language at launch — chat, translation, and
// TTS all key off the user's primary language, so multi-language with
// proficiency levels added complexity that never affected behaviour. Mig 009
// collapsed the model down to a scalar code.
// birth_date 게이트 (LAUNCH_CHECKLIST #2 — 서버측 만 18세 미만 차단).
// regex 는 형식만 보장하므로 (2020-99-99 / 2021-02-29 같은 캘린더상 불가능한
// 날짜도 통과) strict 파싱으로 실제 존재하는 날짜인지 검증한다.
// (2021-02-29 → 2021-03-01 로 롤오버되는 케이스까지 거른다)
function isValidCalendarDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

// 만 18세 이상 여부. 모든 계산 UTC 기준 (DB CHECK 의 CURRENT_DATE 와 ±1일 경계
// 외 일치). 형식·캘린더 검증은 스키마(400)가, 나이 거부는 라우트가 422 로 분리
// 처리하므로 여기서는 나이만 본다 (호출 전 isValidCalendarDate 통과 가정).
// DB 측 CHECK (birth_date <= CURRENT_DATE - INTERVAL '18 years', mig 038) 가
// service_role(BE) 의 RLS 우회까지 막는 최종 방어선 — 이 함수는 1차 게이트.
export function isAdultBirthDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  const now = new Date();
  const eighteenYearsAgo = new Date(
    Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()),
  );
  return parsed.getTime() <= eighteenYearsAgo.getTime();
}

export const profileUpsertSchema = z.object({
  display_name: z.string().min(1).max(50),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidCalendarDate, { message: 'must be a valid calendar date' }),
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
  // LAUNCH_CHECKLIST #5 — 가입 동의 모달에서 받은 동의 플래그. 최초 프로필 생성
  // (signup wizard) 시에만 전송되며, BE 가 해당 시 동의 시각·버전을 기록한다.
  // 프로필 수정(settings) 경로는 보내지 않으므로 기존 동의 기록을 덮어쓰지 않는다.
  // terms_consent = 약관 + 개인정보(국외이전 포함) 동의, voice_consent = 음성
  // 생체정보 처리 별도 동의 (PIPA §23).
  terms_consent: z.boolean().optional(),
  voice_consent: z.boolean().optional(),
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
