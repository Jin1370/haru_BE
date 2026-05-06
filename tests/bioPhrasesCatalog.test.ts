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
    const entry = lookupBioPhrase('aegyo-1');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('aegyo-1');
    expect(entry!.text.ko).toBeTruthy();
  });

  it('미상 id → undefined 반환 (Gemini 폴백 진입 트리거)', () => {
    expect(lookupBioPhrase('does-not-exist')).toBeUndefined();
    expect(lookupBioPhrase('future-preset-99')).toBeUndefined();
    expect(lookupBioPhrase('')).toBeUndefined();
  });
});
