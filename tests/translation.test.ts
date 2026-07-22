import { describe, it, expect, vi, beforeEach } from 'vitest';

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
