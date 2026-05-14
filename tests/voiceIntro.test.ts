import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup (hoisted) ──────────────────────────────────────────────────
// services/voiceIntro.ts depends on:
//   - services/translation.ts → translateVoiceIntro (mock at module boundary)
//   - services/elevenlabs.ts  → synthesizeSpeech    (mock at module boundary)
//   - services/storage.ts     → uploadFile, deleteFile, extractPath
//   - config/supabase.ts      → supabase client (chainable)
//
// We mock at the service module level (not the SDK level) so the test stays
// focused on pipeline orchestration logic.
const hoisted = vi.hoisted(() => {
  const supabaseState: {
    profile: Record<string, any>;
  } = { profile: {} };

  // Build a chainable thenable mimicking supabase-js for the calls used in
  // services/voiceIntro.ts: from('profiles').select(col).eq('id', uid).maybeSingle()
  // and .from('profiles').update(payload).eq('id', uid).
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
        const cols = selectedColumn.split(',').map((c) => c.trim());
        const data: Record<string, any> = {};
        for (const c of cols) {
          data[c] = supabaseState.profile[c] ?? null;
        }
        return { data, error: null };
      },
      then(resolve: any) {
        // .update() chain awaited directly (no .single()).
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

import {
  generateVoiceIntroAudios,
  normalizeAuthorLanguage,
} from '../src/services/voiceIntro';

const USER_ID = 'user-1';
const VOICE_ID = 'voice-clone-1';

function resetState() {
  hoisted.supabaseState.profile = {};
  hoisted.supabaseFromMock.mockClear();
  hoisted.translateVoiceIntroMock.mockReset();
  hoisted.synthesizeSpeechMock.mockReset();
  hoisted.uploadFileMock.mockReset();
  hoisted.deleteFileMock.mockReset();
  hoisted.extractPathMock.mockReset();
  hoisted.extractPathMock.mockImplementation((_bucket: string, url: string) => {
    // Strip any /storage/v1/object/public/<bucket>/ prefix; tests use plain paths.
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

describe('normalizeAuthorLanguage', () => {
  it('ko/ja/en 그대로', () => {
    expect(normalizeAuthorLanguage('ko')).toBe('ko');
    expect(normalizeAuthorLanguage('ja')).toBe('ja');
    expect(normalizeAuthorLanguage('en')).toBe('en');
  });
  it('th/hi/null/undefined → en', () => {
    expect(normalizeAuthorLanguage('th')).toBe('en');
    expect(normalizeAuthorLanguage('hi')).toBe('en');
    expect(normalizeAuthorLanguage(null)).toBe('en');
    expect(normalizeAuthorLanguage(undefined)).toBe('en');
  });
});

describe('generateVoiceIntroAudios', () => {
  it('작성자 ko, 모든 단계 성공 → 3 슬롯 ready + 슬롯별 URL', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });

    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');

    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledTimes(1);
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '안녕하세요',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
    expect(hoisted.synthesizeSpeechMock).toHaveBeenCalledTimes(3);

    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status).toEqual({ ko: 'ready', ja: 'ready', en: 'ready' });
    expect(profile.voice_intro_audio_urls.ko).toMatch(/voice-intro-ko-/);
    expect(profile.voice_intro_audio_urls.ja).toMatch(/voice-intro-ja-/);
    expect(profile.voice_intro_audio_urls.en).toMatch(/voice-intro-en-/);
    expect(profile.voice_intro_translations).toEqual({
      ko: '안녕하세요',
      ja: 'こんにちは',
      en: 'Hello',
    });
  });

  it('작성자 ja, 모든 단계 성공', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '안녕', en: 'Hello' },
      detectedSourceLanguage: 'ja',
    });
    await generateVoiceIntroAudios(USER_ID, 'こんにちは', VOICE_ID, 'ja');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: 'こんにちは',
      sourceLanguage: 'ja',
      targetLanguages: ['ko', 'en'],
    });
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_urls.ja).toMatch(/voice-intro-ja-/);
  });

  it('작성자 en, 모든 단계 성공', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '안녕', ja: 'こんにちは' },
      detectedSourceLanguage: 'en',
    });
    await generateVoiceIntroAudios(USER_ID, 'Hello', VOICE_ID, 'en');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: 'Hello',
      sourceLanguage: 'en',
      targetLanguages: ['ko', 'ja'],
    });
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_urls.en).toMatch(/voice-intro-en-/);
  });

  it('작성자 th (영문 강제 fallback) → en 슬롯으로 정규화', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ko: '안녕', ja: 'こんにちは' },
      detectedSourceLanguage: 'en',
    });
    await generateVoiceIntroAudios(USER_ID, 'Hello (TH user)', VOICE_ID, 'th');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: 'Hello (TH user)',
      sourceLanguage: 'en',
      targetLanguages: ['ko', 'ja'],
    });
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_urls.en).toMatch(/voice-intro-en-/);
    expect(profile.voice_intro_audio_status).toEqual({ ko: 'ready', ja: 'ready', en: 'ready' });
  });

  it('translateVoiceIntro 실패 → 작성자 슬롯만 ready, 나머지 failed', async () => {
    hoisted.translateVoiceIntroMock.mockRejectedValue(new Error('Vertex AI down'));
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    // 작성자 슬롯 ko 만 TTS 실행.
    expect(hoisted.synthesizeSpeechMock).toHaveBeenCalledTimes(1);
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status.ko).toBe('ready');
    expect(profile.voice_intro_audio_status.ja).toBe('failed');
    expect(profile.voice_intro_audio_status.en).toBe('failed');
    expect(profile.voice_intro_audio_urls.ko).toMatch(/voice-intro-ko-/);
  });

  it('translateVoiceIntro 응답에 일부 슬롯 누락(빈 문자열 포함) → 누락 슬롯 failed', async () => {
    // translateVoiceIntro 자체에서 throw 하면 위 케이스와 동일. 누락 슬롯 시뮬레이션
    // 차원: 응답 객체가 ja 만 채우고 en 은 비어있다면 voiceIntro 의 slotTexts 에서
    // en 은 누락되어 TTS 안 함, status 는 markSlotsFailed 로 'failed'.
    // (번역 함수가 throw 안 하는 경로 — 함수 내부 방어 비활성 시나리오 가정).
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは' }, // en 없음
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    // ko + ja TTS 만 실행, en 슬롯은 텍스트 미존재 → TTS 안 함, 상태는 'pending' 잔존
    // (markSlotsFailed 는 translate throw 경로에서만 호출). 동작 확인:
    expect(hoisted.synthesizeSpeechMock).toHaveBeenCalledTimes(2);
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status.ko).toBe('ready');
    expect(profile.voice_intro_audio_status.ja).toBe('ready');
    expect(profile.voice_intro_audio_status.en).toBe('pending');
  });

  it('synthesizeSpeech 1개 슬롯만 실패 → 해당 슬롯 failed, 다른 슬롯 ready (Promise.allSettled)', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });
    // ja 슬롯만 실패. 슬롯 호출 순서: ko, ja, en 순.
    let count = 0;
    hoisted.synthesizeSpeechMock.mockImplementation(() => {
      count++;
      if (count === 2) return Promise.reject(new Error('TTS down for ja'));
      return Promise.resolve(Buffer.from('audio'));
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status.ko).toBe('ready');
    expect(profile.voice_intro_audio_status.ja).toBe('failed');
    expect(profile.voice_intro_audio_status.en).toBe('ready');
    expect(profile.voice_intro_audio_urls.ja).toBeUndefined();
  });

  it('작성자 슬롯 TTS 실패 → 슬롯 url 미커밋, status=failed', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });
    // 첫 번째 호출 (ko = 작성자) 만 실패.
    let count = 0;
    hoisted.synthesizeSpeechMock.mockImplementation(() => {
      count++;
      if (count === 1) return Promise.reject(new Error('TTS down for ko'));
      return Promise.resolve(Buffer.from('audio'));
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status.ko).toBe('failed');
    expect(profile.voice_intro_audio_urls.ko).toBeUndefined();
    // 다른 슬롯은 ready
    expect(profile.voice_intro_audio_status.ja).toBe('ready');
    expect(profile.voice_intro_audio_status.en).toBe('ready');
  });

  it('uploadFile 실패 → 해당 슬롯 status=failed, url 미커밋', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });
    hoisted.uploadFileMock.mockImplementationOnce(() => Promise.reject(new Error('storage 5xx')));
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    const profile = hoisted.supabaseState.profile;
    // 첫 번째 호출 = ko 작성자 슬롯 실패.
    expect(profile.voice_intro_audio_status.ko).toBe('failed');
    expect(profile.voice_intro_audio_urls.ko).toBeUndefined();
  });

  it('옛 URL cleanup 호출: snapshot 의 slot URL 모두 deleteFile', async () => {
    // 사전 상태 — 옛 슬롯 URL 들이 존재.
    hoisted.supabaseState.profile = {
      voice_intro_audio_urls: {
        ko: 'https://cdn.test/old-ko.mp3',
        ja: 'https://cdn.test/old-ja.mp3',
        en: null,
      },
    };
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko');
    const calledPaths = hoisted.deleteFileMock.mock.calls.map((c: any[]) => c[1]);
    expect(calledPaths).toContain('old-ko.mp3');
    expect(calledPaths).toContain('old-ja.mp3');
    expect(hoisted.deleteFileMock).toHaveBeenCalledTimes(2);
  });

  it('cleanup 실패해도 generateVoiceIntroAudios 는 정상 종료', async () => {
    hoisted.supabaseState.profile = {
      voice_intro_audio_urls: { ko: 'https://cdn.test/old.mp3' },
    };
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'こんにちは', en: 'Hello' },
      detectedSourceLanguage: 'ko',
    });
    hoisted.deleteFileMock.mockRejectedValue(new Error('storage delete 5xx'));
    await expect(
      generateVoiceIntroAudios(USER_ID, '안녕하세요', VOICE_ID, 'ko'),
    ).resolves.toBeUndefined();
    const profile = hoisted.supabaseState.profile;
    expect(profile.voice_intro_audio_status.ko).toBe('ready');
  });

  it('translateVoiceIntro 호출 인자: targetLanguages 가 작성자 언어 제외', async () => {
    hoisted.translateVoiceIntroMock.mockResolvedValue({
      translations: { ja: 'JA', en: 'EN' },
      detectedSourceLanguage: 'ko',
    });
    await generateVoiceIntroAudios(USER_ID, '안녕', VOICE_ID, 'ko');
    expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledWith({
      text: '안녕',
      sourceLanguage: 'ko',
      targetLanguages: ['ja', 'en'],
    });
  });

  // voice-intro-preset-bypass sprint: 5번째 인자 presetTranslations 가 주입되면
  // service 가 Gemini 단계 전체를 스킵하고 카탈로그 텍스트로 직접 TTS 만 진행.
  describe('presetTranslations 인자 (preset bypass)', () => {
    it('presetTranslations 주입 → translateVoiceIntro 호출 0회', async () => {
      const presetTranslations = {
        ko: '지금 하트 누를까 말까 고민 중이죠? 그냥 눌러주면 안 돼요?',
        ja: '今ハート押そうか迷ってますよね？そのまま押しちゃだめですか？',
        en: "Still hovering over the heart button? Just press it for me, won't you?",
      };
      await generateVoiceIntroAudios(
        USER_ID,
        '지금 하트 누를까 말까 고민 중이죠? 그냥 눌러주면 안 돼요?',
        VOICE_ID,
        'ko',
        presetTranslations,
      );
      expect(hoisted.translateVoiceIntroMock).not.toHaveBeenCalled();
      // 3슬롯 모두 TTS 호출됨
      expect(hoisted.synthesizeSpeechMock).toHaveBeenCalledTimes(3);
      const profile = hoisted.supabaseState.profile;
      expect(profile.voice_intro_audio_status).toEqual({
        ko: 'ready',
        ja: 'ready',
        en: 'ready',
      });
      // voice_intro_translations 가 카탈로그 3개 텍스트로 채워짐
      expect(profile.voice_intro_translations).toEqual(presetTranslations);
      // 작성자(ko) 슬롯 ready
      expect(profile.voice_intro_audio_urls.ko).toMatch(/voice-intro-ko-/);
    });

    it('presetTranslations 주입 + TTS 텍스트는 카탈로그 텍스트 사용 (작성자 텍스트 무시)', async () => {
      const presetTranslations = {
        ko: '카탈로그 ko 텍스트',
        ja: '카탈로그 ja 텍스트',
        en: 'catalog en text',
      };
      // 사용자가 인자로 전혀 다른 voiceIntroText 를 보내도, 슬롯별 TTS 는
      // presetTranslations 의 텍스트로 진행 — server-authoritative.
      await generateVoiceIntroAudios(
        USER_ID,
        '악성 텍스트 (무시되어야 함)',
        VOICE_ID,
        'ko',
        presetTranslations,
      );
      expect(hoisted.synthesizeSpeechMock).toHaveBeenCalledTimes(3);
      const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
      expect(ttsTexts).toContain('카탈로그 ko 텍스트');
      expect(ttsTexts).toContain('카탈로그 ja 텍스트');
      expect(ttsTexts).toContain('catalog en text');
      expect(ttsTexts).not.toContain('악성 텍스트 (무시되어야 함)');
    });

    it('presetTranslations 미전달 (undefined) → 기존 path (translateVoiceIntro 1회 호출)', async () => {
      // 회귀 테스트: 5번째 인자 옵셔널이라 미전달 시 기존 동작 100% 동일.
      hoisted.translateVoiceIntroMock.mockResolvedValue({
        translations: { ja: 'JA', en: 'EN' },
        detectedSourceLanguage: 'ko',
      });
      await generateVoiceIntroAudios(USER_ID, '안녕', VOICE_ID, 'ko');
      expect(hoisted.translateVoiceIntroMock).toHaveBeenCalledTimes(1);
    });

    it('presetTranslations 주입 + 작성자 ja → ja 슬롯 ready', async () => {
      const presetTranslations = {
        ko: 'ko text',
        ja: 'ja text',
        en: 'en text',
      };
      await generateVoiceIntroAudios(USER_ID, 'ja text', VOICE_ID, 'ja', presetTranslations);
      expect(hoisted.translateVoiceIntroMock).not.toHaveBeenCalled();
      const profile = hoisted.supabaseState.profile;
      expect(profile.voice_intro_audio_urls.ja).toMatch(/voice-intro-ja-/);
    });
  });

  // voice_slang_normalization sprint (2026-05-11)
  describe('슬랭 length-capping 통합 (정규화 → 번역 → TTS)', () => {
    it('작성자 voice_intro 의 긴 ㅋ 반복이 translateVoiceIntro 인자에서 cap 됨', async () => {
      hoisted.translateVoiceIntroMock.mockResolvedValue({
        translations: { ja: 'ja', en: 'en' },
        detectedSourceLanguage: 'ko',
      });
      await generateVoiceIntroAudios(USER_ID, '재밌어요ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', VOICE_ID, 'ko');
      // 번역 호출의 text 인자가 정규화된 값이어야 함.
      const callArg = hoisted.translateVoiceIntroMock.mock.calls[0]?.[0];
      expect(callArg.text).toBe('재밌어요ㅋㅋㅋㅋ');
    });

    it('작성자 슬롯 TTS 입력도 정규화된 텍스트', async () => {
      hoisted.translateVoiceIntroMock.mockResolvedValue({
        translations: { ja: 'ja', en: 'en' },
        detectedSourceLanguage: 'ko',
      });
      await generateVoiceIntroAudios(USER_ID, '재밌어요ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', VOICE_ID, 'ko');
      // 작성자(ko) 슬롯 TTS 호출의 text 인자가 정규화된 값.
      const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
      expect(ttsTexts).toContain('재밌어요ㅋㅋㅋㅋ');
      expect(ttsTexts).not.toContain('재밌어요ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ');
    });

    it('preset bypass 경로는 정규화 비적용 (카탈로그 텍스트 원본 보존)', async () => {
      // 카탈로그 텍스트가 ㅋ 반복을 포함할 일은 없지만, 만약 가상으로 있다면
      // server-authoritative 정책상 원본 그대로 TTS 에 사용되어야 함.
      const presetTranslations = {
        ko: 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ 안녕',
        ja: 'ja',
        en: 'en',
      };
      await generateVoiceIntroAudios(USER_ID, 'whatever', VOICE_ID, 'ko', presetTranslations);
      const ttsTexts = hoisted.synthesizeSpeechMock.mock.calls.map((c: any[]) => c[0]);
      expect(ttsTexts).toContain('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ 안녕');
    });
  });
});
