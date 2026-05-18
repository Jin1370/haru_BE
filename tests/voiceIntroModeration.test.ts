// voice-intro-moderation-unification sprint — audio tag pipeline + 모더레이션 통합 회귀.
//
// 본 sprint 의 두 핵심 변경:
//   A. PUT /api/profile/me 의 voice_intro 변경 분기에 메시지와 동일한 모더레이션 게이트
//      (사전 키워드 차단 + OpenAI Moderation 2차 검수) 적용. preset 경로는 우회 안전.
//   B. services/voiceIntro.ts 의 generateVoiceIntroAudios 가 audio tag pipeline 적용 —
//      작성자 입력 원문을 prepareTextForTTS 로 [laughs]/[sad] 치환 후 (a) Gemini 번역
//      입력 (b) ElevenLabs TTS 입력에 사용. DB 의 voice_intro_translations 슬롯엔
//      replaceTagsForDisplay 거친 display 텍스트 저장.
//
// A 의 통합 테스트는 `tests/profile.test.ts` + `tests/messageModeration.test.ts` 가
// 이미 cover 하는 라이브 DB + supertest 패턴을 따로 추가하지 않는다. 본 파일은 B
// (audio tag pipeline) 의 단위 회귀에 집중하며, A 는 vitest 회귀 (사전 차단 layer 의
// dictionary 정확성) + safety review (라우트 분기 코드) 로 보장한다.
//
// voiceIntro.test.ts 와 동일한 hoisted mock 패턴 — supabase / translation /
// elevenlabs / storage 를 모듈 경계에서 mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const supabaseState: { profile: Record<string, any> } = { profile: {} };
  function makeFromBuilder() {
    let mode: 'select' | 'update' = 'select';
    let selectedColumn: string | null = null;
    let updatePayload: Record<string, any> | null = null;
    const builder: any = {
      select(col: string) {
        mode = 'select';
        selectedColumn = col;
        return builder;
      },
      update(payload: Record<string, any>) {
        mode = 'update';
        updatePayload = payload;
        return builder;
      },
      eq(_col: string, _val: string) {
        return builder;
      },
      async maybeSingle() {
        if (mode !== 'select') return { data: null, error: null };
        if (!selectedColumn) return { data: null, error: null };
        const cols = selectedColumn.split(',').map((c: string) => c.trim());
        const data: Record<string, any> = {};
        for (const c of cols) data[c] = supabaseState.profile[c] ?? null;
        return { data, error: null };
      },
      then(resolve: any) {
        if (mode === 'update' && updatePayload) {
          Object.assign(supabaseState.profile, updatePayload);
          return resolve({ data: null, error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return builder;
  }
  return {
    supabaseState,
    supabaseFromMock: vi.fn(() => makeFromBuilder()),
    translateVoiceIntroMock: vi.fn(),
    synthesizeSpeechMock: vi.fn(),
    uploadFileMock: vi.fn(),
    deleteFileMock: vi.fn(),
    extractPathMock: vi.fn(),
  };
});

vi.mock('../src/config/supabase', () => ({
  supabase: { from: hoisted.supabaseFromMock },
}));
vi.mock('../src/services/translation', () => ({
  translateVoiceIntro: hoisted.translateVoiceIntroMock,
}));
vi.mock('../src/services/elevenlabs', () => ({
  synthesizeSpeech: hoisted.synthesizeSpeechMock,
}));
vi.mock('../src/services/storage', () => ({
  uploadFile: hoisted.uploadFileMock,
  deleteFile: hoisted.deleteFileMock,
  extractPath: hoisted.extractPathMock,
}));

import { generateVoiceIntroAudios } from '../src/services/voiceIntro';

const USER_ID = 'user-mod-1';
const VOICE_ID = 'voice-mod-1';

function resetState() {
  hoisted.supabaseState.profile = {};
  hoisted.supabaseFromMock.mockClear();
  hoisted.translateVoiceIntroMock.mockReset();
  hoisted.synthesizeSpeechMock.mockReset();
  hoisted.uploadFileMock.mockReset();
  hoisted.deleteFileMock.mockReset();
  hoisted.extractPathMock.mockReset();
  hoisted.extractPathMock.mockImplementation((_b: string, url: string) => {
    const idx = url.lastIndexOf('/');
    return idx >= 0 ? url.slice(idx + 1) : url;
  });
  hoisted.uploadFileMock.mockImplementation((_b: string, path: string) =>
    Promise.resolve(`https://cdn.test/${path}`),
  );
  hoisted.synthesizeSpeechMock.mockImplementation(() => Promise.resolve(Buffer.from('audio')));
  hoisted.deleteFileMock.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetState();
});

describe('voiceIntro service — audio tag pipeline (non-preset)', () => {
  it('작성자 슬롯 DB 저장 = display 텍스트 (raw [laughs] 미저장, ㅋㅋㅋ 복원)', async () => {
    // 원문 "안녕 ㅋㅋㅋ" → prepareTextForTTS → "안녕 [laughs]" → display(ko) → "안녕 ㅋㅋㅋ"
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは [laughs]', en: 'hello [laughs]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕 ㅋㅋㅋ', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    // DB 의 ko 슬롯엔 audio tag 가 없고 ㅋㅋㅋ 슬랭으로 복원됨 (raw [laughs] X)
    expect(profile.voice_intro_translations.ko).toBe('안녕 ㅋㅋㅋ');
    expect(profile.voice_intro_translations.ko).not.toContain('[laughs]');
  });

  it('translateVoiceIntro 입력 텍스트가 audio tag 포함 (prepareTextForTTS 적용 후)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'JA', en: 'EN' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '오늘 너무 힘들어 ㅠㅠ', VOICE_ID, 'ko');
    // ㅠㅠ → [sad] 치환된 텍스트가 Gemini 에 전달되어야 한다.
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '오늘 너무 힘들어 [sad]',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
  });

  it('번역 슬롯 DB 저장 = replaceTagsForDisplay 거친 텍스트 (raw [laughs] 미저장)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      // Gemini 가 audio tag 보존 룰로 [laughs] 를 통과시켜 번역문에도 살아있음.
      translations: { ja: 'こんにちは [laughs]', en: 'hello [laughs]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕 ㅋㅋㅋ', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    // ja 슬롯: [laughs] → www, en 슬롯: [laughs] → lol
    expect(profile.voice_intro_translations.ja).toBe('こんにちは www');
    expect(profile.voice_intro_translations.en).toBe('hello lol');
    expect(profile.voice_intro_translations.ja).not.toContain('[laughs]');
    expect(profile.voice_intro_translations.en).not.toContain('[laughs]');
  });

  it('TTS 입력은 audio tag 포함 (eleven_v3 효과음 합성용)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは [laughs]', en: 'hello [laughs]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕 ㅋㅋㅋ', VOICE_ID, 'ko');
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    // 모든 슬롯의 TTS 입력에 audio tag 가 보존되어야 함.
    expect(ttsTexts).toContain('안녕 [laughs]'); // ko 작성자 슬롯
    expect(ttsTexts).toContain('こんにちは [laughs]'); // ja 번역 슬롯
    expect(ttsTexts).toContain('hello [laughs]'); // en 번역 슬롯
  });

  it('emotion marker 없는 텍스트는 audio tag 도입 안 됨 (회귀)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'hello' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    // prepareTextForTTS no-op — Gemini 입력도 원문 그대로.
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_translations).toEqual({
      ko: '안녕하세요',
      ja: 'こんにちは',
      en: 'hello',
    });
  });

  it('emotion marker (ㅋ + ㅠ) 동시 포함 — 각각 audio tag 로 치환', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'JA [laughs] [sad]', en: 'EN [laughs] [sad]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕ㅋㅋ 그래도 슬프네ㅠㅠ', VOICE_ID, 'ko');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '안녕[laughs] 그래도 슬프네[sad]',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    const profile = hoisted.supabaseState.profile;
    // 작성자 ko 슬롯: 디스플레이 텍스트 (ㅋㅋㅋ + ㅠㅠ 복원)
    expect(profile.voice_intro_translations.ko).toBe('안녕ㅋㅋㅋ 그래도 슬프네ㅠㅠ');
    // 번역 슬롯 ja: www + (泣)
    expect(profile.voice_intro_translations.ja).toBe('JA www (泣)');
    // 번역 슬롯 en: lol + :(
    expect(profile.voice_intro_translations.en).toBe('EN lol :(');
  });

  it('audio tag 단독 (ㅋㅋㅋㅋㅋ) — ensureSpeakableForTTS 가 ElevenLabs input_text_empty 회귀 방지', async () => {
    // 사용자가 `ㅋㅋㅋㅋㅋ` 만 입력 → prepareTextForTTS → `[laughs]` 단독.
    // Gemini 도 audio tag 보존 룰로 다른 슬롯에 `[laughs]` 만 반환.
    // ensureSpeakableForTTS 가 마침표를 덧붙이지 않으면 ElevenLabs 가
    // `Input at position 0 has empty text. All inputs must include non-empty
    // text after removing speaker tags and emojis.` 로 reject.
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: '[laughs]', en: '[laughs]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, 'ㅋㅋㅋㅋㅋ', VOICE_ID, 'ko');
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    // 3 슬롯 모두 마침표가 덧붙은 형태로 ElevenLabs 호출.
    expect(ttsTexts).toEqual(expect.arrayContaining(['[laughs].', '[laughs].', '[laughs].']));
    expect(ttsTexts).not.toContain('[laughs]'); // 마침표 없는 raw 태그 단독은 호출되지 않아야 함
  });
});

