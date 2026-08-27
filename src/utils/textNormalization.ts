// Text normalization for translation/TTS pipeline.
//
// eleven_v3 audio tag 의 sanitize / strip / display-slang 복원 유틸.
//
// 감정 마커(ㅋㅋ/ㅠㅠ/www/草/lol/xD 등) → audio tag([soft laugh]/[sad]) 치환은 더 이상
// 여기서 regex 로 하지 않는다. Gemini(translation.ts 시스템 프롬프트 STEP 1)가 번역과
// 같은 호출 안에서 실제로 나타난 채팅체 마커만 태그로 치환하고, 그 출력을 아래
// sanitizeAudioTags 로 화이트리스트 검증한다. (regex 바닥 제거 — 융합 자모/문맥 판단은
// Gemini 가 담당.)

// ── audio tag 화이트리스트 ────────────────────────────────────────────────────
// 파이프라인이 허용하는 태그 집합. Gemini 는 [soft laugh]/[sad] 만 emit 하도록
// 지시받고, 규율 이탈 태그가 나와도 여기서 걸러 UI/TTS 오염을 막는다.
//
// 소비처와 같은 집합으로 유지할 것. 이전에는 eleven_v3 표준 태그 7종
// ([sighs]/[crying]/[chuckles]/...) 도 허용했는데, 화이트리스트에 있다는 건 곧
// "통과" 라서 의도와 정반대로 동작했다 — TTS 는 stripNonAudibleTags 가 지우지만
// display 의 replaceTagsForDisplay 는 soft laugh|sad 만 매핑하므로, 나머지가 raw
// 문자열로 translated_text 에 남아 UI 에 노출됐다. 소비처(AUDIO_TAG_PATTERN +
// TAG_DISPLAY_SLANG)를 함께 늘리지 않는 한 태그를 추가하지 말 것.
//
// [soft laugh] 는 제네릭 [laughs] 가 take 마다 웃음의 결이 크게 튀어(설레는 웃음
// ↔ 바보 같은 "흐흐흐") 데이팅 톤에 불안정하던 문제를 좁힌 값. Gemini 프롬프트
// (translation.ts AUDIO_TAG_STEP) 가 처음부터 이 이름으로 emit 하므로 TTS 경계에서
// 재치환하지 않는다. 웃음 결을 조정하려면 프롬프트와 이 상수를 함께 바꿀 것.
const ALLOWED_AUDIO_TAGS = ['soft laugh', 'sad'] as const;
const ALLOWED_AUDIO_TAG_SET = new Set<string>(ALLOWED_AUDIO_TAGS);

/**
 * Gemini 출력에서 화이트리스트 외 태그·malformed 태그를 제거한다.
 * 화이트리스트 태그는 canonical 소문자 형태(`[soft laugh]`)로 정규화.
 *
 *   - `[laughs]` / `[angry]` 등 화이트리스트 외 well-formed 태그 → 제거
 *   - `[soft laugh` 처럼 닫히지 않은 malformed 태그 조각 → 제거
 *   - `[Soft Laugh]` / `[ SOFT  LAUGH ]` → `[soft laugh]` 로 정규화
 *     (대소문자 + 내부 공백만 흡수 — `[softlaugh]` 처럼 이름이 다르면 제거)
 *
 * TTS 입력·번역 파이프라인 진입 직후 적용 (translation.ts). 사용자가 우연히
 * `[note]` 같은 대괄호 텍스트를 쓰면 함께 제거되지만 채팅에서 극히 드물고
 * TTS/UI 안전을 우선한다.
 */
