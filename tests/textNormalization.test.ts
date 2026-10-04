import { describe, it, expect } from 'vitest';
import {
  sanitizeAudioTags,
  stripAudioTags,
  isTranslationIdentity,
  stripNonAudibleTags,
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
  readKoreanNumbersForTTS,
} from '../src/utils/textNormalization';

// ── readKoreanNumbersForTTS — 숫자 오독 교정 (TTS 입력 전용) ──────────────────
describe('readKoreanNumbersForTTS', () => {
  it('고유어 단위 앞 숫자를 한글 수사로 (서수 1 은 첫)', () => {
    expect(readKoreanNumbersForTTS('1번째로 좋아')).toBe('첫 번째로 좋아');
    expect(readKoreanNumbersForTTS('2번째')).toBe('두 번째');
    expect(readKoreanNumbersForTTS('20번째')).toBe('스무 번째');
    expect(readKoreanNumbersForTTS('커피 2잔이랑 3개 주세요')).toBe('커피 두 잔이랑 세 개 주세요');
    expect(readKoreanNumbersForTTS('7시에 만날래?')).toBe('일곱 시에 만날래?');
    expect(readKoreanNumbersForTTS('나 25살이야')).toBe('나 25살이야'); // 21 이상은 그대로
  });

  it('한자어가 맞는 자리는 건드리지 않음', () => {
    expect(readKoreanNumbersForTTS('3개월 됐어')).toBe('3개월 됐어');
    expect(readKoreanNumbersForTTS('3번 버스')).toBe('3번 버스');
    expect(readKoreanNumbersForTTS('10분 뒤에 2024년')).toBe('10분 뒤에 2024년');
    expect(readKoreanNumbersForTTS('100개')).toBe('100개');
  });
});

// ── sanitizeAudioTags — Gemini 출력 화이트리스트 검증 ─────────────────────────
// 감정 마커 → audio tag 치환은 이제 Gemini(translation.ts STEP 1)가 수행하고,
// 그 출력을 이 함수가 화이트리스트로 검증한다 (regex prepareTextForTTS 폐지).

