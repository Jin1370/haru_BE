import { Request } from 'express';

export interface AuthRequest extends Request {
  userId?: string;
}

// mig 011: voice intro 다국어 슬롯 도입. 작성자 1개 언어 입력 → BE 가 Gemini 로
// 누락 2개 언어 번역 → ElevenLabs voice clone 으로 각각 TTS. 슬롯은 ko/ja/en 만.
// th/hi 작성자는 영문 강제 정책에 따라 'en' 슬롯으로 정규화.
export type VoiceIntroSlotLanguage = 'ko' | 'ja' | 'en';
export const VOICE_INTRO_SLOT_LANGUAGES: VoiceIntroSlotLanguage[] = ['ko', 'ja', 'en'];
export type VoiceIntroAudioStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type VoiceIntroTranslations = Partial<Record<VoiceIntroSlotLanguage, string>>;

export interface Profile {
  id: string;
  display_name: string;
  birth_date: string;
  gender: 'male' | 'female' | 'other';
  nationality: string;
  // Single primary language (mig 009 reintroduced this as a scalar after the
  // multi-language model was simplified away).
  language: string;
  voice_intro: string | null;
  interests: string[];
  photos: string[];
  elevenlabs_voice_id: string | null;
  voice_sample_url: string | null;
  voice_clone_status: 'pending' | 'processing' | 'ready' | 'failed';
  // 호환 유지(deprecate 후보) — 작성자 언어 슬롯 URL 의 미러.
  // FE chat 파트너 detail 이 supabase 직접 select 로 RLS 통과 중이라 drop 보류.
  voice_intro_audio_url: string | null;
  // mig 011 신규. 슬롯은 ko/ja/en 만. 키 미존재 가능.
  voice_intro_translations: VoiceIntroTranslations;
  voice_intro_audio_urls: Partial<Record<VoiceIntroSlotLanguage, string | null>>;
  voice_intro_audio_status: Partial<Record<VoiceIntroSlotLanguage, VoiceIntroAudioStatus>>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Swipe {
  id: string;
  swiper_id: string;
  swiped_id: string;
  direction: 'like' | 'pass';
  created_at: string;
}

export interface Match {
  id: string;
  user1_id: string;
  user2_id: string;
  unmatched_at: string | null;
  unmatched_by: string | null;
  created_at: string;
}

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'excited'
  | 'whispering'
  | 'laughing';

export interface Message {
  id: string;
  match_id: string;
  sender_id: string;
  original_text: string;
  original_language: string;
  translated_text: string | null;
  translated_language: string | null;
  audio_url: string | null;
  audio_status: 'pending' | 'processing' | 'ready' | 'failed';
  emotion: Emotion | null;
  // voice-first-message-gate sprint (mig 015): 수신자가 음성을 1회 끝까지
  // 재생한 시각. NULL = 미청취 → FE 가 텍스트를 숨기고 편지 UI 만 노출.
  // 본인 발신 메시지는 항상 null (라우트가 sender_id == req.userId 호출을 403).
  // read-at-removal-list-mask sprint (mig 018): 옛 read_at 컬럼 제거. "읽음" 의미는
  // listened_at 단일 진실원으로 일원화.
  listened_at: string | null;
  created_at: string;
}

// chat-audio-async-insert sprint: 메시지 POST 응답에서 match_after 제거.
// mig 014 의 동봉 패턴은 BE 가 INSERT 직후 SELECT 한 matches snapshot 을
// 응답에 nest 하던 흐름이었으나, 본 sprint 에서 POST 가 더 이상 동기 INSERT
// 를 보장하지 않게 되면서 (voice clone 보유자는 stub 응답 + 비동기 INSERT)
// snapshot 동봉 의미가 없어졌다. FE 는 realtime matches UPDATE 채널을 단일
// 진실원으로 사용. 인터페이스 정의는 forward-compat 차원에서 유지하지 않음.

export interface Block {
  id: string;
  blocker_id: string;
  blocked_id: string;
  created_at: string;
}

export interface Report {
  id: string;
  reporter_id: string;
  reported_id: string;
  reason: 'spam' | 'inappropriate' | 'fake_profile' | 'harassment' | 'other';
  description: string | null;
  status: 'pending' | 'reviewed' | 'resolved';
  created_at: string;
}

export interface UserPreference {
  user_id: string;
  min_age: number;
  max_age: number;
  preferred_genders: string[];
  preferred_languages: string[];
  preferred_nationalities: string[];
  updated_at: string;
}
