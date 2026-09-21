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

// ── translateMessage — Gemini 1회 호출 = STEP 1(언어판별) ~ STEP 4(렌더) ─────
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
    // 원문 그대로 (regex 로 [soft laugh] 치환 안 됨).
    expect(prompt).toContain('"안녕 ㅋㅋㅋ"');
    expect(prompt).not.toContain('[soft laugh]');
  });

  it('화이트리스트 태그는 보존', async () => {
    mockGenerateText(JSON.stringify({ translation: 'so funny [soft laugh]' }));
    const { translation } = await translateMessage({ text: 'x', targetLanguage: 'en' });
    expect(translation).toBe('so funny [soft laugh]');
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

  it('already_target_language 를 그대로 노출', async () => {
    mockGenerateText(
      JSON.stringify({ already_target_language: true, translation: '안녕하세요' }),
    );
    const r = await translateMessage({ text: '안녕하세요', targetLanguage: 'ko' });
    expect(r.alreadyTargetLanguage).toBe(true);
  });

  it('키 누락/비-boolean 이면 false — 번역을 한 번 더 보여주는 쪽이 안전', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hello' }));
    expect(
      (await translateMessage({ text: 'x', targetLanguage: 'en' })).alreadyTargetLanguage,
    ).toBe(false);
    mockGenerateText(JSON.stringify({ already_target_language: 'true', translation: 'hello' }));
    expect(
      (await translateMessage({ text: 'x', targetLanguage: 'en' })).alreadyTargetLanguage,
    ).toBe(false);
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

  // 닉네임 '시부'(媤父=시아버지) 오역 사고 — 이름이 프롬프트에 실려야 Gemini 가
  // 보통명사 대신 고유명사로 읽는다. 실제 판단은 모델 몫이라 여기선 주입만 검증.
  it('display_name 을 프로필 라인에 싣는다', async () => {
    mockGenerateText(JSON.stringify({ translation: 'シブさんはどうですか？' }));
    await translateMessage({
      text: '시부님은 어때요?',
      targetLanguage: 'ja',
      speaker: { gender: 'female', birthDate: '1996-03-02', name: '세진' },
      addressee: { gender: 'male', birthDate: '1995-01-01', name: '시부' },
    });
    expect(lastPrompt()).toContain('Speaker (who wrote this message): name "세진", female,');
    expect(lastPrompt()).toContain('Addressee (who reads it): name "시부", male,');
  });

  it('이름이 없거나 공백이면 name 조각을 넣지 않는다', async () => {
    mockGenerateText(JSON.stringify({ translation: 'hi' }));
    await translateMessage({
      text: 'x',
      targetLanguage: 'en',
      speaker: { gender: 'male', birthDate: '2000-01-01', name: '   ' },
      addressee: { gender: 'female', birthDate: '2000-01-01' },
    });
    expect(lastPrompt()).toContain('Speaker (who wrote this message): male,');
    expect(lastPrompt()).toContain('Addressee (who reads it): female,');
    expect(lastPrompt()).not.toContain('name "');
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
        translations: { ja: 'こんにちは [laugh]', en: 'hello [soft laugh]' },
        detected_source_language: 'ko',
      }),
    );
    const result = await translateVoiceIntro({
      text: '안녕 ㅋㅋ',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    // ja 의 [laugh] 변형은 제거, en 의 [soft laugh] 화이트리스트는 보존.
    expect(result.translations).toEqual({ ja: 'こんにちは', en: 'hello [soft laugh]' });
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

// ── already_target_language 오판 가드 (2026-09-08) ─────────────────────────
// prod 사고 2건: STEP 1 boolean 뒤집힘으로 ko↔ja 메시지가 미번역 배달됨 (982건 중 3건).
// 2026-09-19 "네!!! 완전 좋았어요" → target=ja 는 재호출에서도 같은 오판이 나와
// translated_text=null 로 나갔다 — 같은 프롬프트 재호출은 주사위 다시 굴리기였다.
// 이제 타깃 언어 문자가 원문에 0개면 호출 **전** 에 OVERRIDE 로 판정을 확정해 넘긴다.
describe('already_target_language 사전 확정(OVERRIDE) 가드', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  const promptOf = (i: number) =>
    generateContentMock.mock.calls[i][0].contents[0].parts[0].text as string;

  it('한국어 원문 + target ja → 1콜에 OVERRIDE 동봉, 재호출 없음', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'ライラックよく聴きます' }));
    const r = await translateMessage({ text: '라일락 자주 들어요', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).toContain('OVERRIDE');
    expect(promptOf(0)).toContain('NOT written in ja');
    expect(r.alreadyTargetLanguage).toBe(false);
    expect(r.translation).toBe('ライラックよく聴きます');
  });

  it('사고 메시지 "네!!! 완전 좋았어요" → OVERRIDE 대상', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'はい！！！すごく良かったです' }));
    const r = await translateMessage({ text: '네!!! 완전 좋았어요', targetLanguage: 'ja' });
    expect(promptOf(0)).toContain('OVERRIDE');
    expect(r.translation).toBe('はい！！！すごく良かったです');
  });

  it('일본어 원문 + target ko → OVERRIDE 대상', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '한국에서도 유행하는군요' }));
    await translateMessage({ text: '韓国でも流行ってるんですね', targetLanguage: 'ko' });
    expect(promptOf(0)).toContain('NOT written in ko');
  });

  it('영어 원문 + target ko → OVERRIDE 대상 (라틴 발신도 커버)', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'K팝 좋아해요?' }));
    await translateMessage({ text: 'Do you like K-pop?', targetLanguage: 'ko' });
    expect(promptOf(0)).toContain('OVERRIDE');
  });

  it('OVERRIDE 무시하고 true 를 내도 번역만 제대로면 boolean 만 강제 (재호출 없음)', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: true, translation: 'ライラックよく聴きます' }));
    const r = await translateMessage({ text: '라일락 자주 들어요', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(r.alreadyTargetLanguage).toBe(false);
  });

  it('원문에 타깃 문자가 있으면 OVERRIDE 없이 모델 판단을 존중 (코드스위칭)', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: true, translation: 'はい！すごく良かったです' }));
    const r = await translateMessage({ text: 'はい！すごく良かったです', targetLanguage: 'ja' });
    expect(promptOf(0)).not.toContain('OVERRIDE');
    expect(r.alreadyTargetLanguage).toBe(true);
  });

  it('혼합 텍스트도 모델 판단 — 타깃 문자가 섞여 있으면 코드가 단정 못 함', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'ラーメンめっちゃ好きです' }));
    await translateMessage({ text: '라멘 めっちゃ 좋아해요', targetLanguage: 'ja' });
    expect(promptOf(0)).not.toContain('OVERRIDE');
  });

  it('이모지·숫자만 있는 메시지는 판단 보류 — OVERRIDE 안 붙음', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: true, translation: '😂😂 555' }));
    const r = await translateMessage({ text: '😂😂 555', targetLanguage: 'ko' });
    expect(promptOf(0)).not.toContain('OVERRIDE');
    expect(r.alreadyTargetLanguage).toBe(true);
  });

  it('링크만 있는 메시지도 판단 보류 — URL 의 라틴 문자는 글자로 안 셈', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: true, translation: 'https://youtu.be/abc123' }));
    const r = await translateMessage({ text: 'https://youtu.be/abc123', targetLanguage: 'ko' });
    expect(promptOf(0)).not.toContain('OVERRIDE');
    expect(r.alreadyTargetLanguage).toBe(true);
  });

  it('이메일만 있는 메시지도 판단 보류', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: true, translation: 'sejin@gmail.com' }));
    await translateMessage({ text: 'sejin@gmail.com', targetLanguage: 'ja' });
    expect(promptOf(0)).not.toContain('OVERRIDE');
  });

  it('링크 + 한국어 본문 + target ja 는 OVERRIDE 대상 (URL 걷어내면 한글이 남음)', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'これ見て https://youtu.be/abc' }));
    const r = await translateMessage({ text: '이거 봐 https://youtu.be/abc', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).toContain('OVERRIDE');
    expect(r.translation).toBe('これ見て https://youtu.be/abc');
  });

  it('번역이 제대로 나오면 어느 경우에도 Gemini 호출은 1회', async () => {
    const ok: [string, string, string][] = [
      ['라일락', 'ja', 'ライラック'],
      ['はい', 'ja', 'はい'],
      ['😂', 'ko', '😂'],
    ];
    for (const [text, target, translation] of ok) {
      generateContentMock.mockReset();
      mockGenerateText(JSON.stringify({ already_target_language: true, translation }));
      await translateMessage({ text, targetLanguage: target });
      expect(generateContentMock).toHaveBeenCalledTimes(1);
    }
  });
});