describe('sanitizeAudioTags — 화이트리스트 검증', () => {
  it('화이트리스트 태그는 보존', () => {
    expect(sanitizeAudioTags('안녕[soft laugh]')).toBe('안녕[soft laugh]');
    expect(sanitizeAudioTags('슬프다 [sad]')).toBe('슬프다 [sad]');
    expect(sanitizeAudioTags('[soft laugh] 오늘 [sad]')).toBe('[soft laugh] 오늘 [sad]');
  });

  it('소비처 없는 eleven_v3 표준 태그는 제거 (display 누출 차단)', () => {
    // replaceTagsForDisplay 가 soft laugh|sad 만 매핑하므로 통과시키면 raw 문자열이
    // translated_text 에 남는다. 입구에서 지운다.
    expect(sanitizeAudioTags('[sighs][crying][chuckles][whispers]')).toBe('');
    expect(sanitizeAudioTags('안녕[sighs]')).toBe('안녕');
  });

  it('화이트리스트 외 well-formed 태그는 제거', () => {
    expect(sanitizeAudioTags('안녕[laugh]')).toBe('안녕'); // [laugh] 변형 제거
    expect(sanitizeAudioTags('안녕[laughs]')).toBe('안녕'); // 옛 이름도 이제 화이트리스트 밖
    expect(sanitizeAudioTags('안녕[softlaugh]')).toBe('안녕'); // 공백 없는 변형 제거
    expect(sanitizeAudioTags('화났어[angry]')).toBe('화났어');
    expect(sanitizeAudioTags('[wtf] hello')).toBe('hello');
    expect(sanitizeAudioTags('a[foo]b')).toBe('ab');
  });

  it('대소문자/공백은 canonical 소문자로 정규화', () => {
    expect(sanitizeAudioTags('[SOFT LAUGH]')).toBe('[soft laugh]');
    expect(sanitizeAudioTags('[ Sad ]')).toBe('[sad]');
    expect(sanitizeAudioTags('[Soft Laugh]')).toBe('[soft laugh]');
    // 내부 연속 공백도 1칸으로 접는다.
    expect(sanitizeAudioTags('[ SOFT  LAUGH ]')).toBe('[soft laugh]');
  });

  it('malformed / unclosed 태그 조각 제거', () => {
    expect(sanitizeAudioTags('안녕 [soft laugh 오늘')).toBe('안녕 오늘'); // 닫는 대괄호 없음
    expect(sanitizeAudioTags('끝에 [sad')).toBe('끝에');
    expect(sanitizeAudioTags('[soft laugh][sad')).toBe('[soft laugh]'); // 두번째만 malformed
  });

  it('단독 자모는 제거 — 초성체가 TTS 로 새면 자모 이름을 읽는다', () => {
    // Gemini STEP 1 이 못 펴서 흘려보낸 초성체. 섞인 문장은 자모만 빠지고 본문은 남는다.
    expect(stripNonAudibleTags('ㄷㄱㄷㄱ 기대돼')).toBe('기대돼');
    expect(stripNonAudibleTags('ㄷㄱㄷㄱ')).toBe('');
    // 완성형 한글은 자모 범위 밖이라 무사
    expect(stripNonAudibleTags('두근두근')).toBe('두근두근');
  });

  it('태그 없는 텍스트는 trim 만', () => {
    expect(sanitizeAudioTags('안녕하세요')).toBe('안녕하세요');
    expect(sanitizeAudioTags('  hello  ')).toBe('hello');
    expect(sanitizeAudioTags('こんにちは')).toBe('こんにちは');
  });

  it('연속 공백 정리', () => {
    expect(sanitizeAudioTags('hello  [foo]  world')).toBe('hello world');
  });

  it('빈 문자열 안전', () => {
    expect(sanitizeAudioTags('')).toBe('');
  });

  it('태그 단독이 화이트리스트면 보존 (TTS 효과음 전용 메시지)', () => {
    expect(sanitizeAudioTags('[soft laugh]')).toBe('[soft laugh]');
  });

  it('태그 단독이 화이트리스트 외면 빈 문자열 (호출처가 missing 처리)', () => {
    expect(sanitizeAudioTags('[giggles]')).toBe('');
  });
});

// ── stripAudioTags — DB 저장 시 audio tag 제거 ────────────────────────────────

describe('stripAudioTags', () => {
  it('단일 태그 제거', () => {
    expect(stripAudioTags('[soft laugh]')).toBe('');
    expect(stripAudioTags('[sad]')).toBe('');
  });

  it('태그 + 텍스트', () => {
    expect(stripAudioTags('[soft laugh] 안녕하세요')).toBe('안녕하세요');
    expect(stripAudioTags('안녕 [soft laugh] 반가워')).toBe('안녕 반가워');
    expect(stripAudioTags('안녕하세요 [soft laugh]')).toBe('안녕하세요');
  });

  it('여러 태그 + 텍스트', () => {
    expect(
      stripAudioTags('[soft laugh] 오늘 만났는데 힘들었어 [sad]'),
    ).toBe('오늘 만났는데 힘들었어');
  });

  it('소비처 없는 eleven_v3 표준 태그는 대상 아님 (sanitize 가 입구에서 이미 제거)', () => {
    expect(stripAudioTags('[crying] hello [whispers]')).toBe('[crying] hello [whispers]');
  });

  it('알 수 없는 태그는 제거 안 됨 (화이트리스트 외)', () => {
    expect(stripAudioTags('[unknown] hello')).toBe('[unknown] hello');
  });

  it('태그 없는 텍스트는 trim 만 적용', () => {
    expect(stripAudioTags('안녕하세요')).toBe('안녕하세요');
    expect(stripAudioTags('  hello  ')).toBe('hello');
  });

  it('빈 문자열 안전', () => {
    expect(stripAudioTags('')).toBe('');
  });
});

