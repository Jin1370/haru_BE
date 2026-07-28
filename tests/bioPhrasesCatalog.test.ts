import { describe, it, expect } from 'vitest';
import { BIO_PHRASE_CATALOG, lookupBioPhrase } from '../src/constants/bioPhrasesCatalog';

// voice-intro-preset-bypass sprint: BE 카탈로그(bioPhrasesCatalog)는 FE
// 카탈로그(haru_FE/src/constants/bioPhrases.ts)와 ko/ja/en 텍스트가 일치해야 한다.
//
// 직접 FE 파일을 import 하면 RN 의존성을 끌고 와 vitest 환경에서 break 하므로,
// 본 테스트는 fixture 를 별도 inline 으로 두고 deep compare 한다. 카탈로그 변경 시
// 양쪽 파일과 본 fixture 3 군데를 동시에 갱신해야 통과 — drift 1차 방어선.
//
// fixture 갱신 절차 (sprint 종료 후 운영 룰):
//   1. haru_FE/src/constants/bioPhrases.ts 갱신
//   2. haru_BE/src/constants/bioPhrasesCatalog.ts 갱신
//   3. 본 파일의 EXPECTED_FE_FIXTURE 갱신 (FE 와 동일 내용)
//   4. voice-i18n-engineer + safety-security-reviewer 더블 사인오프

interface ExpectedEntry {
  id: string;
  text: { ko: string; ja: string; en: string };
}

const EXPECTED_FE_FIXTURE: readonly ExpectedEntry[] = [
  {
    id: 'greeting-1',
    text: {
      ko: '만나서 반가워요. 편하게 말 걸어주세요.',
      en: 'Nice to meet you. Feel free to say hi anytime.',
      ja: 'はじめまして。\n気軽に話しかけてくださいね。',
    },
  },
  {
    id: 'daily-1',
    text: {
      ko: '오늘은 어떤 하루였나요?\n같이 수다 떨어요.',
      en: "How was your day today? Let's chat about it.",
      ja: '今日はどんな一日でしたか？\nおしゃべりしましょう。',
    },
  },
  {
    id: 'listen-1',
    text: {
      ko: '고민 듣는 거 좋아해요.\n뭐든지 상담해주세요.',
      en: "I'm a good listener — bring me whatever's on your mind.",
      ja: '悩みを聞くのが好きです。\n何でも相談してくださいね。',
    },
  },
  {
    id: 'talk-1',
    text: {
      ko: '말 시작하면 멈추지 않는 타입이에요.\n심심할 때 말 걸어주세요.',
      en: "Once I get talking, I don't stop. Say hi whenever you're bored.",
      ja: '話し出すと止まらないタイプなんです。\n暇なときは声かけてください。',
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
      ko: '음악 취향 공유할 사람 찾아요.\n요즘 뭐 들으세요?',
      en: 'Looking for someone to swap playlists with. What are you listening to lately?',
      ja: '音楽の趣味を共有できる人を探してます。\n最近何聴いてますか？',
    },
  },
];

describe('BIO_PHRASE_CATALOG (FE/BE 동기화)', () => {
  it('entry 개수가 FE fixture 와 일치', () => {
    expect(BIO_PHRASE_CATALOG.length).toBe(EXPECTED_FE_FIXTURE.length);
  });

  it('id 집합이 FE fixture 와 일치', () => {
    const beIds = BIO_PHRASE_CATALOG.map((e) => e.id).sort();
    const feIds = EXPECTED_FE_FIXTURE.map((e) => e.id).sort();
    expect(beIds).toEqual(feIds);
  });

  it('각 id 의 ko/ja/en 텍스트가 FE fixture 와 정확히 일치', () => {
    for (const expected of EXPECTED_FE_FIXTURE) {
      const beEntry = lookupBioPhrase(expected.id);
      expect(beEntry, `BE 카탈로그에 ${expected.id} 누락`).toBeDefined();
      expect(beEntry!.text.ko).toBe(expected.text.ko);
      expect(beEntry!.text.ja).toBe(expected.text.ja);
      expect(beEntry!.text.en).toBe(expected.text.en);
    }
  });

  it('모든 entry 가 ko/ja/en 3개 텍스트 모두 보유 (preset bypass invariant)', () => {
    for (const entry of BIO_PHRASE_CATALOG) {
      expect(entry.text.ko, `${entry.id} ko 누락`).toBeTruthy();
      expect(entry.text.ja, `${entry.id} ja 누락`).toBeTruthy();
      expect(entry.text.en, `${entry.id} en 누락`).toBeTruthy();
    }
  });
});

describe('lookupBioPhrase', () => {
  it('알려진 id → entry 반환', () => {
    const entry = lookupBioPhrase('greeting-1');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('greeting-1');
    expect(entry!.text.ko).toBeTruthy();
  });

  it('미상 id → undefined 반환 (Gemini 폴백 진입 트리거)', () => {
    expect(lookupBioPhrase('does-not-exist')).toBeUndefined();
    expect(lookupBioPhrase('future-preset-99')).toBeUndefined();
    expect(lookupBioPhrase('')).toBeUndefined();
  });
});
