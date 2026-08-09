import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google-cloud/vertexai BEFORE importing the module under test so the
// VertexAI client is never instantiated against real credentials. vi.hoisted
// is required because vi.mock factory runs before module-scope `const` init.
const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock('@google-cloud/vertexai', () => {
  class VertexAI {
    getGenerativeModel() {
      return { generateContent: generateContentMock };
    }
  }
  return {
    VertexAI,
    HarmCategory: {
      HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
      HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    },
    HarmBlockThreshold: {
      BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
    },
  };
});

// Now import after mock is registered.
import { translateMessage, translateVoiceIntro } from '../src/services/translation';

function mockGenerateText(text: string) {
  generateContentMock.mockResolvedValueOnce({
    response: { candidates: [{ content: { parts: [{ text }] } }] },
  });
}

// ── translateMessage — Gemini 1회 호출 = STEP 1(태깅) + STEP 2(번역) ─────────
// prepareTextForTTS regex 폐지 후: raw 텍스트를 그대로 Gemini 에 넘기고, 응답을
// sanitizeAudioTags 로 화이트리스트 검증한다. Gemini 실호출은 모킹 — 태깅 정확도
// (융합 자모 제거·문맥추론 억제)는 Gemini 책임이라 유닛으로 실검증 불가, 아래는
// 계약(raw 전달 + 화이트리스트 sanitize) 검증.
describe('translateMessage', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('raw 텍스트를 그대로 Gemini 에 전달 (사전 태깅 안 함)', async () => {
    mockGenerateText(JSON.stringify({ translation: 'lol hello' }));
    await translateMessage({ text: '안녕 ㅋㅋㅋ', targetLanguage: 'en' });
    const prompt =
      generateContentMock.mock.calls[0]?.[0]?.contents?.[0]?.parts?.[0]?.text ?? '';
    expect(prompt).toContain('Target language: en');
    // 원문 그대로 (regex 로 [laughs] 치환 안 됨).
    expect(prompt).toContain('"안녕 ㅋㅋㅋ"');
    expect(prompt).not.toContain('[laughs]');
  });

  it('화이트리스트 태그는 보존', async () => {
    mockGenerateText(JSON.stringify({ translation: 'so funny [laughs]' }));
    const { translation } = await translateMessage({ text: 'x', targetLanguage: 'en' });
    expect(translation).toBe('so funny [laughs]');
  });

  it('화이트리스트 외/변형 태그는 sanitize 로 제거 (Gemini 규율 이탈 방어)', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hi [laugh] there [angry]' }));
    const { translation } = await translateMessage({ text: 'x', targetLanguage: 'en' });
    expect(translation).toBe('hi there');
  });

  it('malformed 태그도 제거', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hello [laughs 오늘 [sad' }));
    const { translation } = await translateMessage({ text: 'x', targetLanguage: 'ko' });
    expect(translation).toBe('hello 오늘');
  });
});

// ── 호칭(누나/언니/형/오빠) 재계산 컨텍스트 ────────────────────────────────
// Gemini 에 화자/청자 성별·나이를 안 넘겨서 연하 남성의 「お姉さん」이 '언니'로
// 번역되던 사고의 회귀 가드. 실제 호칭 선택은 Gemini 책임이라 유닛으로 검증
// 불가 — 여기선 프로필이 프롬프트에 정확히 실리는지(+ 만 나이 계산)만 본다.
describe('address term context', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function lastPrompt(): string {
    return generateContentMock.mock.calls[0]?.[0]?.contents?.[0]?.parts?.[0]?.text ?? '';
  }

  it('화자/청자의 성별 + 만 나이를 프롬프트에 싣는다', async () => {
    mockGenerateText(JSON.stringify({ translation: '누나 안녕' }));
    await translateMessage({
      text: 'お姉さん、こんにちは',
      targetLanguage: 'ko',
      speaker: { gender: 'male', birthDate: '2000-08-05' },
      addressee: { gender: 'female', birthDate: '1994-01-01' },
    });
    expect(lastPrompt()).toContain('Speaker (who wrote this message): male, 26 years old');
    expect(lastPrompt()).toContain('Addressee (who reads it): female, 32 years old');
  });

  it('생일 전이면 한 살 적게 계산 (만 나이 경계)', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hi' }));
    await translateMessage({
      text: 'x',
      targetLanguage: 'en',
      speaker: { gender: 'male', birthDate: '2000-08-06' }, // 내일 생일
    });
    expect(lastPrompt()).toContain('male, 25 years old');
  });

  it('프로필 누락/무효 날짜는 unknown 으로 표기 (호출은 정상 진행)', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hi' }));
    await translateMessage({
      text: 'x',
      targetLanguage: 'en',
      speaker: { gender: null, birthDate: 'not-a-date' },
    });
    expect(lastPrompt()).toContain('Speaker (who wrote this message): unknown gender, unknown age');
    expect(lastPrompt()).toContain('Addressee (who reads it): unknown gender, unknown age');
  });

  it('voice intro 는 화자 프로필만 싣는다 (수신자 없음)', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ko: '안녕', ja: 'こんにちは', en: 'hi' },
        detected_source_language: 'ko',
      }),
    );
    await translateVoiceIntro({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: ['ko', 'ja', 'en'],
      speaker: { gender: 'female' },
    });
    expect(lastPrompt()).toContain('Speaker (who recorded this intro): female, unknown age');
    expect(lastPrompt()).not.toContain('Addressee');
  });
});

