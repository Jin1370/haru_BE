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

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'excited'
  | 'whispering'
  | 'laughing';
