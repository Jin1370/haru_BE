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
  read_at: string | null;
  created_at: string;
}

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