export function sanitizeAudioTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    // well-formed [tag]: 화이트리스트면 canonical 유지, 아니면 제거.
    // 태그명에 공백이 들어갈 수 있어(`soft laugh`) 문자셋에 스페이스를 포함하고,
    // 비교 전에 양끝 trim + 내부 연속 공백을 1칸으로 접는다.
    .replace(/\[\s*([a-zA-Z_][a-zA-Z_ ]{0,19})\s*\]/g, (_m, w: string) => {
      const canonical = w.trim().toLowerCase().split(' ').filter(Boolean).join(' ');
      return ALLOWED_AUDIO_TAG_SET.has(canonical) ? `[${canonical}]` : '';
    })
    // malformed / unclosed tag 조각 (예: 닫는 대괄호 없는 "[laughs").
    .replace(/\[\s*[a-zA-Z_][a-zA-Z_ ]{0,19}(?![\]a-zA-Z_ ])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── audio tag 제거 (DB 저장용) ────────────────────────────────────────────────
// translated_text 는 UI 의 번역 인디케이터로 노출되므로 audio tag 노출 방지를 위해
// 저장 직전 제거. TTS 입력(textToSynthesize) 은 태그 보존.
const AUDIO_TAG_PATTERN = /\[(?:soft laugh|sad)\]/g;

/**
 * 텍스트에서 eleven_v3 audio tag(`[soft laugh]` 등) 만 제거. 주변 공백은 보존 후
 * 최종적으로 연속 공백을 단일화하고 양 끝 trim.
 */
export function stripAudioTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(AUDIO_TAG_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 번역 결과가 사실상 원문 그대로인지 판정 — identity 2차 방어선.
 *
 * 1차는 Gemini STEP 1 의 already_target_language 이고, 이 함수는 그게 false 로
 * 오판됐는데 출력이 원문과 다를 게 없는 경우를 잡는다 (같은 줄이 원문/번역 두 번
 * 노출되는 버그가 정확히 이 케이스였다).
 *
 * 비교 전에 audio tag · 한글 호환 자모(ㅋㅋ/ㅠㅠ 마커, 초성체) · 공백/구두점/이모지를
 * 걷어낸다 — 태깅과 재띄어쓰기만 다른 텍스트를 "같다" 로 보기 위함.
 * 양쪽이 모두 비면(마커만 있던 메시지) false — ko→ja 의 ㅋㅋ→www 처럼 보여줄 값이
 * 있는 경우라, 그 판단은 STEP 1 boolean 에 맡긴다.
 */
export function isTranslationIdentity(translation: string, original: string): boolean {
  const normalize = (s: string) =>
    stripAudioTags(s)
      .replace(/[\u3131-\u318E]+/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase();
  const normalized = normalize(translation);
  return normalized.length > 0 && normalized === normalize(original);
}

// ── TTS 입력 전용: [soft laugh] 만 audible, 그 외 audio tag 는 display-only ─────────
// 사용자 정책: [soft laugh] 만 실제 소리(웃음)로 합성하고, [sad] 등 나머지 태그는
// display(translated_text / voice intro 슬롯)에만 슬랭으로 남기고 TTS 로는 안 낸다
// (클론 보이스가 흐느낌을 내지 않도록). display 경로(replaceTagsForDisplay)는 무변경.
//
// STEP 1 태깅은 sad 마커도 계속 감지해 [sad] 로 정규화 — raw ㅠㅠ 가 TTS 로 새서
// 자모 괴음이 나는 것을 막기 위함. 정규화된 [sad] 를 여기서 TTS 직전에 제거한다.
export function stripNonAudibleTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(AUDIO_TAG_PATTERN, (m) => (m === '[soft laugh]' ? m : ''))
    // 남은 한글 호환 자모(ㄱ-ㅎ, ㅏ-ㅣ) 제거 — 단독 자모는 발화 불가라 합성하면
    // 자모 이름을 읽거나 괴음이 난다. Gemini 가 초성체(ㄷㄱㄷㄱ)를 못 펴서 그대로
    // 흘려보낸 경우의 마지막 방어선. display 경로는 무관(여기는 TTS 입력 전용).
    .replace(/[\u3131-\u318E]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── TTS 입력 전용: 아라비아 숫자 + 고유어 단위 → 한글 수사 ─────────────────────
// TTS 엔진은 숫자를 한자어 수사(일/이/삼)로만 읽어 "1번째" 가 "일번째" 로 합성된다.
// 한국어는 단위(수분류사)마다 고유어 수사(첫/두/세) 자리가 정해져 있어 그 자리에
// 한자어가 들어가면 명백한 오독이다. TTS 입력에서만 치환하고 display 텍스트
// (translated_text / voice intro 슬롯) 는 사용자가 쓴 숫자 그대로 둔다 — display 를
// 바꾸면 identity 판정(senderLang===recipientLang && display===원문)이 깨져 번역
// 인디케이터가 헛뜬다.
//
// 한자어가 맞는 단위(년/월/일/분/초/원/층)와 문맥에 따라 갈리는 단위("세 번" 은
// 고유어지만 "3번 버스" 는 한자어) 는 의도적으로 제외 — 없던 오독을 새로 만들지
// 않는 쪽이 우선.
const NATIVE_NUMERALS = [
  '', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열',
  '열한', '열두', '열세', '열네', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스무',
];

// '개월' 은 한자어(3개월 = 삼 개월). '개' 가 먼저 매칭되지 않도록 alternation 앞에
// 두고 replacer 에서 원문 그대로 돌려보내는 미끼 항목이다.
// ponytail: 21 이상은 그대로 둔다 (스물한/서른두… 조합 테이블이 필요한데 채팅에서
// 거의 안 쓰인다). 필요해지면 여기에 10단위 접두 테이블만 추가.
const NATIVE_COUNTER_PATTERN =
  /(?<!\d)(\d{1,2})(?!\d)\s*(번째|개월|개|명|살|마리|시간|시|잔|병|그릇|가지)/g;

export function readKoreanNumbersForTTS(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(NATIVE_COUNTER_PATTERN, (match, digits: string, counter: string) => {
    if (counter === '개월') return match;
    const word = NATIVE_NUMERALS[Number(digits)];
    if (!word) return match; // 0 · 21 이상
    // 서수 1 만 '첫' ("한 번째" ❌ / "첫 번째" ⭕)
    return `${counter === '번째' && digits === '1' ? '첫' : word} ${counter}`;
  });
}

// ── 디스플레이용: audio tag → 타깃 언어 슬랭 치환 ──────────────────────────────
//
// 메시지 파이프라인에서 translated_text 는 UI 의 번역 인디케이터로 노출되는데,
// audio tag 를 그냥 stripAudioTags 로 제거하면 원본의 감정 표현이 번역본에서 사라짐
// (예: "번역 어때요?ㅋㅋㅋ" → "翻訳はどうですか？" — 웃음이 안 보임).
// 대신 타깃 언어의 자연스러운 슬랭으로 치환해서 의도 보존:
//   ko: ㅋㅋㅋ, ja: www, en: lol, th: 555, hi: हाहा
// TTS 입력엔 audio tag 그대로 유지 (실제 효과음 합성) — 이 함수는 DB 저장·UI 표시 전용.

type DisplayTagName = 'soft laugh' | 'sad';
type DisplayLang = 'ko' | 'ja' | 'en' | 'th' | 'hi';

const TAG_DISPLAY_SLANG: Record<DisplayTagName, Record<DisplayLang, string>> = {
  'soft laugh': { ko: 'ㅋㅋㅋ', ja: 'www', en: 'lol', th: '555', hi: 'हाहा' },
  sad:          { ko: 'ㅠㅠ',   ja: '(泣)', en: ':(',  th: 'T_T', hi: ':(' },
};

// 알 수 없는 타깃 언어에 대한 fallback (영어 슬랭 — 보편적 인식)
const DEFAULT_TAG_SLANG: Record<DisplayTagName, string> = {
  'soft laugh': 'lol',
  sad: ':(',
};

/**
 * 텍스트의 audio tag(`[soft laugh]`/`[sad]`)를 타깃 언어의 자연스러운 슬랭으로
 * 치환. translated_text DB 저장 직전에 적용. TTS 입력은 별도 보존.
 */
export function replaceTagsForDisplay(text: string, targetLang: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(/\[(soft laugh|sad)\]/g, (_match, name: string) => {
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
  const audioTagTest = /\[(?:soft laugh|sad)\]/;
  return /[\p{L}\p{N}]/u.test(text) || audioTagTest.test(text);
}

/**
 * ElevenLabs eleven_v3 는 audio tag 와 이모지를 strip 한 뒤 남는 텍스트가 비어 있으면
 * `input_text_empty` 에러로 reject 한다. 사용자가 `ㅋㅋㅋㅋㅋ`/`ㅠㅠㅠ` 등 감정
 * 마커만 보내 Gemini 출력이 태그 단독(`[soft laugh]`)이 된 경우 이 케이스에 해당.
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
