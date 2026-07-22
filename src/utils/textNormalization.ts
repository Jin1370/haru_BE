// Text normalization for translation/TTS pipeline.
//
// eleven_v3 audio tag 의 sanitize / strip / display-slang 복원 유틸.
//
// 감정 마커(ㅋㅋ/ㅠㅠ/www/草/lol/xD 등) → audio tag([laughs]/[sad]) 치환은 더 이상
// 여기서 regex 로 하지 않는다. Gemini(translation.ts 시스템 프롬프트 STEP 1)가 번역과
// 같은 호출 안에서 실제로 나타난 채팅체 마커만 태그로 치환하고, 그 출력을 아래
// sanitizeAudioTags 로 화이트리스트 검증한다. (regex 바닥 제거 — 융합 자모/문맥 판단은
// Gemini 가 담당.)

// ── audio tag 화이트리스트 ────────────────────────────────────────────────────
// eleven_v3 표준 태그 중 파이프라인이 허용하는 집합. Gemini 는 [laughs]/[sad] 만
// emit 하도록 지시받지만, 규율 이탈 태그가 나와도 이 화이트리스트로 걸러 UI/TTS
// 오염을 막는다.
const ALLOWED_AUDIO_TAGS = [
  'laughs',
  'sad',
  'sighs',
  'crying',
  'chuckles',
  'whispers',
  'exhales',
  'gasps',
  'groans',
] as const;
const ALLOWED_AUDIO_TAG_SET = new Set<string>(ALLOWED_AUDIO_TAGS);

/**
 * Gemini 출력에서 화이트리스트 외 태그·malformed 태그를 제거한다.
 * 화이트리스트 태그는 canonical 소문자 형태(`[laughs]`)로 정규화.
 *
 *   - `[laugh]` / `[angry]` 등 화이트리스트 외 well-formed 태그 → 제거
 *   - `[laughs` 처럼 닫히지 않은 malformed 태그 조각 → 제거
 *   - `[LAUGHS]` / `[ laughs ]` → `[laughs]` 로 정규화
 *
 * TTS 입력·번역 파이프라인 진입 직후 적용 (translation.ts). 사용자가 우연히
 * `[note]` 같은 대괄호 텍스트를 쓰면 함께 제거되지만 채팅에서 극히 드물고
 * TTS/UI 안전을 우선한다.
 */
export function sanitizeAudioTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    // well-formed [tag]: 화이트리스트면 canonical 유지, 아니면 제거.
    .replace(/\[\s*([a-zA-Z_]{1,20})\s*\]/g, (_m, w: string) =>
      ALLOWED_AUDIO_TAG_SET.has(w.toLowerCase()) ? `[${w.toLowerCase()}]` : '',
    )
    // malformed / unclosed tag 조각 (예: 닫는 대괄호 없는 "[laughs").
    .replace(/\[\s*[a-zA-Z_]{1,20}(?![\]a-zA-Z_])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── audio tag 제거 (DB 저장용) ────────────────────────────────────────────────
// translated_text 는 UI 의 번역 인디케이터로 노출되므로 audio tag 노출 방지를 위해
// 저장 직전 제거. TTS 입력(textToSynthesize) 은 태그 보존.
const AUDIO_TAG_PATTERN = /\[(?:laughs|sad|sighs|crying|chuckles|whispers|exhales|gasps|groans)\]/g;

/**
 * 텍스트에서 eleven_v3 audio tag(`[laughs]` 등) 만 제거. 주변 공백은 보존 후
 * 최종적으로 연속 공백을 단일화하고 양 끝 trim.
 */
export function stripAudioTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(AUDIO_TAG_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

// ── TTS 입력 전용: [laughs] 만 audible, 그 외 audio tag 는 display-only ─────────
// 사용자 정책: [laughs] 만 실제 소리(웃음)로 합성하고, [sad] 등 나머지 태그는
// display(translated_text / voice intro 슬롯)에만 슬랭으로 남기고 TTS 로는 안 낸다
// (클론 보이스가 흐느낌을 내지 않도록). display 경로(replaceTagsForDisplay)는 무변경.
//
// STEP 1 태깅은 sad 마커도 계속 감지해 [sad] 로 정규화 — raw ㅠㅠ 가 TTS 로 새서
// 자모 괴음이 나는 것을 막기 위함. 정규화된 [sad] 를 여기서 TTS 직전에 제거한다.
export function stripNonAudibleTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(AUDIO_TAG_PATTERN, (m) => (m === '[laughs]' ? m : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
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
 * 주의: Gemini 가 emoticon(:(, xD 등) 을 audio tag 로 치환한 경우 그 경로는 tag
 * 매칭으로 true. 태그화 안 된 emoticon(`:)`, `;)`, `:P`, `<3` 등) 만 false.
 */
export function hasSpeakableContent(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  // /g 플래그 없이 단순 test — 상태 공유 회피.
  const audioTagTest = /\[(?:laughs|sad|sighs|crying|chuckles|whispers|exhales|gasps|groans)\]/;
  return /[\p{L}\p{N}]/u.test(text) || audioTagTest.test(text);
}

/**
 * ElevenLabs eleven_v3 는 audio tag 와 이모지를 strip 한 뒤 남는 텍스트가 비어 있으면
 * `input_text_empty` 에러로 reject 한다. 사용자가 `ㅋㅋㅋㅋㅋ`/`ㅠㅠㅠ` 등 감정
 * 마커만 보내 Gemini 출력이 태그 단독(`[laughs]`)이 된 경우 이 케이스에 해당.
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
