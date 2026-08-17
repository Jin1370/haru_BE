// 캠페인 봇(하치와레 발견 이벤트) — 매치 성사 직후 자동 메시지 2건 발송.
//
// 일반 메시지 파이프라인(routes/message.ts)을 재사용하지 않는 이유:
//   - 번역 불필요. 카피가 수신자 언어로 이미 3벌 작성돼 있어 Gemini 를 태울 이유가
//     없다 (태우면 확정된 카피가 망가진다).
//   - 모더레이션 불필요. 서버 상수 카피라 사용자 입력이 아니다.
//   - 표시 텍스트와 TTS 텍스트가 다르다 (카드의 `▼`/기호/숫자).
// 그래서 TTS + Storage + INSERT 구간만 직접 조립한다.
//
// 멱등: 메시지 id 를 matchId 에서 결정적으로 파생하고 ON CONFLICT DO NOTHING
// (ignoreDuplicates) 으로 넣는다. 재시도/중복 호출이 두 번째 row 를 만들지 않는다.

import { createHash } from 'crypto';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { synthesizeSpeech, PersonaGender } from './elevenlabs';
import { createSignedUrlFromStored, uploadFile } from './storage';
import { fetchReadyPhotosByUser } from './profilePhotos';
import { VOICE_INTRO_BUCKET } from './voiceIntro';
import {
  ACCOMPLICE_NOTES,
  ACCOMPLICE_PCT,
  ACCOMPLICE_PCT_TTS,
  BOT_INTERESTS,
  BotLocale,
  CARD_DISPLAY,
  CARD_TTS,
  ENTRY_GUIDE,
  InterestSection,
  LICENSES,
  SECTION_INTEREST_IDS,
  TITLE_ADJECTIVES,
  TITLE_NOUNS,
  toBotLocale,
} from '../constants/campaignBot';

/** 캠페인 봇 계정인지. env 미설정이면 항상 false = 기능 전체 비활성. */
export function isCampaignBot(userId: string | null | undefined): boolean {
  return !!env.campaign.botUserId && userId === env.campaign.botUserId;
}

/**
 * 디스커버 덱에 끼워넣을 봇 카드. 일반 후보 쿼리는 (a) 선호 성별·나이 (b) viewer
 * 와 같은 언어 하드 제외 를 적용하는데, 봇은 그 어느 것에도 걸리면 안 된다
 * (성별 '기타'는 선호 기본값에서 빠져 있고, 언어 제외는 같은 언어권 사용자에게
 * 봇을 영구히 안 보이게 만든다). 그래서 라우트가 봇을 메인 쿼리에서 제외하고
 * 이 함수로 따로 만들어 결과에 주입한다.
 *
 * 노출 최소 조건(사진 ready 1장 이상 + 시청자 언어 보이스 슬롯)만은 일반 후보와
 * 동일하게 지킨다 — 무음/빈 카드가 뜨는 편이 더 나쁘다.
 *
 * 신원(생년월일·성별·국적)은 비워서 내려보낸다. 지명수배범이라 신원 미상이라는
 * 설정이자, 선호 필터를 우회한 카드가 "선호와 다른 프로필"로 보이지 않게 하는
 * 장치. FE 는 birth_date 가 비면 메타 줄을 '미상' 한 줄로 대체한다.
 */
