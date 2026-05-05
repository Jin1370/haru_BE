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
import { translateVoiceIntro } from '../src/services/translation';

function mockGenerateText(text: string) {
  generateContentMock.mockResolvedValueOnce({
    response: { candidates: [{ content: { parts: [{ text }] } }] },
  });
}

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
});
