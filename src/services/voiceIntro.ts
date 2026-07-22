import { supabase } from '../config/supabase';
import * as Sentry from '@sentry/node';
import { uploadFile, deleteFile, extractPath } from './storage';
import { synthesizeSpeech, type PersonaGender } from './elevenlabs';
import { translateVoiceIntro } from './translation';
import {
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
  stripNonAudibleTags,
} from '../utils/textNormalization';
import {
  VOICE_INTRO_SLOT_LANGUAGES,
  type VoiceIntroSlotLanguage,
  type VoiceIntroAudioStatus,
  type VoiceIntroTranslations,
} from '../types';

// mig 011: voice intro 다국어 슬롯 파이프라인.
//
// 흐름 (`02_architect_plan.md` 섹션 2 + `03_voice_i18n_plan.md` 섹션 3):
//   (1) 작성자 언어 정규화 (th/hi → en).
//   (2) 옛 URL snapshot (cleanup 용) + 상태 초기화.
//   (3) 누락 언어 1회 호출로 번역 (실패 시 누락 슬롯 status='failed').
//   (4) 슬롯별 독립 TTS (Promise.allSettled). 실패 시 해당 슬롯 status='failed'.
//   (5) 옛 storage 파일 cleanup (실패는 로그만).
//
// mig 019 이후: 단일 컬럼 voice_intro_audio_url 미러 update 경로 제거.
// 디스커버/매치 응답의 wire key 는 시청자 언어 슬롯을 in-flight 추출하는
// 라우트 레이어에서 미러되므로 본 서비스는 voice_intro_audio_urls JSONB
// 슬롯만 갱신한다.
//
// 정책:
//   * 부분 실패 정책 권고 D 무시 — 재시도/알림 없음.
//   * voice_clone(elevenlabs_voice_id) 없으면 호출 자체 안 함 (caller 가드).

export const VOICE_INTRO_BUCKET = 'voice-intro-audio';

// FE 의 `DISPLAYABLE_BIO_LANGUAGES = ['ko','en','ja']` + 영문 강제 정책 답습.
// th/hi 작성자는 영어로만 voice_intro 입력 가능 → 'en' 슬롯으로 정규화.
export function normalizeAuthorLanguage(language: string | null | undefined): VoiceIntroSlotLanguage {
  if (language === 'ko' || language === 'ja' || language === 'en') return language;
  return 'en';
}

// 페르소나 태그는 elevenlabs.synthesizeSpeech 안에서 gender 인자 기반으로 직접
// prepend 한다. 메시지 TTS 도 동일 페르소나를 공유 — voice intro 와 메시지
// 모두 발신자 baseline 캐릭터로 사용 (이전엔 voice intro 첫인상 표면에만 한정).

type OldUrlsSnapshot = Partial<Record<VoiceIntroSlotLanguage, string | null>>;

async function snapshotOldUrls(userId: string): Promise<OldUrlsSnapshot> {
  const { data } = await supabase
    .from('profiles')
    .select('voice_intro_audio_urls')
    .eq('id', userId)
    .maybeSingle();
  return (data?.voice_intro_audio_urls ?? {}) as OldUrlsSnapshot;
}

// JSONB 단일 키 갱신: read-merge-write 패턴.
//
// race 회피:
//   * 동일 pipeline 내 3슬롯 TTS 가 Promise.allSettled 로 병렬 진행되며 동일
//     `voice_intro_audio_status`/`voice_intro_audio_urls` JSONB 컬럼을 동시
//     갱신할 수 있다. 그래서 본 모듈 안에서 사용자 단위 sequential lock 으로
//     read-merge-write 를 직렬화한다 (전체 파이프라인이 사용자당 1개라 충돌 영향 없음).
//   * 동일 사용자가 별도 요청으로 voice_intro 변경을 동시에 두 번 트리거하는
//     케이스는 본 sprint 정책상 무시 (권고 C 쿨다운 무시).
const userLocks = new Map<string, Promise<void>>();

async function mergeJsonbColumn<T>(
  userId: string,
  column: 'voice_intro_audio_urls' | 'voice_intro_audio_status' | 'voice_intro_translations',
  partial: Partial<Record<VoiceIntroSlotLanguage, T>>,
  extraUpdate: Record<string, unknown> = {},
): Promise<void> {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const { data } = await supabase
      .from('profiles')
      .select(column)
      .eq('id', userId)
      .maybeSingle();
    const current = ((data as Record<string, unknown> | null)?.[column] ?? {}) as Record<
      string,
      unknown
    >;
    const merged = { ...current, ...partial };
    await supabase
      .from('profiles')
      .update({ [column]: merged, ...extraUpdate })
      .eq('id', userId);
  });
  // catch 를 chain 에 묶지 않고 분리 — 한 호출자의 실패가 다음 호출자 진행을 막지 않게.
  userLocks.set(
    userId,
    next.catch(() => undefined),
  );
  return next;
}