export async function buildCampaignBotCard(slot: 'ko' | 'ja' | 'en'): Promise<Record<string, unknown> | null> {
  const botId = env.campaign.botUserId;
  if (!botId) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, language, voice_intro, voice_intro_audio_urls, interests')
    .eq('id', botId)
    .eq('is_active', true)
    .is('frozen_at', null)
    .maybeSingle();

  if (error) {
    console.error('[campaignBot] discover card profile load failed', error.message);
    return null;
  }
  if (!data) return null;

  const photos = (await fetchReadyPhotosByUser([botId], 'discover.campaignBot')).get(botId) ?? [];
  if (photos.length === 0) return null;

  const slotUrls = (data.voice_intro_audio_urls ?? {}) as Partial<Record<'ko' | 'ja' | 'en', string | null>>;
  const voiceIntroAudioUrl = await createSignedUrlFromStored(VOICE_INTRO_BUCKET, slotUrls[slot]);
  if (!voiceIntroAudioUrl) return null;

  return {
    id: data.id,
    display_name: data.display_name,
    // 신원 미상 — FE 가 빈 birth_date 를 보고 메타 줄을 '미상' 으로 대체한다.
    birth_date: '',
    gender: null,
    nationality: '',
    language: data.language ?? '',
    voice_intro: data.voice_intro ?? null,
    interests: data.interests ?? [],
    voice_intro_audio_url: voiceIntroAudioUrl,
    photos: photos.slice(0, 1),
    photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
    // 봇 like 는 항상 즉시 매치 = 예산 면제. 일일 좋아요를 다 쓴 사용자도 잡을 수 있다.
    liked_you: true,
  };
}

/** userId 로부터 안정적인 시드. 같은 사용자는 몇 번을 봐도 같은 결과가 나온다. */
function seedOf(userId: string): number {
  let sum = 0;
  for (const ch of userId) sum += ch.charCodeAt(0);
  return sum;
}

