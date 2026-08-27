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
});

// ── replaceTagsForDisplay — audio tag → 타깃 언어 슬랭 ────────────────────────

describe('replaceTagsForDisplay', () => {
  describe('soft laugh', () => {
    it('각 언어별 슬랭으로 치환', () => {
      expect(replaceTagsForDisplay('[soft laugh]', 'ko')).toBe('ㅋㅋㅋ');
      expect(replaceTagsForDisplay('[soft laugh]', 'ja')).toBe('www');
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
    it('ko → ja: ㅋㅋㅋ 포함 문장 → www', () => {
      // 번역 어때요?ㅋㅋㅋ → Gemini(STEP1 태깅+ja 번역) → "翻訳はどうですか？[soft laugh]"
      // → display(ja) → "翻訳はどうですか？www"
      expect(replaceTagsForDisplay('翻訳はどうですか？[soft laugh]', 'ja')).toBe(
        '翻訳はどうですか？www',
      );
    });

    it('여러 태그 동시 치환 (ja)', () => {
      expect(
        replaceTagsForDisplay('[soft laugh] 今日.. でも.. [sad]', 'ja'),
      ).toBe('www 今日.. でも.. (泣)');
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