// ── stripNonAudibleTags — TTS 입력에서 [soft laugh] 만 audible, 나머지 display-only ─

describe('stripNonAudibleTags', () => {
  it('[soft laugh] 는 보존 (audible)', () => {
    expect(stripNonAudibleTags('웃기네 [soft laugh]')).toBe('웃기네 [soft laugh]');
    expect(stripNonAudibleTags('[soft laugh] 안녕')).toBe('[soft laugh] 안녕');
  });

  it('[sad] 는 제거 (display-only, TTS 로 흐느낌 안 냄)', () => {
    expect(stripNonAudibleTags('슬프다[sad]')).toBe('슬프다');
    expect(stripNonAudibleTags('오늘 힘들어 [sad] 그래도')).toBe('오늘 힘들어 그래도');
  });

  it('화이트리스트는 soft laugh/sad 뿐 — 그 외 태그는 대상 아님', () => {
    expect(stripNonAudibleTags('hi [whispers] there')).toBe('hi [whispers] there');
  });

  it('soft laugh + sad 혼합 → soft laugh 만 남김', () => {
    expect(stripNonAudibleTags('안녕[soft laugh] 슬프네[sad]')).toBe('안녕[soft laugh] 슬프네');
  });

  it('순수 sad → 빈 문자열 (호출처가 TTS 스킵 판단)', () => {
    expect(stripNonAudibleTags('[sad]')).toBe('');
  });

  it('태그 없는 텍스트는 trim 만', () => {
    expect(stripNonAudibleTags('안녕하세요')).toBe('안녕하세요');
  });

  it('빈 문자열 안전', () => {
    expect(stripNonAudibleTags('')).toBe('');
  });

  it('URL 제거 — TTS 가 링크를 읽지 않는다', () => {
    expect(stripNonAudibleTags('이거 봐 https://youtu.be/dQw4w9WgXcQ 대박')).toBe('이거 봐 대박');
    expect(stripNonAudibleTags('www.naver.com 여기')).toBe('여기');
    expect(stripNonAudibleTags('http://a.b/c?d=1&e=2')).toBe('');
  });

  it('URL 뒤 공백 없이 붙은 문장을 먹지 않는다', () => {
    // 회귀: `\S+` 로 잡던 시절 "링크보세요" 만 남고 뒷문장이 통째로 사라졌다.
    expect(stripNonAudibleTags('링크보세요https://youtu.be/dQw4w9WgXcQ대박이에요'))
      .toBe('링크보세요 대박이에요');
    expect(stripNonAudibleTags('これ見てhttps://a.b/cすごい')).toBe('これ見て すごい');
  });

  it('링크만 있는 메시지 → 빈 문자열 (호출처가 TTS 스킵 판단)', () => {
    expect(hasSpeakableContent(stripNonAudibleTags('https://open.spotify.com/track/xyz'))).toBe(false);
    // lang 을 줘도 "링크" 한 단어만 읽히지 않는다
    expect(stripNonAudibleTags('https://open.spotify.com/track/xyz 😊', 'ko')).toBe('');
  });

  it('lang 을 주면 문장 속 URL 은 "링크" 로 읽는다 — 앞말 끊김 방지', () => {
    expect(stripNonAudibleTags('https://youtu.be/abc123로 들어가면 돼', 'ko')).toBe('링크로 들어가면 돼');
    expect(stripNonAudibleTags('여기 https://youtu.be/abc 로 들어가면 돼', 'ko')).toBe('여기 링크 로 들어가면 돼');
    expect(stripNonAudibleTags('https://a.b/cから入ればいいよ', 'ja')).toBe('リンクから入ればいいよ');
    expect(stripNonAudibleTags('check https://a.b/c out', 'en')).toBe('check link out');
    // 줄 끝 링크는 단어 없이 지운다 — "이거 참고해 링크" 로 덧붙지 않게
    expect(stripNonAudibleTags('이거 참고해 https://youtu.be/abc', 'ko')).toBe('이거 참고해');
    expect(stripNonAudibleTags('참고해 https://a.b/c [soft laugh]', 'ko')).toBe('참고해 [soft laugh]');
    expect(stripNonAudibleTags('이거 봐 https://a.b/c\n어때?', 'ko')).toBe('이거 봐 어때?');
    // 미등록 언어는 기존대로 제거
    expect(stripNonAudibleTags('여기 https://a.b/c 봐', 'xx')).toBe('여기 봐');
  });

  it('얼굴 이모티콘은 무음 — 말이 든 괄호는 남긴다', () => {
    expect(stripNonAudibleTags('ありがとう(^^)', 'ja')).toBe('ありがとう');
    expect(stripNonAudibleTags('좋아^^', 'ko')).toBe('좋아');
    expect(stripNonAudibleTags('やった(๑•̀ㅂ•́)و✧', 'ja')).toBe('やった');
    expect(stripNonAudibleTags('ラーメン(ノ´∀｀)', 'ja')).toBe('ラーメン');
    expect(stripNonAudibleTags('10:30 :) 만나', 'ko')).toBe('10:30 만나');
    expect(stripNonAudibleTags('(笑) 面白い', 'ja')).toBe('(笑) 面白い');
    expect(stripNonAudibleTags('(ok) 좋아', 'ko')).toBe('(ok) 좋아');
  });

  it('문장 속 이메일·긴 번호는 단어로 대체', () => {
    expect(stripNonAudibleTags('maru@gmail.com 으로 연락해', 'ko')).toBe('이메일 으로 연락해');
    expect(stripNonAudibleTags('010-1234-5678 로 전화해', 'ko')).toBe('번호 로 전화해');
    expect(stripNonAudibleTags('電話は090ー1234ー5678です', 'ja')).toBe('電話は番号です');
    expect(stripNonAudibleTags('+82 10 1234 5678 call me', 'en')).toBe('number call me');
    // 줄 끝 이메일·번호는 단어 없이 지운다 (연달아 있어도 끝에서부터)
    expect(stripNonAudibleTags('연락해 maru@gmail.com', 'ko')).toBe('연락해');
    expect(stripNonAudibleTags('내 번호야 010-1234-5678', 'ko')).toBe('내 번호야');
    expect(stripNonAudibleTags('연락해 maru@gmail.com 010-1234-5678', 'ko')).toBe('연락해');
    // 날짜(8자리)·금액은 전화번호 아님
    expect(stripNonAudibleTags('2026.10.04에 만나', 'ko')).toBe('2026.10.04에 만나');
    expect(stripNonAudibleTags('10000원이야', 'ko')).toBe('10000원이야');
  });

  it('이모티콘·이메일·전화번호·링크만 있는 메시지 → 빈 문자열 (TTS 스킵)', () => {
    for (const t of ['(^^)', '(´・ω・`)', 'T_T', 'maru@gmail.com', '010-1234-5678', 'https://a.b/c 😊 (^^)']) {
      expect(stripNonAudibleTags(t, 'ko')).toBe('');
    }
  });

  // 사고: 「はじめまして☺️」가 "はじめまして☺️…" 로 합성돼 「また」가 함께 발화됨.
  it('이모지 제거 — TTS 가 이모지를 읽거나 뒷말을 지어내지 않는다', () => {
    expect(stripNonAudibleTags('はじめまして☺️')).toBe('はじめまして');
    expect(stripNonAudibleTags('반가워요😊😊')).toBe('반가워요');
    expect(stripNonAudibleTags('오늘❤️ 좋았어')).toBe('오늘 좋았어');
    // 국기(regional indicator) · 피부톤 · ZWJ 결합 이모지도 잔재 없이 제거
    expect(stripNonAudibleTags('한국🇰🇷 좋아👍🏻 가족👨‍👩‍👧')).toBe('한국 좋아 가족');
  });

  it('문장부호·숫자는 보존 (\\p{Emoji} 오적용 방지)', () => {
    // \p{Emoji} 는 0-9 와 #·* 까지 잡는다 — 숫자가 지워지면 "3시" 가 "시" 가 된다.
    expect(stripNonAudibleTags('3시 어때요? 좋아요~ 그럼、그때！')).toBe('3시 어때요? 좋아요~ 그럼、그때！');
  });

  it('이모지만 있는 메시지 → 빈 문자열 (호출처가 TTS 스킵 판단)', () => {
    expect(hasSpeakableContent(stripNonAudibleTags('😂😂😂'))).toBe(false);
  });
});