async function setSlotStatus(
  userId: string,
  lang: VoiceIntroSlotLanguage,
  status: VoiceIntroAudioStatus,
): Promise<void> {
  await mergeJsonbColumn<VoiceIntroAudioStatus>(userId, 'voice_intro_audio_status', {
    [lang]: status,
  });
}

async function markSlotsFailed(
  userId: string,
  langs: VoiceIntroSlotLanguage[],
): Promise<void> {
  if (langs.length === 0) return;
  const partial: Partial<Record<VoiceIntroSlotLanguage, VoiceIntroAudioStatus>> = {};
  for (const lang of langs) partial[lang] = 'failed';
  await mergeJsonbColumn(userId, 'voice_intro_audio_status', partial);
}

async function cleanupOldFiles(userId: string, snapshot: OldUrlsSnapshot): Promise<void> {
  const urls = new Set<string>();
  for (const lang of VOICE_INTRO_SLOT_LANGUAGES) {
    const url = snapshot[lang];
    if (typeof url === 'string' && url.length > 0) urls.add(url);
  }
  for (const url of urls) {
    try {
      const path = extractPath(VOICE_INTRO_BUCKET, url.split('?')[0]);
      await deleteFile(VOICE_INTRO_BUCKET, path);
    } catch (cleanupErr) {
      console.error(`[Voice intro cleanup failed] userId=${userId}`, cleanupErr);
    }
  }
}

async function synthesizeSlot(args: {
  userId: string;
  voiceId: string;
  lang: VoiceIntroSlotLanguage;
  text: string;
  gender: PersonaGender;
}): Promise<void> {
  const { userId, voiceId, lang, text, gender } = args;
  try {
    await setSlotStatus(userId, lang, 'processing');
    // TTS 입력: [laughs] 만 audible, [sad] 등 display-only 태그는 제거 (사용자 정책).
    const ttsText = stripNonAudibleTags(text);
    // strip 후 audible 콘텐츠가 없으면 (순수 sad 슬롯 등) 소리 없이 'ready'.
    // display 텍스트(voice_intro_translations 슬롯)는 이미 commit 되어 유지된다.
    if (!hasSpeakableContent(ttsText)) {
      await setSlotStatus(userId, lang, 'ready');
      return;
    }
    // ElevenLabs eleven_v3 는 audio tag + 이모지 strip 후 빈 텍스트면 input_text_empty
    // 에러로 reject — 사용자가 `ㅋㅋㅋㅋㅋ` 등 웃음 마커만 보내 Gemini 출력이
    // `[laughs]` 단독이 된 경우 이 케이스에 해당.
    // ensureSpeakableForTTS 가 마침표를 덧붙여 validation 통과 + 효과음은 정상 합성.
    const audio = await synthesizeSpeech(ensureSpeakableForTTS(ttsText), voiceId, null, gender, lang);
    const path = `${userId}/voice-intro-${lang}-${Date.now()}.mp3`;
    const audioUrl = await uploadFile(VOICE_INTRO_BUCKET, path, audio, 'audio/mpeg');

    await mergeJsonbColumn<string | null>(userId, 'voice_intro_audio_urls', {
      [lang]: audioUrl,
    });
    await mergeJsonbColumn<VoiceIntroAudioStatus>(userId, 'voice_intro_audio_status', {
      [lang]: 'ready',
    });
  } catch (err) {
    console.error(`[Voice intro synth failed] userId=${userId} lang=${lang}`, err);
    Sentry.captureException(err, {
      tags: { pipeline: 'voice_intro', stage: 'synth' },
      extra: { userId, lang },
    });
    await setSlotStatus(userId, lang, 'failed').catch((statusErr) =>
      console.error('[Voice intro status update failed]', statusErr),
    );
  }
}

