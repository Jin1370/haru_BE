import { Request } from 'express';

export interface AuthRequest extends Request {
  userId?: string;
}

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
  voice_intro_audio_url: string | null;
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
