import type { VoiceIntroSlotLanguage } from '../types';

// FE haru_FE/src/constants/bioPhrases.ts 와 ko/ja/en 텍스트가 일치해야 함.
// 카탈로그 변경 시 양쪽 동시 PR + voice-i18n-engineer + safety-security-reviewer 사인오프.
//
// 본 BE 카탈로그는 검증·폴백 용도(텍스트 ko/ja/en 만 보유). FE 카탈로그가 보유한
// category/디자인 토큰/helper 함수는 UI 렌더용이며 BE 측에 불필요.
//
// preset bypass 흐름 (sprint: voice-intro-preset-bypass):
//   * FE 가 PUT /api/profile/me 에 voice_intro_phrase_id 동봉.
//   * BE route 가 lookupBioPhrase(id) 로 매칭 → presetTranslations 결정.
//   * service 가 presetTranslations 보유 시 Gemini 번역 단계 스킵.
//   * 미상 id 는 폴백으로 흡수 (Gemini 경로) — OTA 비대칭 방어.
export interface BioPhraseEntry {
  id: string;
  text: Record<VoiceIntroSlotLanguage, string>;
}

export const BIO_PHRASE_CATALOG: readonly BioPhraseEntry[] = [
  {
    id: 'greeting-1',
    text: {
      ko: '만나서 반가워요. 편하게 말 걸어주세요.',
      en: 'Nice to meet you. Feel free to say hi anytime.',
      ja: 'はじめまして。気軽に話しかけてくださいね。',
    },
  },
  {
    id: 'daily-1',
    text: {
      ko: '오늘은 어떤 하루였나요? 같이 수다 떨어요.',
      en: "How was your day today? Let's chat about it.",
      ja: '今日はどんな一日でしたか？おしゃべりしましょう。',
    },
  },
  {
    id: 'listen-1',
    text: {
      ko: '고민 듣는 거 좋아해요. 뭐든지 상담해주세요.',
      en: "I'm a good listener — bring me whatever's on your mind.",
      ja: '悩みを聞くのが好きです。何でも相談してくださいね。',
    },
  },
  {
    id: 'talk-1',
    text: {
      ko: '말 시작하면 멈추지 않는 타입이에요. 심심할 때 말 걸어주세요.',
      en: "Once I get talking, I don't stop. Say hi whenever you're bored.",
      ja: '話し出すと止まらないタイプなんです。暇なときは声かけてください。',
    },
  },
  {
    id: 'friend-1',
    text: {
      ko: '그냥 편하게 얘기 나눌 친구를 만들고 싶어요.',
      en: "I'm just looking for a friend to talk with — no pressure.",
      ja: '気軽に話せる友達がほしいなと思っています。',
    },
  },
  {
    id: 'food-1',
    text: {
      ko: '맛있는거 먹으러 다니는 게 제 취미인데, 같이 맛집 리스트 공유하실 분 찾아요.',
      en: 'Hunting down good food is basically my hobby — looking for someone to trade restaurant lists with.',
      ja: '美味しいものを食べ歩くのが趣味なんです。一緒にお店リストを交換できる人、探してます。',
    },
  },
  {
    id: 'music-1',
    text: {
      ko: '음악 취향 공유할 사람 찾아요. 요즘 뭐 들으세요?',
      en: 'Looking for someone to swap playlists with. What are you listening to lately?',
      ja: '音楽の趣味を共有できる人を探してます。最近何聴いてますか？',
    },
  },
] as const;

// O(1) lookup. 카탈로그 크기가 50+ 가 되어도 부담 없음.
const CATALOG_BY_ID = new Map(BIO_PHRASE_CATALOG.map((entry) => [entry.id, entry]));

export function lookupBioPhrase(id: string): BioPhraseEntry | undefined {
  return CATALOG_BY_ID.get(id);
}