// ── replaceTagsForDisplay — audio tag → 타깃 언어 슬랭 ────────────────────────

describe('replaceTagsForDisplay', () => {
  describe('soft laugh', () => {
    it('각 언어별 슬랭으로 치환', () => {
      expect(replaceTagsForDisplay('[soft laugh]', 'ko')).toBe('ㅋㅋㅋ');
      expect(replaceTagsForDisplay('[soft laugh]', 'ja')).toBe('笑');
      expect(replaceTagsForDisplay('[soft laugh]', 'en')).toBe('lol');
      expect(replaceTagsForDisplay('[soft laugh]', 'th')).toBe('555');
      expect(replaceTagsForDisplay('[soft laugh]', 'hi')).toBe('हाहा');
    });
  });

  describe('sad', () => {
    it('각 언어별 슬랭으로 치환', () => {
      expect(replaceTagsForDisplay('[sad]', 'ko')).toBe('ㅠㅠ');
      expect(replaceTagsForDisplay('[sad]', 'ja')).toBe('(泣)');
      expect(replaceTagsForDisplay('[sad]', 'en')).toBe(':(');
      expect(replaceTagsForDisplay('[sad]', 'th')).toBe('T_T');
      expect(replaceTagsForDisplay('[sad]', 'hi')).toBe(':(');
    });
  });

  describe('[sighs] 는 dictionary 외 — 치환 안 됨 (raw tag 그대로)', () => {
    it('[sighs] 는 그대로 통과 (sanitizeAudioTags 가 입구에서 제거하므로 여기까지 오지 않음)', () => {
      expect(replaceTagsForDisplay('[sighs]', 'ko')).toBe('[sighs]');
      expect(replaceTagsForDisplay('[sighs]', 'ja')).toBe('[sighs]');
    });
  });

  describe('문장 내 부분 치환 (사용자 시나리오)', () => {
    it('ko → ja: 원문에 ㅋ 가 있으면 笑笑', () => {
      // 번역 어때요?ㅋㅋㅋ → Gemini(STEP1 태깅+ja 번역) → "翻訳はどうですか？[soft laugh]"
      expect(replaceTagsForDisplay('翻訳はどうですか？[soft laugh]', 'ja', '번역 어때요?ㅋㅋㅋ')).toBe(
        '翻訳はどうですか？笑笑',
      );
    });

    it('ko → ja: 받침에 붙은 ㅋ("재밌닼")도 笑笑', () => {
      expect(replaceTagsForDisplay('面白い[soft laugh]', 'ja', '재밌닼')).toBe('面白い笑笑');
    });

    it('ko → ja: ㅎㅎ 는 笑 — 받침 ㅎ(좋아)는 ㅋ 로 안 셈', () => {
      expect(replaceTagsForDisplay('いいね[soft laugh]', 'ja', '좋아ㅎㅎ')).toBe('いいね笑');
    });

    it('ko → ja: ㅋ·ㅎ 섞이면 전부 笑笑 (메시지 단위 판정)', () => {
      expect(replaceTagsForDisplay('A[soft laugh] B[soft laugh]', 'ja', '아ㅋㅋ 그리고ㅎㅎ')).toBe('A笑笑 B笑笑');
    });

    it('영어 lol → ko 는 ㅋㅋㅋ', () => {
      expect(replaceTagsForDisplay('웃겨[soft laugh]', 'ko', 'funny lol')).toBe('웃겨ㅋㅋㅋ');
    });

    it('ja → ko: 笑 뿐이면 ㅎㅎ', () => {
      expect(replaceTagsForDisplay('기모노예요?[soft laugh]', 'ko', '着物ですか？笑')).toBe('기모노예요?ㅎㅎ');
      expect(replaceTagsForDisplay('무슨 말이에요?[soft laugh]', 'ko', 'どうゆうことですか笑笑')).toBe('무슨 말이에요?ㅎㅎ');
    });

    it('ja → ko: w·草·爆 는 ㅋㅋㅋ (爆笑 도 爆 우선)', () => {
      for (const orig of ['面白いwww', '面白いｗ', 'それは草', '面白すぎ爆', '面白すぎ爆笑', '笑 そしてwww']) {
        expect(replaceTagsForDisplay('웃겨[soft laugh]', 'ko', orig)).toBe('웃겨ㅋㅋㅋ');
      }
    });

    it('ja → ko: 라틴 단어 속 w(wow)는 웃음으로 안 셈', () => {
      expect(replaceTagsForDisplay('와우[soft laugh]', 'ko', 'wow笑')).toBe('와우ㅎㅎ');
    });

    it('여러 태그 동시 치환 (ja)', () => {
      expect(
        replaceTagsForDisplay('[soft laugh] 今日.. でも.. [sad]', 'ja'),
      ).toBe('笑 今日.. でも.. (泣)');
    });
  });

  describe('지원 외 언어 fallback', () => {
    it('알 수 없는 언어는 default 슬랭(영어 기준)', () => {
      expect(replaceTagsForDisplay('[soft laugh]', 'zh')).toBe('lol');
      expect(replaceTagsForDisplay('[sad]', 'fr')).toBe(':(');
    });
  });

  describe('edge cases', () => {
    it('태그 없는 텍스트는 변경 없음', () => {
      expect(replaceTagsForDisplay('안녕하세요', 'ko')).toBe('안녕하세요');
      expect(replaceTagsForDisplay('こんにちは', 'ja')).toBe('こんにちは');
    });
    it('빈 문자열 안전', () => {
      expect(replaceTagsForDisplay('', 'ko')).toBe('');
    });
    it('연속 공백 정리', () => {
      expect(replaceTagsForDisplay('hello  [soft laugh]  world', 'en')).toBe(
        'hello lol world',
      );
    });
  });
});

