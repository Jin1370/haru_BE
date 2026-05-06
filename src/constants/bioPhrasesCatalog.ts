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
    id: 'taste-1',
    text: {
      ko: '맛있는 거 먹으러 다니는 게 제 취미인데, 같이 맛집 리스트 공유하실 분 찾아요.',
      en: "Hunting down good food is basically my hobby — looking for someone to trade restaurant lists with.",
      ja: '美味しいものを食べ歩くのが趣味なんです。一緒にお店リストを交換できる人、探してます。',
    },
  },
  {
    id: 'simple-1',
    text: {
      ko: '그냥 자연스럽게 대화해봐요. 인연이면 이어지지 않을까요?',
      en: "Let's just chat naturally. If we click, things will fall into place, right?",
      ja: '自然に話してみませんか？縁があれば、きっと繋がりますよね。',
    },
  },
  {
    id: 'simple-2',
    text: {
      ko: '부담 없이 한 번 얘기해봐요. 그냥 편하게',
      en: "Let's just chat — no pressure, no big deal.",
      ja: '気軽に話してみましょう。肩の力を抜いて。',
    },
  },
  {
    id: 'sincere-1',
    text: {
      ko: '글로 보는 것보다 목소리로 듣는 게 훨씬 그 사람 같잖아요. 만나서 반가워요.',
      en: "You learn more about someone from their voice than their words. Nice to meet you.",
      ja: '文字で読むより、声で聞いたほうがずっとその人らしいですよね。お会いできて嬉しいです。',
    },
  },
  {
    id: 'flutter-1',
    text: {
      ko: '여기서 지나가면 조금 아쉬울 것 같지 않아요?',
      en: "Wouldn't it feel a little like a missed chance if you scrolled past me?",
      ja: 'ここで通り過ぎたら、ちょっともったいない気がしませんか？',
    },
  },
  {
    id: 'flutter-2',
    text: {
      ko: '제 목소리 방금 들었을 때, 1초라도 설렜으면 좋겠는데... 설렜나요?',
      en: "I'm hoping my voice gave you a flutter — even just for a second. Did it?",
      ja: '今の声、ほんの一瞬でもときめいてくれたら嬉しいんですけど…どうでした？',
    },
  },
  {
    id: 'confidence-1',
    text: {
      ko: '저랑 얘기하면 시간 가는 줄 모르실걸요? 일단 말 걸어주세요!',
      en: "Talk to me and you'll lose track of time, I promise. Just say hi!",
      ja: '私と話すと時間を忘れちゃうかも。とりあえず声かけてください！',
    },
  },
  {
    id: 'aegyo-1',
    text: {
      ko: '지금 하트 누를까 말까 고민 중이죠? 그냥 눌러주면 안 돼요?',
      en: "Still hovering over the heart button? Just press it for me, won't you?",
      ja: '今ハート押そうか迷ってますよね？そのまま押しちゃだめですか？',
    },
  },
  {
    id: 'aegyo-2',
    text: {
      ko: '저를 버리시려고요? 진짜로요?',
      en: "Wait — you're really going to swipe me away? Really?",
      ja: '私のこと、置いていっちゃうんですか？本当に？',
    },
  },
] as const;

// O(1) lookup. 카탈로그 크기가 50+ 가 되어도 부담 없음.
const CATALOG_BY_ID = new Map(BIO_PHRASE_CATALOG.map((entry) => [entry.id, entry]));

export function lookupBioPhrase(id: string): BioPhraseEntry | undefined {
  return CATALOG_BY_ID.get(id);
}