describe('translateVoiceIntro', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('targetLanguages 비어있으면 Vertex AI 미호출 + 빈 객체 반환', async () => {
    const result = await translateVoiceIntro({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: [],
    });
    expect(result.translations).toEqual({});
    expect(result.detectedSourceLanguage).toBe('ko');
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('정상 응답: translations + detectedSourceLanguage 추출', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ja: 'こんにちは', en: 'Hello' },
        detected_source_language: 'ko',
      }),
    );
    const result = await translateVoiceIntro({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    expect(result.translations).toEqual({ ja: 'こんにちは', en: 'Hello' });
    expect(result.detectedSourceLanguage).toBe('ko');
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('응답에 누락된 target 슬롯이 있으면 throw', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ja: 'こんにちは' }, // en 누락
        detected_source_language: 'ko',
      }),
    );
    await expect(
      translateVoiceIntro({
        text: '안녕하세요',
        sourceLanguage: 'ko',
        targetLanguages: ['ja', 'en'],
      }),
    ).rejects.toThrow(/Voice intro translation missing for language: en/);
  });

  it('응답에 빈 문자열이면 throw (defensive)', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ja: '', en: 'Hello' },
        detected_source_language: 'ko',
      }),
    );
    await expect(
      translateVoiceIntro({
        text: '안녕하세요',
        sourceLanguage: 'ko',
        targetLanguages: ['ja', 'en'],
      }),
    ).rejects.toThrow(/Voice intro translation missing for language: ja/);
  });

  it('빈 응답(safety block)이면 throw', async () => {
    generateContentMock.mockResolvedValueOnce({
      response: { candidates: [{ content: { parts: [{}] } }] },
    });
    await expect(
      translateVoiceIntro({
        text: '안녕하세요',
        sourceLanguage: 'ko',
        targetLanguages: ['ja'],
      }),
    ).rejects.toThrow(/Vertex AI returned no text/);
  });

  it('userPrompt 가 sourceLanguage/targetLanguages/text 를 정확히 포함', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ko: '안녕', ja: 'こんにちは' },
        detected_source_language: 'en',
      }),
    );
    await translateVoiceIntro({
      text: 'Hello world',
      sourceLanguage: 'en',
      targetLanguages: ['ko', 'ja'],
    });
    const callArg = generateContentMock.mock.calls[0]?.[0];
    const prompt = callArg?.contents?.[0]?.parts?.[0]?.text ?? '';
    expect(prompt).toContain('Source language: en');
    expect(prompt).toContain('Target languages: ["ko","ja"]');
    expect(prompt).toContain('Voice intro text: "Hello world"');
  });

  it('각 슬롯 출력을 sanitizeAudioTags 로 검증 (변형/malformed 태그 제거)', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ja: 'こんにちは [laugh]', en: 'hello [laughs]' },
        detected_source_language: 'ko',
      }),
    );
    const result = await translateVoiceIntro({
      text: '안녕 ㅋㅋ',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    // ja 의 [laugh] 변형은 제거, en 의 [laughs] 화이트리스트는 보존.
    expect(result.translations).toEqual({ ja: 'こんにちは', en: 'hello [laughs]' });
  });

  it('sanitize 후 빈 문자열이 되는 슬롯은 missing 으로 throw', async () => {
    mockGenerateText(
      JSON.stringify({
        translations: { ja: '[giggles]', en: 'hello' }, // ja 는 화이트리스트 외 태그 단독 → sanitize → ''
        detected_source_language: 'ko',
      }),
    );
    await expect(
      translateVoiceIntro({
        text: 'x',
        sourceLanguage: 'ko',
        targetLanguages: ['ja', 'en'],
      }),
    ).rejects.toThrow(/Voice intro translation missing for language: ja/);
  });
});

// ── 대화 맥락(직전 2턴) 주입 ────────────────────────────────────────────────
// Gemini 응답 품질은 유닛으로 검증 불가하지만, "맥락이 user prompt 에 실제로
// 실렸는가 / 없을 때 블록이 안 생기는가" 는 결정적이라 여기서 잠근다.
describe('translateMessage — conversation context', () => {
  beforeEach(() => generateContentMock.mockReset());

  function lastUserPrompt(): string {
    return generateContentMock.mock.calls[0][0].contents[0].parts[0].text as string;
  }

  it('context 를 주면 Speaker/Addressee 라벨로 오래된 것부터 실린다', async () => {
    mockGenerateText(JSON.stringify({ translation: 'ok' }));
    await translateMessage({
      text: '응 그거',
      targetLanguage: 'ja',
      context: [
        { role: 'addressee', text: '어제 그 영화 봤어?' },
        { role: 'speaker', text: '무슨 영화?' },
      ],
    });
    const p = lastUserPrompt();
    expect(p).toContain('Conversation so far');
    expect(p.indexOf('어제 그 영화 봤어?')).toBeLessThan(p.indexOf('무슨 영화?'));
    expect(p).toContain('Addressee: "어제 그 영화 봤어?"');
    expect(p).toContain('Speaker: "무슨 영화?"');
    // 번역 대상은 여전히 마지막 줄 하나뿐
    expect(p).toContain('Text to translate: "응 그거"');
  });

  it('context 가 없으면 블록 자체가 생기지 않는다', async () => {
    mockGenerateText(JSON.stringify({ translation: 'ok' }));
    await translateMessage({ text: '안녕', targetLanguage: 'ja' });
    expect(lastUserPrompt()).not.toContain('Conversation so far');
  });

  it('빈 배열도 블록을 만들지 않는다', async () => {
    mockGenerateText(JSON.stringify({ translation: 'ok' }));
    await translateMessage({ text: '안녕', targetLanguage: 'ja', context: [] });
    expect(lastUserPrompt()).not.toContain('Conversation so far');
  });
});
