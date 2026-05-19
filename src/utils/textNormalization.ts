// Text normalization for translation/TTS pipeline.
//
// 감정 마커 → eleven_v3 audio tag 치환 + 그에 부속된 display-side 슬랭 복원 유틸.
// 메시지/voice intro 의 번역/TTS 진입 직전 동일하게 적용된다.

interface NormalizationRule {
  pattern: RegExp;
  replacement: string;
}

// ── 감정 마커 → eleven_v3 audio tag 치환 ─────────────────────────────────────
//
// 배경:
//   ㅋ/ㅎ 같은 한국어 자음은 모음 없이 단독으로 표준 음운 형태가 없어 eleven_v3
//   TTS 가 추측 합성 → 영어처럼 들리는 묘한 음("on your lipstick" 등) 생성.
//   일본어 'www', '草', 태국어 '555' 도 그대로 발화하면 부자연스러움.
//   ㅠㅠ/ㅜㅜ 도 phonetic 부재로 비슷한 문제.
//   eleven_v3 인라인 audio tag([laughs]/[sad]) 로 치환해 실제 감정 음성으로 합성.
//   (한숨은 모든 언어에서 의성어 단어 — 에휴/はぁ/ugh 등 — 로 표현되어 Gemini·TTS 가
//    자연 처리 가능, audio tag 우회 불필요. 따라서 [sighs] 는 dictionary 에서 제외.)
//
// 파이프라인 위치 (메시지 도메인):
//   processMessageAudio 에서 Gemini 번역 호출 **이전** 에 적용. Gemini 시스템 프롬프트의
//   audio tag 보존 룰이 번역 과정에서 태그를 그대로 통과시킴 → 출력에 그대로 남아 TTS 가 합성.
//   DB 저장 시엔 stripAudioTags 로 태그 제거 후 translated_text 로 저장 (UI 에 노출 방지).
//
// 사전 정책:
//   * 5 개 타깃 언어(ko/ja/en/th/hi) 의 대표적·모호하지 않은 슬랭만.
//   * 모호 케이스(휴 단독, ओह 등) 는 false positive 위험으로 미포함.
//   * 길이 임계는 false positive 방지에 필요한 최소값 (ha 단독 매칭 X, 2회 이상부터).

const LAUGHTER_RULES: NormalizationRule[] = [
  // Korean — Hangul Compatibility Jamo(ㅋ/ㅎ) 단독·연속 사용은 일반 한국어 텍스트에 등장하지 않으므로
  // 단일 문자도 웃음으로 안전하게 매칭. {1,}로 둘 경우 single ㅋ/ㅎ가 raw 로 통과해 TTS 가 "붸-"
  // 등 묘한 음을 생성하는 사고 방지.
  // 단, **다른 자음 자모가 바로 앞에 오면 약어의 일부**(예: ㅇㅋ=오케이, ㄴㅎ 등) 로 보고 미매칭 —
  // 약어 형태는 Gemini 가 cross-language 에서 자연 번역(ㅇㅋ→OK/オッケー). lookbehind `(?<![ㄱ-ㅎ])`
  // 로 `ㅇ`·`ㄴ`·다른 자음 직후의 ㅋ/ㅎ 를 제외 (음절(`안`/`녕` 등) 직후는 정상 매칭 — 그건 `ㄱ-ㅎ` 범위 밖).
  { pattern: /(?<![ㄱ-ㅎ])ㅋ+/g, replacement: '[laughs]' },
  { pattern: /(?<![ㄱ-ㅎ])ㅎ+/g, replacement: '[laughs]' },
  { pattern: /푸하하+/g, replacement: '[laughs]' },
  { pattern: /와하하+/g, replacement: '[laughs]' },
  // Japanese
  { pattern: /w{3,}/g, replacement: '[laughs]' },
  { pattern: /草+/g, replacement: '[laughs]' },
  { pattern: /あはは+/g, replacement: '[laughs]' },
  { pattern: /ワロタ/g, replacement: '[laughs]' },
  // English (word-bounded; \b 는 ASCII \w 기반이므로 CJK 와 인접해도 정상 동작)
  { pattern: /\b(?:ha){2,}h?\b/gi, replacement: '[laughs]' },
  { pattern: /\b(?:he){2,}h?\b/gi, replacement: '[laughs]' },
  { pattern: /\blol+\b/gi, replacement: '[laughs]' },
  { pattern: /\blmao+\b/gi, replacement: '[laughs]' },
  { pattern: /\brofl\b/gi, replacement: '[laughs]' },
  // Thai
  { pattern: /5{3,}/g, replacement: '[laughs]' },
  { pattern: /ฮ่าๆ+/g, replacement: '[laughs]' },
  // Hindi
  { pattern: /हाहा+/g, replacement: '[laughs]' },
  { pattern: /हीही+/g, replacement: '[laughs]' },
  // Emoticons (모든 언어 공통, TTS 가 문장부호를 글자별 발화하는 사고 차단)
  { pattern: /\b[xX][dD]+\b/g, replacement: '[laughs]' },          // xD XD xDD XDDD
  { pattern: /(?<![a-zA-Z]):-?[dD]+\b/g, replacement: '[laughs]' }, // :D :-D :DD (letter 뒤 URL/식별자 제외)
  { pattern: /(?<![a-zA-Z])=[dD]+\b/g, replacement: '[laughs]' },   // =D =DDD
];