// STEP 4(렌더) 실패 가드. prod 사고: "띠동갑 이라는말이 일본에도있어요??" (target=ja)
// 가 "띠동갑이라는 말은 일본에도 있어요？" 로 배달됨 — 띄어쓰기·조사·전각 물음표만
// 손본 한국어다. (출력에 타깃 문자 0개) AND (원문 문자체계가 출력에 잔존) 으로만
// 발동해 정답인 라틴 단독 출력("ok", "Netflix")과 원문 인용 번역(「띠동갑」って…)을 살린다.
describe('렌더 실패 가드', () => {
  beforeEach(() => generateContentMock.mockReset());

  it('사고 케이스: 한국어만 남은 출력 → 재호출해서 일본어 확보', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '띠동갑이라는 말은 일본에도 있어요？' }));
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '「띠동갑」って日本にもありますか？' }));
    const r = await translateMessage({ text: '띠동갑 이라는말이 일본에도있어요??', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(r.translation).toBe('「띠동갑」って日本にもありますか？');
  });

  it('원문 단어를 인용한 정상 번역은 발동 안 함 (타깃 문자가 있음)', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '「띠동갑」って日本にもありますか？' }));
    await translateMessage({ text: '띠동갑 이라는말이 일본에도있어요??', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('정답인 라틴 단독 출력은 발동 안 함 — ok', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'ok' }));
    await translateMessage({ text: '응 그거', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('정답인 라틴 단독 출력은 발동 안 함 — 고유명사', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: 'Netflix' }));
    await translateMessage({ text: '넷플릭스', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('오디오 태그만 남는 출력은 발동 안 함 (ㅋㅋㅋ → [soft laugh])', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '[soft laugh]' }));
    await translateMessage({ text: 'ㅋㅋㅋ', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('재호출도 미번역이면 1차 결과 유지 — 3차 호출 없음', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '띠동갑이라는 말은 일본에도 있어요？' }));
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '띠동갑이라는 말은 일본에도 있어요.' }));
    const r = await translateMessage({ text: '띠동갑 이라는말이 일본에도있어요??', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(r.translation).toBe('띠동갑이라는 말은 일본에도 있어요？');
  });

  it('재호출이 throw 해도 메시지를 잃지 않는다 — 1차 결과 유지', async () => {
    mockGenerateText(JSON.stringify({ already_target_language: false, translation: '띠동갑이라는 말은 일본에도 있어요？' }));
    // safety-block = 응답에 text 가 없는 형태. callGemini 가 내부에서 throw 한다.
    generateContentMock.mockResolvedValue({ response: { candidates: [] } });
    const r = await translateMessage({ text: '띠동갑 이라는말이 일본에도있어요??', targetLanguage: 'ja' });
    expect(r.translation).toBe('띠동갑이라는 말은 일본에도 있어요？');
  }, 10000);

  it('무한 호출 불가 — 모든 응답이 미번역이어도 generateContent 는 정확히 2회', async () => {
    generateContentMock.mockResolvedValue({
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ already_target_language: true, translation: '띠동갑이라는 말은 일본에도 있어요' }) }] } }] },
    });
    await translateMessage({ text: '띠동갑 이라는말이 일본에도있어요??', targetLanguage: 'ja' });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});