// ── ensureSpeakableForTTS — ElevenLabs 빈 텍스트 reject 회피 ──────────────────

// ── hasSpeakableContent — TTS 스킵 판단 ───────────────────────────────────────

describe('hasSpeakableContent', () => {
  it('Letter 가 있으면 true (모든 스크립트)', () => {
    expect(hasSpeakableContent('안녕')).toBe(true);
    expect(hasSpeakableContent('hello')).toBe(true);
    expect(hasSpeakableContent('こんにちは')).toBe(true);
    expect(hasSpeakableContent('สวัสดี')).toBe(true);
    expect(hasSpeakableContent('नमस्ते')).toBe(true);
  });

  it('Number 가 있으면 true', () => {
    expect(hasSpeakableContent('123')).toBe(true);
    expect(hasSpeakableContent('하루 7시')).toBe(true);
  });

  it('audio tag 가 있으면 true (효과음이라도 생성됨)', () => {
    expect(hasSpeakableContent('[soft laugh]')).toBe(true);
    expect(hasSpeakableContent('[sad]')).toBe(true);
    // [sighs] 는 sanitizeAudioTags 가 입구에서 지우므로 여기 도달하지 않는다.
    // 도달하더라도 true — 태그 판정이 아니라 "sighs" 의 letter 들이 걸린다.
    expect(hasSpeakableContent('[sighs]')).toBe(true);
  });

  it('punctuation/symbol/whitespace 만이면 false', () => {
    expect(hasSpeakableContent(':)')).toBe(false);
    expect(hasSpeakableContent(':-)')).toBe(false);
    expect(hasSpeakableContent(';)')).toBe(false);
  });

  it(':P / :p 는 letter 가 있어서 true (TTS 가 letter 발화 가능)', () => {
    expect(hasSpeakableContent(':P')).toBe(true);
    expect(hasSpeakableContent(':p')).toBe(true);
  });

  it('이모지 단독은 false (ElevenLabs 가 emoji strip)', () => {
    expect(hasSpeakableContent('😊')).toBe(false);
    expect(hasSpeakableContent('🎉🎉🎉')).toBe(false);
  });

  it('<3, ???, !!! 등 symbol/punctuation 만 false', () => {
    expect(hasSpeakableContent('<3')).toBe(true); // 3 이 Number — true
    expect(hasSpeakableContent('???')).toBe(false);
    expect(hasSpeakableContent('!!!')).toBe(false);
    expect(hasSpeakableContent('   ')).toBe(false);
  });

  it('mixed 케이스 — letter 하나라도 있으면 true', () => {
    expect(hasSpeakableContent('안녕 :)')).toBe(true);
    expect(hasSpeakableContent(':) hello')).toBe(true);
  });

  it('빈 문자열은 false', () => {
    expect(hasSpeakableContent('')).toBe(false);
  });
});