const SAD_RULES: NormalizationRule[] = [
  // Korean — ㅠ/ㅜ 단독도 슬픔 표현 (laughter 와 동일 논리)
  { pattern: /ㅠ+/g, replacement: '[sad]' },
  { pattern: /ㅜ+/g, replacement: '[sad]' },
  { pattern: /흑흑+/g, replacement: '[sad]' },
  { pattern: /엉엉+/g, replacement: '[sad]' },
  // Japanese
  { pattern: /うぅ+/g, replacement: '[sad]' },
  { pattern: /ぴえん/g, replacement: '[sad]' },
  // English (asterisk-bordered 만 — bare "sob"/"sobs" 는 일반 단어와 충돌 위험)
  { pattern: /\*sobs?\*/gi, replacement: '[sad]' },
  // Emoticons (모든 언어 공통). :'( 가 :( 보다 specific 하므로 먼저 매칭되도록 위에 배치.
  { pattern: /:'-?\(+/g, replacement: '[sad]' },         // :'( :'-(  눈물 우는 얼굴
  { pattern: /[:;]-?\(+/g, replacement: '[sad]' },        // :( :-( ;( ;-(  슬픈 얼굴 (괄호 반복 허용)
  { pattern: /[TtQq][_-][TtQq]/g, replacement: '[sad]' }, // T_T T-T t_t Q_Q
  { pattern: /;_;/g, replacement: '[sad]' },              // ;_;
];

// [sighs] 는 dictionary 에서 제외 — 한숨은 모든 언어에서 의성어 단어로 표현되어
// Gemini 가 자연스럽게 번역하고 TTS 도 "haa" 등 적절한 음으로 합성 가능.
// 웃음/슬픔처럼 jamo·약어 수준의 untranslatable 형태로 굳어진 케이스가 없어
// audio tag 우회의 정당성이 약함. stripAudioTags 화이트리스트엔 sighs 가 남아있어
// 외부 경로가 emit 하더라도 UI 안전 (현재는 emit 경로 없음).

const ALL_EMOTION_RULES: NormalizationRule[] = [
  ...LAUGHTER_RULES,
  ...SAD_RULES,
];

/**
 * 텍스트의 감정 마커(웃음/슬픔/한숨)를 eleven_v3 의 인라인 audio tag 로 치환한다.
 * TTS 가 마커 문자를 글자 그대로 발화하지 않고 실제 감정 음성을 생성하도록.
 *
 * 파이프라인: 번역 **이전** 에 적용 → Gemini 가 시스템 프롬프트 룰에 따라 태그 보존
 *   → 번역 후 텍스트에 태그가 살아있는 채로 TTS 에 전달.
 *
 * 5 개 타깃 언어 대표 슬랭 커버 (ko/ja/en/th/hi). 모호 케이스(휴 단독 등) 는 미포함.
 */
export function prepareTextForTTS(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let result = text;
  for (const rule of ALL_EMOTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// ── audio tag 제거 (DB 저장용) ────────────────────────────────────────────────
// translated_text 는 UI 의 번역 인디케이터로 노출되므로 audio tag 노출 방지를 위해
// 저장 직전 제거. TTS 입력(textToSynthesize) 은 태그 보존.
//
// prepareTextForTTS 가 삽입하는 3 종 태그 + eleven_v3 표준 태그 일부를 화이트리스트로 매칭.
const AUDIO_TAG_PATTERN = /\[(?:laughs|sad|sighs|crying|chuckles|whispers|exhales|gasps|groans)\]/g;

/**
 * 텍스트에서 eleven_v3 audio tag(`[laughs]` 등) 만 제거. 주변 공백은 보존 후
 * 최종적으로 연속 공백을 단일화하고 양 끝 trim.
 */
export function stripAudioTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(AUDIO_TAG_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

// ── 디스플레이용: audio tag → 타깃 언어 슬랭 치환 ──────────────────────────────
//
// 메시지 파이프라인에서 translated_text 는 UI 의 번역 인디케이터로 노출되는데,
// audio tag 를 그냥 stripAudioTags 로 제거하면 원본의 감정 표현이 번역본에서 사라짐
// (예: "번역 어때요?ㅋㅋㅋ" → "翻訳はどうですか？" — 웃음이 안 보임).
// 대신 타깃 언어의 자연스러운 슬랭으로 치환해서 의도 보존:
//   ko: ㅋㅋㅋ, ja: www, en: lol, th: 555, hi: हाहा
// TTS 입력엔 audio tag 그대로 유지 (실제 효과음 합성) — 이 함수는 DB 저장·UI 표시 전용.

type DisplayTagName = 'laughs' | 'sad';
type DisplayLang = 'ko' | 'ja' | 'en' | 'th' | 'hi';

const TAG_DISPLAY_SLANG: Record<DisplayTagName, Record<DisplayLang, string>> = {
  laughs: { ko: 'ㅋㅋㅋ', ja: 'www', en: 'lol', th: '555', hi: 'हाहा' },
  sad:    { ko: 'ㅠㅠ',   ja: '(泣)', en: ':(',  th: 'T_T', hi: ':(' },
};

// 알 수 없는 타깃 언어에 대한 fallback (영어 슬랭 — 보편적 인식)
const DEFAULT_TAG_SLANG: Record<DisplayTagName, string> = {
  laughs: 'lol',
  sad: ':(',
};

/**
 * 텍스트의 audio tag(`[laughs]`/`[sad]`)를 타깃 언어의 자연스러운 슬랭으로
 * 치환. translated_text DB 저장 직전에 적용. TTS 입력은 별도 보존.
 */
export function replaceTagsForDisplay(text: string, targetLang: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(/\[(laughs|sad)\]/g, (_match, name: string) => {
      const tagName = name as DisplayTagName;
      const langMap = TAG_DISPLAY_SLANG[tagName];
      const variant = (langMap as Record<string, string>)[targetLang];
      return variant ?? DEFAULT_TAG_SLANG[tagName];
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 메시지에 발화 가능한 콘텐츠가 있는지 검사.
 *   true:  Letter(\p{L}) 또는 Number(\p{N}) 가 1자 이상 있거나, audio tag 가 포함된 경우.
 *   false: 순수 punctuation/symbol/whitespace 만 (`:)`, `<3`, `???`, 이모지 단독 등).
 *
 * 사용처: processMessageAudio 에서 TTS 호출 전 사전 검사 → false 면 TTS 스킵하고
 * audio_url=null 저장. FE 는 `audio_url` 이 null 이면 재생 버튼을 숨김. 발화 불가
 * 메시지에 무음 재생 버튼이 표시되는 UX 사고 방지.
 *
 * 주의: `prepareTextForTTS` 가 emoticon(:(, xD 등) 을 audio tag 로 이미 치환했으므로
 * 그 경로는 tag 매칭으로 true. 매칭 안 된 emoticon(`:)`, `;)`, `:P`, `<3` 등) 만 false.
 */
export function hasSpeakableContent(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  // /g 플래그 없이 단순 test — 상태 공유 회피.
  const audioTagTest = /\[(?:laughs|sad|sighs|crying|chuckles|whispers|exhales|gasps|groans)\]/;
  return /[\p{L}\p{N}]/u.test(text) || audioTagTest.test(text);
}

/**
 * ElevenLabs eleven_v3 는 audio tag 와 이모지를 strip 한 뒤 남는 텍스트가 비어 있으면
 * `input_text_empty` 에러로 reject 한다. 사용자가 `ㅋㅋㅋㅋㅋ`/`ㅠㅠㅠ`/`에휴` 등
 * 감정 마커만 보낸 경우 prepareTextForTTS 결과가 태그 단독이 되어 이 케이스에 해당.
 *
 * 대응: 태그 외 발화 가능한 문자가 없으면 마침표를 덧붙여 ElevenLabs validation 통과.
 * 마침표는 TTS 에서 발화되지 않고 짧은 pause 로만 해석되므로 결과 오디오에 노이즈 없음.
 */
export function ensureSpeakableForTTS(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (stripAudioTags(text) === '' && text.trim() !== '') {
    return `${text}.`;
  }
  return text;
}
