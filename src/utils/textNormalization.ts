// Slang length normalization for translation/TTS input.
//
// 배경 (voice_slang_normalization sprint, 2026-05-11):
//   짧은 한국어 슬랭은 Gemini 가 자연스럽게 처리 (`ㅋㅋㅋㅋ` → `웃음소리`/`あはは`).
//   그러나 길이 12+ 의 비정형 반복(`ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ`) 은 학습 분포 밖이라
//   "비웃음/탄식"으로 재해석되어 `あ〜` / `はぁ…` 같은 탄식 텍스트로 번역되는
//   경향이 관측됨 → TTS 가 그 탄식 텍스트를 충실히 합성 → "으..." 사운드.
//   정규식 length-capping 만으로 입력을 학습 분포 안의 짧은 형태로 끌어내림.
//
// 적용 지점:
//   * `src/routes/message.ts` processMessageAudio — 번역/TTS 진입 직전.
//   * `src/services/voiceIntro.ts` generateVoiceIntroAudios — 작성자 voice_intro
//     텍스트의 번역/TTS 진입 직전. preset bypass 경로(카탈로그 텍스트)는 정규화 불요.
//
// 정책:
//   * 사전(dictionary) 없이 length-capping 만 — 추후 사전 레이어는 별도 sprint.
//   * lang 인자는 옵셔널: 미전달 시 모든 언어 규칙을 한 번에 적용 (안전한 superset).
//     실제 호출부는 발신자 `profiles.language` 를 넘겨 해당 언어 규칙만 우선 적용 의도.
//   * 양방향 재사용 가능 — 함수가 source 언어 기준으로만 동작하므로
//     ko→ja, ja→ko, en→ko 등 어느 페어든 source 언어 정규화에 사용 가능.
//   * 이 sprint 의 적용 범위는 ko→* 만 — 다른 source 언어 정규화 활성화는
//     호출부에서 lang 인자로 명시적으로 켤 때만 동작 (superset 모드는 lang=null 일 때).

export type NormalizationLang = 'ko' | 'ja' | 'th' | 'en' | 'hi' | null | undefined;

interface NormalizationRule {
  pattern: RegExp;
  replacement: string;
}

// 각 언어별 규칙. 길이 임계는 "이 길이 이상이면 분포 밖" 경험값 + 자연스러운 상한
// (한국어 ㅋ 4개 = 흔한 웃음, 5개 이상은 reduce 해도 의미 손실 없음).
const RULES_BY_LANG: Record<'ko' | 'ja' | 'th', NormalizationRule[]> = {
  ko: [
    { pattern: /ㅋ{4,}/g, replacement: 'ㅋㅋㅋㅋ' },
    { pattern: /ㅎ{4,}/g, replacement: 'ㅎㅎㅎ' },
    { pattern: /ㅠ{3,}/g, replacement: 'ㅠㅠ' },
    { pattern: /ㅜ{3,}/g, replacement: 'ㅜㅜ' },
  ],
  ja: [
    // 일본어 인터넷 슬랭: 'w' 다수 = 웃음(warai). 4개 이상은 'www' 로 cap.
    { pattern: /w{4,}/g, replacement: 'www' },
    // '草' 는 일본어 인터넷에서 '웃음' 의미. 반복 시 1개로 cap.
    { pattern: /草{2,}/g, replacement: '草' },
  ],
  th: [
    // 태국어 인터넷 슬랭: '5' 다수 ("ห้า" = "ha") = 웃음. 4개 이상은 '555' 로 cap.
    { pattern: /5{4,}/g, replacement: '555' },
  ],
};

/**
 * 슬랭/감탄사의 비결정성 입력을 정규화한다 — 번역·TTS 직전 단계 게이트키퍼.
 *
 * @param text 원본 입력
 * @param lang 발신자 언어 코드. 미전달/null 이면 모든 언어 규칙을 적용(superset).
 *             현재 sprint 의 활성 적용 범위는 ko 단독, 그 외는 superset 모드에서만 동작.
 * @returns 길이 정규화된 텍스트. 매칭 없으면 원본 그대로 (referential equality 보장 안 함).
 */
export function normalizeSlangInput(text: string, lang?: NormalizationLang): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let result = text;
  const langsToApply: ('ko' | 'ja' | 'th')[] =
    lang === 'ko' || lang === 'ja' || lang === 'th'
      ? [lang]
      : lang === null || lang === undefined
        ? ['ko', 'ja', 'th']
        : []; // 'en'/'hi' 등 화이트리스트 외 언어는 적용 규칙 없음.

  for (const l of langsToApply) {
    for (const rule of RULES_BY_LANG[l]) {
      result = result.replace(rule.pattern, rule.replacement);
    }
  }

  return result;
}