export async function generateVoiceIntroAudios(
  userId: string,
  voiceIntroText: string,
  voiceId: string,
  authorLanguageRaw: string | null | undefined,
  presetTranslations?: VoiceIntroTranslations,
  gender?: PersonaGender,
): Promise<void> {
  const authorLang = normalizeAuthorLanguage(authorLanguageRaw);

  // (1) 시작 시점 옛 URL snapshot (cleanup 용)
  const oldUrls = await snapshotOldUrls(userId);

  // voice-intro audio tag pipeline (Gemini 단독 태깅 — regex prepareTextForTTS 폐지):
  //   * preset 경로 (voice-intro-preset-bypass): 카탈로그가 손번역 + audio tag
  //     없는 텍스트 (운영 검증된 화이트리스트). Gemini / replaceTagsForDisplay
  //     모두 우회 — 카탈로그 텍스트 그대로 display + TTS.
  //   * non-preset 경로: raw 작성자 원문을 Gemini 에 넘겨 STEP 1(실제 나타난
  //     감정 마커 → [laughs]/[sad]) + STEP 2(각 언어 렌더) 를 1회 호출로 처리.
  //     작성자 슬롯도 targetLanguages 에 포함시켜 Gemini 경유 (identity slot =
  //     태그만 적용된 원문). translateVoiceIntro 출력은 sanitizeAudioTags 로
  //     화이트리스트 검증됨. slotTexts 는 TTS 입력(태그 포함), voice_intro_translations
  //     슬롯엔 replaceTagsForDisplay 거친 display 텍스트 저장(raw `[laughs]` 미노출).

  // (2) 상태 초기화. non-preset 은 번역 후 슬롯 텍스트를 채우므로 초기 translations 는 빈다.
  const initialTranslations: VoiceIntroTranslations = presetTranslations ?? {};
  await supabase
    .from('profiles')
    .update({
      voice_intro_translations: initialTranslations,
      voice_intro_audio_urls: {},
      voice_intro_audio_status: { ko: 'pending', ja: 'pending', en: 'pending' },
    })
    .eq('id', userId);

  // (3) Gemini 태깅+번역 (1회 호출, 작성자 슬롯 포함). preset 은 스킵.
  let slotTexts: VoiceIntroTranslations;
  if (presetTranslations) {
    slotTexts = presetTranslations;
  } else {
    slotTexts = {};
    const displayTexts: VoiceIntroTranslations = {};
    try {
      const { translations } = await translateVoiceIntro({
        text: voiceIntroText,
        sourceLanguage: authorLang,
        targetLanguages: VOICE_INTRO_SLOT_LANGUAGES,
      });
      for (const lang of VOICE_INTRO_SLOT_LANGUAGES) {
        const value = translations[lang];
        if (typeof value === 'string' && value.length > 0) {
          slotTexts[lang] = value; // TTS 입력: audio tag 포함
          displayTexts[lang] = replaceTagsForDisplay(value, lang); // DB 저장: slot 언어 슬랭
        }
      }
    } catch (err) {
      // fail-open: Gemini 실패 시 작성자 슬롯은 raw 원문(태그 없음, speakable)으로
      // 폴백해 최소한 본인 언어 voice intro 는 생성. 나머지 슬롯은 failed.
      console.error(`[Voice intro translate failed] userId=${userId}`, err);
      Sentry.captureException(err, {
        tags: { pipeline: 'voice_intro', stage: 'translate' },
        extra: { userId },
      });
      slotTexts[authorLang] = voiceIntroText;
      displayTexts[authorLang] = voiceIntroText;
      await markSlotsFailed(
        userId,
        VOICE_INTRO_SLOT_LANGUAGES.filter((l) => l !== authorLang),
      );
    }
    // display 텍스트 commit (성공/폴백 공통).
    await supabase
      .from('profiles')
      .update({ voice_intro_translations: displayTexts })
      .eq('id', userId);
  }

  // (4) 슬롯별 TTS — Promise.allSettled (병렬, 슬롯 독립 commit).
  // slotTexts 는 audio tag 가 포함된 TTS 입력 텍스트 (preset 경로는 카탈로그
  // 텍스트 그대로 — audio tag 없는 손번역).
  const slotsToTts: VoiceIntroSlotLanguage[] = VOICE_INTRO_SLOT_LANGUAGES.filter(
    (l) => typeof slotTexts[l] === 'string',
  );

  await Promise.allSettled(
    slotsToTts.map((lang) =>
      synthesizeSlot({
        userId,
        voiceId,
        lang,
        text: slotTexts[lang]!,
        gender,
      }),
    ),
  );

  // (5) cleanup 옛 파일. 실패는 로그만.
  await cleanupOldFiles(userId, oldUrls);
}