describe('voiceIntro service — preset bypass (audio tag pipeline 우회)', () => {
  it('preset 경로는 prepareTextForTTS / replaceTagsForDisplay 모두 우회 (카탈로그 텍스트 그대로 저장)', async () => {
    const presetTranslations = {
      ko: '카탈로그 ko 텍스트',
      ja: '카탈로그 ja 텍스트',
      en: 'catalog en text',
    };
    // 사용자가 audio tag 비슷한 텍스트를 보내도 preset 경로는 무시.
    await generateVoiceIntroAudios(
      USER_ID,
      '악의 텍스트 [laughs]',
      VOICE_ID,
      'ko',
      presetTranslations,
    );
    expect(hoisted.translateVoiceIntroMock).not.toHaveBeenCalled();
    const profile = hoisted.supabaseState.profile;
    // DB 의 모든 슬롯이 카탈로그 텍스트 그대로 (display 변환 없음).
    expect(profile.voice_intro_translations).toEqual(presetTranslations);
  });

  it('preset 경로 TTS 입력 = 카탈로그 텍스트 (작성자 페이로드 무시)', async () => {
    const presetTranslations = {
      ko: 'preset ko',
      ja: 'preset ja',
      en: 'preset en',
    };
    await generateVoiceIntroAudios(
      USER_ID,
      '이상한 [laughs] 텍스트',
      VOICE_ID,
      'ko',
      presetTranslations,
    );
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    expect(ttsTexts).toContain('preset ko');
    expect(ttsTexts).toContain('preset ja');
    expect(ttsTexts).toContain('preset en');
    // 작성자 페이로드는 절대 TTS 안 거침.
    expect(ttsTexts.some((t: string) => t.includes('[laughs]'))).toBe(false);
  });

  it('preset + 작성자 ja 언어 → 카탈로그 ja 텍스트 그대로 (회귀)', async () => {
    const presetTranslations = {
      ko: 'preset ko text',
      ja: 'preset ja text',
      en: 'preset en text',
    };
    await generateVoiceIntroAudios(USER_ID, 'preset ja text', VOICE_ID, 'ja', presetTranslations);
    expect(hoisted.translateVoiceIntroMock).not.toHaveBeenCalled();
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_translations).toEqual(presetTranslations);
  });
});