describe('ensureSpeakableForTTS', () => {
  it('태그 단독 → 마침표 패딩 (재현 케이스: 사용자가 ㅋㅋㅋ만 보냄)', () => {
    expect(ensureSpeakableForTTS('[soft laugh]')).toBe('[soft laugh].');
    expect(ensureSpeakableForTTS('[sad]')).toBe('[sad].');
  });

  it('연속 태그 단독도 패딩', () => {
    expect(ensureSpeakableForTTS('[soft laugh][sad]')).toBe('[soft laugh][sad].');
  });

  it('태그 + 발화 가능 텍스트는 패딩 안 함', () => {
    expect(ensureSpeakableForTTS('[soft laugh] 안녕')).toBe('[soft laugh] 안녕');
    expect(ensureSpeakableForTTS('안녕 [soft laugh]')).toBe('안녕 [soft laugh]');
  });

  it('태그 없는 일반 텍스트는 변경 없음', () => {
    expect(ensureSpeakableForTTS('안녕하세요')).toBe('안녕하세요');
  });

  it('빈 문자열 / whitespace-only 는 패딩 안 함 (BE validation 이 먼저 막음)', () => {
    expect(ensureSpeakableForTTS('')).toBe('');
    expect(ensureSpeakableForTTS('   ')).toBe('   ');
  });
});

// ── isTranslationIdentity — STEP 1 boolean 오판 시 중복 노출 차단 (2차 방어선) ─────
describe('isTranslationIdentity', () => {
  it('태깅·재띄어쓰기만 다르면 동일로 본다', () => {
    expect(isTranslationIdentity('안녕하세요[soft laugh]', '안녕하세요ㅋㅋ')).toBe(true);
    expect(isTranslationIdentity('밥 먹었어?', '밥먹었어?')).toBe(true);
  });

  it('실제로 번역된 텍스트는 동일이 아니다', () => {
    expect(isTranslationIdentity('こんにちは', '안녕하세요')).toBe(false);
    expect(isTranslationIdentity('내일 봐요', '내일 만나요')).toBe(false);
  });

  it('양쪽이 모두 비면 false — 마커뿐인 메시지는 STEP 1 이 판단', () => {
    // ko→ja 면 ㅋㅋ→www 를 보여줘야 하므로 여기서 identity 로 접으면 안 된다.
    expect(isTranslationIdentity('[soft laugh]', 'ㅋㅋㅋ')).toBe(false);
  });
});