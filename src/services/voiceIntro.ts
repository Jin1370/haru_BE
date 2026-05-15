import { supabase } from '../config/supabase';
import { uploadFile, deleteFile, extractPath } from './storage';
import { synthesizeSpeech, type PersonaGender } from './elevenlabs';
import { translateVoiceIntro } from './translation';
import { normalizeSlangInput } from '../utils/textNormalization';
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

const VOICE_INTRO_BUCKET = 'voice-intro-audio';

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
    const audio = await synthesizeSpeech(text, voiceId, null, gender);
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

  // voice_slang_normalization sprint (2026-05-11):
  //   작성자 voice_intro 텍스트의 슬랭 length-capping. preset 경로는 카탈로그
  //   텍스트라 정규화 불요(presetTranslations 분기에서 사용 안 됨).
  const normalizedIntroText = presetTranslations
    ? voiceIntroText
    : normalizeSlangInput(voiceIntroText, authorLang);

  // (1) 시작 시점 옛 URL snapshot (cleanup 용)
  const oldUrls = await snapshotOldUrls(userId);

  // (2) 상태 초기화 + 슬롯 텍스트 commit (단일 update).
  // preset 경로 (voice-intro-preset-bypass sprint) 는 BE 카탈로그가 ko/ja/en 3개를
  // 모두 보유하므로 이 단계에서 3슬롯을 한 번에 commit. 기존 path 는 작성자 슬롯만 commit.
  const initialTranslations: VoiceIntroTranslations =
    presetTranslations ?? { [authorLang]: normalizedIntroText };
  await supabase
    .from('profiles')
    .update({
      voice_intro_translations: initialTranslations,
      voice_intro_audio_urls: {},
      voice_intro_audio_status: { ko: 'pending', ja: 'pending', en: 'pending' },
    })
    .eq('id', userId);

  // (3) 누락 언어 번역 (1회 호출). 실패 시 누락 슬롯 status='failed', 작성자 슬롯만 진행.
  // preset 경로는 카탈로그가 3슬롯 모두 보유 → 이 단계 전체 스킵, slotTexts 직접 채움.
  let slotTexts: VoiceIntroTranslations;
  if (presetTranslations) {
    slotTexts = presetTranslations;
  } else {
    slotTexts = { [authorLang]: normalizedIntroText };
    const targetLangs = VOICE_INTRO_SLOT_LANGUAGES.filter((l) => l !== authorLang);
    if (targetLangs.length > 0) {
      try {
        const { translations } = await translateVoiceIntro({
          text: normalizedIntroText,
          sourceLanguage: authorLang,
          targetLanguages: targetLangs,
        });
        for (const lang of targetLangs) {
          const value = translations[lang];
          if (typeof value === 'string' && value.length > 0) {
            slotTexts[lang] = value;
          }
        }
        // 번역문 commit (작성자 언어 + 성공 번역 슬롯).
        await supabase
          .from('profiles')
          .update({ voice_intro_translations: slotTexts })
          .eq('id', userId);
      } catch (err) {
        console.error(`[Voice intro translate failed] userId=${userId}`, err);
        await markSlotsFailed(userId, targetLangs);
      }
    }
  }

  // (4) 슬롯별 TTS — Promise.allSettled (병렬, 슬롯 독립 commit).
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
