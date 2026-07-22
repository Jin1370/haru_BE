// voice-intro-moderation-unification sprint — audio tag pipeline + 모더레이션 통합 회귀.
//
// 본 sprint 의 두 핵심 변경:
//   A. PUT /api/profile/me 의 voice_intro 변경 분기에 메시지와 동일한 모더레이션 게이트
//      (사전 키워드 차단 + OpenAI Moderation 2차 검수) 적용. preset 경로는 우회 안전.
//   B. services/voiceIntro.ts 의 generateVoiceIntroAudios 가 audio tag pipeline 적용 —
//      작성자 입력 원문을 raw 로 Gemini 에 넘겨 STEP 1(감정 마커 → [laughs]/[sad]) +
//      STEP 2(각 언어 렌더, 작성자 슬롯 포함) 를 1회 호출로 처리. Gemini 반환값이
//      (a) ElevenLabs TTS 입력 (b) replaceTagsForDisplay 거친 display 텍스트로 저장.
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

describe('voiceIntro service — audio tag pipeline (non-preset, Gemini 단독 태깅)', () => {
  it('Gemini 에 raw 원문 전달 (사전 regex 태깅 없음) + 작성자 슬롯 포함 3슬롯 요청', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: {
        ko: '오늘 너무 힘들어 [sad]',
        ja: 'JA [sad]',
        en: 'EN [sad]',
      },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '오늘 너무 힘들어 ㅠㅠ', VOICE_ID, 'ko');
    // 원문 그대로 Gemini 로 (ㅠㅠ → [sad] 치환은 Gemini STEP 1 이 함).
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '오늘 너무 힘들어 ㅠㅠ',
      sourceLanguage: 'ko',
      targetLanguages: ['ko', 'ja', 'en'],
    });
  });

  it('작성자 슬롯 DB 저장 = display 텍스트 (Gemini 태깅 → 슬랭 복원, raw [laughs] 미저장)', async () => {
    // 원문 "안녕 ㅋㅋㅋ" → Gemini(ko 슬롯) "안녕 [laughs]" → display(ko) → "안녕 ㅋㅋㅋ"
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: {
        ko: '안녕 [laughs]',
        ja: 'こんにちは [laughs]',
        en: 'hello [laughs]',
      },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕 ㅋㅋㅋ', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_translations.ko).toBe('안녕 ㅋㅋㅋ');
    expect(profile.voice_intro_translations.ko).not.toContain('[laughs]');
  });

  it('번역 슬롯 DB 저장 = replaceTagsForDisplay 거친 텍스트 (raw [laughs] 미저장)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: {
        ko: '안녕 [laughs]',
        ja: 'こんにちは [laughs]',
        en: 'hello [laughs]',
      },
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
      translations: {
        ko: '안녕 [laughs]',
        ja: 'こんにちは [laughs]',
        en: 'hello [laughs]',
      },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕 ㅋㅋㅋ', VOICE_ID, 'ko');
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    // 모든 슬롯의 TTS 입력에 audio tag 가 보존되어야 함 (Gemini 반환값 그대로).
    expect(ttsTexts).toContain('안녕 [laughs]'); // ko 작성자 슬롯
    expect(ttsTexts).toContain('こんにちは [laughs]'); // ja 번역 슬롯
    expect(ttsTexts).toContain('hello [laughs]'); // en 번역 슬롯
  });

  it('emotion marker 없는 텍스트는 audio tag 도입 안 됨 (회귀)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '안녕하세요', ja: 'こんにちは', en: 'hello' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: ['ko', 'ja', 'en'],
    });
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_translations).toEqual({
      ko: '안녕하세요',
      ja: 'こんにちは',
      en: 'hello',
    });
  });

  it('emotion marker (ㅋ + ㅠ) 동시 포함 — Gemini 가 각각 audio tag 로 치환', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: {
        ko: '안녕[laughs] 그래도 슬프네[sad]',
        ja: 'JA [laughs] [sad]',
        en: 'EN [laughs] [sad]',
      },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕ㅋㅋ 그래도 슬프네ㅠㅠ', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    // 작성자 ko 슬롯: 디스플레이 텍스트 (ㅋㅋㅋ + ㅠㅠ 복원)
    expect(profile.voice_intro_translations.ko).toBe('안녕ㅋㅋㅋ 그래도 슬프네ㅠㅠ');
    // 번역 슬롯 ja: www + (泣)
    expect(profile.voice_intro_translations.ja).toBe('JA www (泣)');
    // 번역 슬롯 en: lol + :(
    expect(profile.voice_intro_translations.en).toBe('EN lol :(');
  });

  it('audio tag 단독 (ㅋㅋㅋㅋㅋ) — ensureSpeakableForTTS 가 ElevenLabs input_text_empty 회귀 방지', async () => {
    // 사용자가 `ㅋㅋㅋㅋㅋ` 만 입력 → Gemini 가 3슬롯 모두 `[laughs]` 단독 반환.
    // ensureSpeakableForTTS 가 마침표를 덧붙이지 않으면 ElevenLabs 가
    // `Input at position 0 has empty text ...` 로 reject.
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '[laughs]', ja: '[laughs]', en: '[laughs]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, 'ㅋㅋㅋㅋㅋ', VOICE_ID, 'ko');
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    // 3 슬롯 모두 마침표가 덧붙은 형태로 ElevenLabs 호출.
    expect(ttsTexts).toEqual(expect.arrayContaining(['[laughs].', '[laughs].', '[laughs].']));
    expect(ttsTexts).not.toContain('[laughs]'); // 마침표 없는 raw 태그 단독은 호출되지 않아야 함
  });

  it('[sad] 는 display-only — TTS 입력에서 제거, display 슬랭은 유지', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: {
        ko: '오늘 슬프다[sad]',
        ja: '今日かなしい[sad]',
        en: 'sad today [sad]',
      },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '오늘 슬프다ㅠㅠ', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    // display: [sad] → 타깃 슬랭 (ko ㅠㅠ / ja (泣) / en :()
    expect(profile.voice_intro_translations.ko).toBe('오늘 슬프다ㅠㅠ');
    expect(profile.voice_intro_translations.ja).toBe('今日かなしい(泣)');
    expect(profile.voice_intro_translations.en).toBe('sad today :(');
    // TTS 입력: [sad] 없음 (흐느낌 미합성). 텍스트 본문은 발화.
    const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
    expect(ttsTexts.some((t: string) => t.includes('[sad]'))).toBe(false);
    expect(ttsTexts).toContain('오늘 슬프다');
  });

  it('순수 sad 작성자 슬롯 → 해당 슬롯 audio 없음 (TTS 스킵), display 텍스트는 유지', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '[sad]', ja: '[sad]', en: '[sad]' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, 'ㅠㅠ', VOICE_ID, 'ko');
    // 3슬롯 모두 strip 후 빈 텍스트 → TTS 스킵 (synthesizeSpeech 미호출).
    expect(hoisted.synthesizeSpeechMock).not.toHaveBeenCalled();
    const profile = hoisted.supabaseState.profile;
    // 소리는 없어도 status 는 ready (실패 아님), url 은 미커밋.
    expect(profile.voice_intro_audio_status).toEqual({ ko: 'ready', ja: 'ready', en: 'ready' });
    expect(profile.voice_intro_audio_urls.ko).toBeUndefined();
    // display 텍스트(sad 슬랭)는 유지.
    expect(profile.voice_intro_translations.ko).toBe('ㅠㅠ');
    expect(profile.voice_intro_translations.ja).toBe('(泣)');
  });
});

describe('voiceIntro service — preset bypass (audio tag pipeline 우회)', () => {
  it('preset 경로는 Gemini / replaceTagsForDisplay 모두 우회 (카탈로그 텍스트 그대로 저장)', async () => {
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