/** matchId + 순번 → 결정적 UUID (멱등 INSERT 키). */
function botMessageId(matchId: string, seq: number): string {
  const h = createHash('sha1').update(`${matchId}:campaign-bot:${seq}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 확률 가중 랜덤. 카드는 매치당 한 번만 생성되고 그 텍스트가 messages 에 저장되므로,
 * 여기서 한 번 뽑으면 결과가 그대로 굳는다 (재발송은 id 중복으로 무시). 그래서 옛
 * userId 시드 방식은 재현성 이득이 없으면서 확률만 왜곡했다 — 글자 코드 합의 나머지가
 * 균등하지 않아 실측이 설정값에서 ±2%p 어긋났다.
 */
function pickLicense() {
  const total = LICENSES.reduce((s, l) => s + l.weight, 0);
  let roll = Math.random() * total;
  for (const license of LICENSES) {
    if (roll < license.weight) return license;
    roll -= license.weight;
  }
  return LICENSES[LICENSES.length - 1];
}

/** 관심사가 가장 많이 몰린 섹션. 동점/관심사 없음은 시드로 결정. */
function pickSection(interests: string[], seed: number): InterestSection {
  const sections = Object.keys(SECTION_INTEREST_IDS) as InterestSection[];
  const counts = new Map<InterestSection, number>();
  for (const id of interests) {
    for (const section of sections) {
      if (SECTION_INTEREST_IDS[section].includes(id)) {
        counts.set(section, (counts.get(section) ?? 0) + 1);
        break;
      }
    }
  }
  const max = Math.max(0, ...counts.values());
  if (max === 0) return sections[seed % sections.length];
  const top = sections.filter((s) => (counts.get(s) ?? 0) === max);
  return top[seed % top.length];
}

function accompliceNote(overlap: number, locale: BotLocale): string {
  const band = ACCOMPLICE_NOTES.find((b) => overlap >= b.minOverlap) ?? ACCOMPLICE_NOTES[ACCOMPLICE_NOTES.length - 1];
  return band.text[locale];
}

interface BotMessageRow {
  id: string;
  match_id: string;
  sender_id: string;
  original_text: string;
  original_language: string;
  translated_text: null;
  translated_language: string;
  audio_url: string | null;
  audio_status: 'ready';
  emotion: null;
  created_at: string;
}

async function insertBotMessage(row: BotMessageRow): Promise<void> {
  const { error } = await supabase.from('messages').upsert(
    {
      ...row,
      // voice-first-message-gate 정합: 수신자 게이트는 음성을 끝까지 들어야
      // listened_at 이 채워지는데, 오디오가 없는 메시지는 들을 대상이 없어
      // "메시지 준비 중.." 편지 카드에서 영구히 못 빠져나온다 (채팅 목록의
      // 안 읽음 배지도 영영 안 사라짐). 애초에 청취할 게 없으므로 INSERT 시점에
      // 청취 완료로 표시한다. 오디오가 있는 카드는 null 로 두어 정상 게이팅.
      listened_at: row.audio_url ? null : new Date().toISOString(),
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  // 외부 의존성 error 가시화 룰 (CLAUDE.md) — fire-and-forget 경로라 응답 status 는
  // 없고 로그로만 노출한다.
  if (error) console.error('[campaignBot] message insert failed', row.id, error.message);
}

/**
 * 매치 직후 호출. 실패해도 스와이프 응답에 영향을 주지 않도록 호출부에서
 * fire-and-forget 한다.
 */
export async function sendCampaignBotMessages(matchId: string, recipientId: string): Promise<void> {
  const botId = env.campaign.botUserId;
  if (!botId) return;

  const [recipientResult, botResult, rankResult] = await Promise.all([
    supabase
      .from('profiles')
      .select('display_name, language, interests')
      .eq('id', recipientId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('elevenlabs_voice_id, gender')
      .eq('id', botId)
      .maybeSingle(),
    supabase
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .or(`user1_id.eq.${botId},user2_id.eq.${botId}`),
  ]);

  if (recipientResult.error || !recipientResult.data) {
    console.error('[campaignBot] recipient profile load failed', recipientResult.error?.message);
    return;
  }
  if (botResult.error || !botResult.data) {
    console.error('[campaignBot] bot profile load failed', botResult.error?.message);
    return;
  }
  if (rankResult.error) {
    // 순번을 못 세도 메시지는 나가야 한다 — 1 로 폴백하고 로그만 남긴다.
    console.error('[campaignBot] rank count failed', rankResult.error.message);
  }

  const recipient = recipientResult.data;
  const bot = botResult.data;
  const locale = toBotLocale(recipient.language as string | null);
  const seed = seedOf(recipientId);

  // 관심사는 id 로 저장된다 (옛 로컬라이즈 라벨이 남아있는 계정은 겹침 판정에서
  // 빠진다 — 캠페인 한정이라 허용).
  const interests = Array.isArray(recipient.interests) ? (recipient.interests as string[]) : [];
  const overlap = interests.filter((id) => (BOT_INTERESTS as readonly string[]).includes(id)).length;
  const pct = ACCOMPLICE_PCT[Math.min(overlap, 10)];

  const license = pickLicense();
  const adjective = TITLE_ADJECTIVES[seed % TITLE_ADJECTIVES.length][locale];
  const noun = TITLE_NOUNS[pickSection(interests, seed)][locale];
  const title = locale === 'en' ? `${adjective} ${noun}` : `${adjective} ${noun}`;
  const note = accompliceNote(overlap, locale);
  const name = sanitizeDisplayedName(recipient.display_name as string | null);

  const cardText = CARD_DISPLAY[locale]({
    name,
    rank: rankResult.count ?? 1,
    license: license.display[locale],
    title,
    pct,
    note,
  });

  // ── 메시지 1: 진단 카드 (TTS) ────────────────────────────────────
  const cardId = botMessageId(matchId, 1);
  const cardAt = new Date().toISOString();
  let audioUrl: string | null = null;

  const voiceId = bot.elevenlabs_voice_id as string | null;
  if (voiceId) {
    try {
      const ttsText = CARD_TTS[locale]({
        // 이모지/특수문자/초장문 닉네임이 TTS 를 망가뜨리지 않게 필터. 남는 게
        // 없으면 2인칭으로 폴백한다. 화면에는 원래 닉네임을 그대로 쓴다.
        name: sanitizeSpokenName(name, locale),
        licenseTts: license.tts[locale],
        title,
        pctTts: ACCOMPLICE_PCT_TTS[Math.min(overlap, 10)][locale],
        note,
      });
      const audio = await synthesizeSpeech(
        ttsText,
        voiceId,
        null,
        bot.gender as PersonaGender,
        locale,
      );
      audioUrl = await uploadFile('voice-messages', `${cardId}.mp3`, audio, 'audio/mpeg');
    } catch (error) {
      // TTS/업로드 실패해도 텍스트는 반드시 도착해야 한다 — FE 의 "작성 중"
      // 인디케이터가 메시지 도착으로만 해제되기 때문에 여기서 멈추면 영구 로딩.
      console.error('[campaignBot] TTS failed, falling back to text-only', error);
    }
  } else {
    console.error('[campaignBot] bot has no elevenlabs_voice_id — text-only card');
  }

  await insertBotMessage({
    id: cardId,
    match_id: matchId,
    sender_id: botId,
    original_text: cardText,
    original_language: locale,
    translated_text: null,
    translated_language: locale,
    audio_url: audioUrl,
    audio_status: 'ready',
    emotion: null,
    created_at: cardAt,
  });

  // 메시지 2(응모 안내)는 여기서 보내지 않는다 — 사용자가 카드 음성을 끝까지
  // 들은 시점(POST .../listened)에 발송된다. 안내를 먼저 읽고 음성을 건너뛰는
  // 동선을 막아 차별점(음성 청취)을 먼저 소비하게 하는 순서.
  //
  // 다만 TTS 가 실패해 카드에 음성이 없으면 청취 이벤트가 영영 안 오므로
  // (insertBotMessage 가 listened_at 을 미리 채워 게이트도 안 걸림) 그때는
  // 곧바로 이어 보낸다.
  if (!audioUrl) {
    await sendCampaignEntryGuide(matchId, recipientId);
  }
}

/**
 * 메시지 2 — 응모 안내. 사용자가 카드 음성을 끝까지 청취한 뒤 호출된다.
 * id 가 matchId 파생이라 중복 호출해도 두 번째 row 가 생기지 않는다.
 */
export async function sendCampaignEntryGuide(matchId: string, recipientId: string): Promise<void> {
  const botId = env.campaign.botUserId;
  if (!botId) return;

  const { data, error } = await supabase
    .from('profiles')
    .select('language')
    .eq('id', recipientId)
    .maybeSingle();
  if (error) {
    console.error('[campaignBot] entry guide language load failed', error.message);
  }
  const locale = toBotLocale(data?.language as string | null);

  // audio_url=null + 'ready' 는 message.ts 의 "TTS 스킵" 과 같은 정당 경로 —
  // 수신자 GET 필터를 통과하고 재생 버튼만 안 뜬다.
  await insertBotMessage({
    id: botMessageId(matchId, 2),
    match_id: matchId,
    sender_id: botId,
    original_text: ENTRY_GUIDE[locale](env.campaign.postUrls[locale]),
    original_language: locale,
    translated_text: null,
    translated_language: locale,
    audio_url: null,
    audio_status: 'ready',
    emotion: null,
    created_at: new Date().toISOString(),
  });
}

/**
 * 카드 표시용 닉네임 정제 — 줄바꿈/제어문자를 공백으로 접고 20자로 자른다.
 * 카드가 여러 줄 템플릿이라 닉네임에 줄바꿈이 있으면 "▼ 자격 / 풀뽑기 검정 1급"
 * 같은 가짜 줄을 사용자가 직접 찍어 넣을 수 있다 (닉네임만 바꾸면 되고 앱 변조가
 * 필요 없다). 신규 저장은 profileUpsertSchema 가 막지만, 그 전에 저장된 닉네임과
 * 다른 경로로 들어온 값까지 여기서 최종 차단한다.
 */
function sanitizeDisplayedName(raw: string | null): string {
  return (raw ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, 20);
}

/** TTS 입력용 닉네임 정제 — 문자/숫자/공백만, 12자 제한, 비면 2인칭. */
function sanitizeSpokenName(name: string, locale: BotLocale): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 12);
  if (cleaned) return cleaned;
  return locale === 'ko' ? '너' : locale === 'ja' ? 'キミ' : 'you';
}
