import { describe, it, expect } from 'vitest';
import {
  prepareTextForTTS,
  stripAudioTags,
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
} from '../src/utils/textNormalization';

// ── prepareTextForTTS — 감정 마커 → eleven_v3 audio tag ──────────────────────
// 파이프라인 위치: Gemini 번역 **앞** (시스템 프롬프트의 보존 룰이 태그를 통과시킴).
// 5 개 타깃 언어 대표 슬랭 커버 (ko/ja/en/th/hi).

describe('prepareTextForTTS — laughter [laughs]', () => {
  describe('Korean', () => {
    it('ㅋ run (단일 포함 — jamo 단독은 한국어 일반 텍스트에 등장하지 않음)', () => {
      expect(prepareTextForTTS('ㅋ')).toBe('[laughs]');
      expect(prepareTextForTTS('ㅋㅋ')).toBe('[laughs]');
      expect(prepareTextForTTS('ㅋㅋㅋㅋ')).toBe('[laughs]');
    });
    it('ㅎ run (단일 포함)', () => {
      expect(prepareTextForTTS('ㅎ')).toBe('[laughs]');
      expect(prepareTextForTTS('ㅎㅎㅎ')).toBe('[laughs]');
    });
    it('다른 자모 직후의 ㅋ/ㅎ 는 약어로 간주하고 미매칭 (ㅇㅋ=오케이 등)', () => {
      expect(prepareTextForTTS('ㅇㅋ')).toBe('ㅇㅋ');
      expect(prepareTextForTTS('ㅇㅎ')).toBe('ㅇㅎ');
    });
    it('음절(안/녕 등) 직후의 ㅋ/ㅎ 는 정상 매칭', () => {
      expect(prepareTextForTTS('안녕ㅋㅋ')).toBe('안녕[laughs]');
      expect(prepareTextForTTS('좋아ㅎㅎ')).toBe('좋아[laughs]');
    });
    it('푸하하 / 와하하', () => {
      expect(prepareTextForTTS('푸하하')).toBe('[laughs]');
      expect(prepareTextForTTS('와하하하하')).toBe('[laughs]');
    });
  });

  describe('Japanese', () => {
    it('www', () => {
      expect(prepareTextForTTS('www')).toBe('[laughs]');
      expect(prepareTextForTTS('wwwwwww')).toBe('[laughs]');
    });
    it('w 또는 ww 는 변환 안 됨 (false positive 방지)', () => {
      expect(prepareTextForTTS('ww')).toBe('ww');
    });
    it('草', () => {
      expect(prepareTextForTTS('草')).toBe('[laughs]');
      expect(prepareTextForTTS('草草草')).toBe('[laughs]');
    });
    it('あはは / ワロタ', () => {
      expect(prepareTextForTTS('あはは')).toBe('[laughs]');
      expect(prepareTextForTTS('ワロタ')).toBe('[laughs]');
    });
  });

  describe('English (word-bounded)', () => {
    it('haha / hahaha', () => {
      expect(prepareTextForTTS('haha')).toBe('[laughs]');
      expect(prepareTextForTTS('hahaha')).toBe('[laughs]');
      expect(prepareTextForTTS('HAHA')).toBe('[laughs]'); // case-insensitive
    });
    it('hehe', () => {
      expect(prepareTextForTTS('hehe')).toBe('[laughs]');
    });
    it('단일 ha / he 는 변환 안 됨', () => {
      expect(prepareTextForTTS('ha')).toBe('ha');
      expect(prepareTextForTTS('he')).toBe('he');
    });
    it('lol / lolll / lmao / rofl', () => {
      expect(prepareTextForTTS('lol')).toBe('[laughs]');
      expect(prepareTextForTTS('lolll')).toBe('[laughs]');
      expect(prepareTextForTTS('lmao')).toBe('[laughs]');
      expect(prepareTextForTTS('rofl')).toBe('[laughs]');
    });
    it('CJK 인접 영어 슬랭도 매칭', () => {
      expect(prepareTextForTTS('안녕haha반가워')).toBe('안녕[laughs]반가워');
    });
  });

  describe('Thai', () => {
    it('555 / 555555', () => {
      expect(prepareTextForTTS('555')).toBe('[laughs]');
      expect(prepareTextForTTS('5555555')).toBe('[laughs]');
    });
    it('5 / 55 는 변환 안 됨 (false positive 방지 — 일반 숫자)', () => {
      expect(prepareTextForTTS('55')).toBe('55');
    });
    it('ฮ่าๆ', () => {
      expect(prepareTextForTTS('ฮ่าๆ')).toBe('[laughs]');
    });
  });

  describe('Hindi', () => {
    it('हाहा / हीही', () => {
      expect(prepareTextForTTS('हाहा')).toBe('[laughs]');
      expect(prepareTextForTTS('हीही')).toBe('[laughs]');
    });
  });

  describe('Emoticons (모든 언어 공통)', () => {
    it('xD / XD / xDDD', () => {
      expect(prepareTextForTTS('xD')).toBe('[laughs]');
      expect(prepareTextForTTS('XD')).toBe('[laughs]');
      expect(prepareTextForTTS('xDDD')).toBe('[laughs]');
      expect(prepareTextForTTS('XDDDDD')).toBe('[laughs]');
    });
    it(':D / :-D / :DD', () => {
      expect(prepareTextForTTS(':D')).toBe('[laughs]');
      expect(prepareTextForTTS(':-D')).toBe('[laughs]');
      expect(prepareTextForTTS(':DD')).toBe('[laughs]');
    });
    it('=D / =DDD', () => {
      expect(prepareTextForTTS('=D')).toBe('[laughs]');
      expect(prepareTextForTTS('=DDD')).toBe('[laughs]');
    });
    it('letter 뒤의 :D 는 매칭 안 됨 (URL/식별자 충돌 회피)', () => {
      expect(prepareTextForTTS('myAPI:DEBUG')).toBe('myAPI:DEBUG');
    });
    it('xdebug 같이 D 뒤에 letter 가 이어지면 매칭 안 됨', () => {
      expect(prepareTextForTTS('xdebug')).toBe('xdebug');
    });
    it('문장 내 emoticon 부분 치환', () => {
      expect(prepareTextForTTS('오늘 재밌었어 xD')).toBe('오늘 재밌었어 [laughs]');
      expect(prepareTextForTTS('that was funny :D 진짜로')).toBe(
        'that was funny [laughs] 진짜로',
      );
    });
  });
});

describe('prepareTextForTTS — sadness [sad]', () => {
  it('ㅠ run (단일 포함)', () => {
    expect(prepareTextForTTS('ㅠ')).toBe('[sad]');
    expect(prepareTextForTTS('ㅠㅠ')).toBe('[sad]');
    expect(prepareTextForTTS('ㅠㅠㅠㅠㅠ')).toBe('[sad]');
  });
  it('ㅜ run (단일 포함)', () => {
    expect(prepareTextForTTS('ㅜ')).toBe('[sad]');
    expect(prepareTextForTTS('ㅜㅜ')).toBe('[sad]');
  });
  it('흑흑 / 엉엉', () => {
    expect(prepareTextForTTS('흑흑')).toBe('[sad]');
    expect(prepareTextForTTS('엉엉')).toBe('[sad]');
  });
  it('일본어 うぅ / ぴえん', () => {
    expect(prepareTextForTTS('うぅ')).toBe('[sad]');
    expect(prepareTextForTTS('ぴえん')).toBe('[sad]');
  });
  it('영어 *sob* / *sobs*', () => {
    expect(prepareTextForTTS('*sob*')).toBe('[sad]');
    expect(prepareTextForTTS('*sobs*')).toBe('[sad]');
  });
  it('영어 단독 "sob" 은 변환 안 됨 (일반 단어 충돌 회피)', () => {
    expect(prepareTextForTTS('sob')).toBe('sob');
  });

  describe('Emoticons (모든 언어 공통)', () => {
    it(':( / :-( / ;( / ;-(', () => {
      expect(prepareTextForTTS(':(')).toBe('[sad]');
      expect(prepareTextForTTS(':-(')).toBe('[sad]');
      expect(prepareTextForTTS(';(')).toBe('[sad]');
      expect(prepareTextForTTS(';-(')).toBe('[sad]');
    });
    it(":(( :((( (괄호 반복)", () => {
      expect(prepareTextForTTS(':((')).toBe('[sad]');
      expect(prepareTextForTTS(':(((')).toBe('[sad]');
    });
    it(":'( :'-( 눈물 우는 얼굴", () => {
      expect(prepareTextForTTS(":'(")).toBe('[sad]');
      expect(prepareTextForTTS(":'-(")).toBe('[sad]');
    });
    it('T_T / T-T / t_t', () => {
      expect(prepareTextForTTS('T_T')).toBe('[sad]');
      expect(prepareTextForTTS('T-T')).toBe('[sad]');
      expect(prepareTextForTTS('t_t')).toBe('[sad]');
    });
    it('Q_Q (게이머 슬랭)', () => {
      expect(prepareTextForTTS('Q_Q')).toBe('[sad]');
    });
    it(';_; ', () => {
      expect(prepareTextForTTS(';_;')).toBe('[sad]');
    });
    it('문장 내 emoticon 부분 치환', () => {
      expect(prepareTextForTTS('오늘 너무 힘들어 ㅠㅠ T_T')).toBe(
        '오늘 너무 힘들어 [sad] [sad]',
      );
      expect(prepareTextForTTS('Sad day :( really')).toBe('Sad day [sad] really');
    });
  });
});

describe('prepareTextForTTS — 한숨은 의도적으로 dictionary 제외', () => {
  it('에휴/はぁ/ugh 등 한숨 의성어는 raw 그대로 통과 (Gemini 가 자연 번역, TTS 가 자연 발화)', () => {
    expect(prepareTextForTTS('에휴')).toBe('에휴');
    expect(prepareTextForTTS('어휴')).toBe('어휴');
    expect(prepareTextForTTS('후우')).toBe('후우');
    expect(prepareTextForTTS('はぁ')).toBe('はぁ');
    expect(prepareTextForTTS('やれやれ')).toBe('やれやれ');
    expect(prepareTextForTTS('ugh')).toBe('ugh');
    expect(prepareTextForTTS('*sigh*')).toBe('*sigh*');
    expect(prepareTextForTTS('เฮ้อ')).toBe('เฮ้อ');
  });
});

describe('prepareTextForTTS — mixed & general', () => {
  it('문장 내 부분 치환', () => {
    expect(prepareTextForTTS('안녕 ㅋㅋㅋㅋ 반가워')).toBe('안녕 [laughs] 반가워');
  });

  it('마커 없는 텍스트는 변경 없음', () => {
    expect(prepareTextForTTS('안녕하세요')).toBe('안녕하세요');
    expect(prepareTextForTTS('こんにちは')).toBe('こんにちは');
  });

  it('빈 문자열 안전', () => {
    expect(prepareTextForTTS('')).toBe('');
  });

  it('여러 감정 동시 치환 — 한숨(에휴)은 raw, 웃음/슬픔만 태그화', () => {
    expect(prepareTextForTTS('ㅋㅋㅋ 오늘 만났는데 에휴 힘들었어 ㅠㅠ')).toBe(
      '[laughs] 오늘 만났는데 에휴 힘들었어 [sad]',
    );
  });
});

// ── stripAudioTags — DB 저장 시 audio tag 제거 ────────────────────────────────

describe('stripAudioTags', () => {
  it('단일 태그 제거', () => {
    expect(stripAudioTags('[laughs]')).toBe('');
    expect(stripAudioTags('[sad]')).toBe('');
    expect(stripAudioTags('[sighs]')).toBe('');
  });

  it('태그 + 텍스트', () => {
    expect(stripAudioTags('[laughs] 안녕하세요')).toBe('안녕하세요');
    expect(stripAudioTags('안녕 [laughs] 반가워')).toBe('안녕 반가워');
    expect(stripAudioTags('안녕하세요 [laughs]')).toBe('안녕하세요');
  });

  it('여러 태그 + 텍스트', () => {
    expect(
      stripAudioTags('[laughs] 오늘 만났는데 [sighs] 힘들었어 [sad]'),
    ).toBe('오늘 만났는데 힘들었어');
  });

  it('eleven_v3 표준 태그 화이트리스트 (laughs/sad/sighs/crying/chuckles/whispers/exhales/gasps/groans) 제거', () => {
    expect(stripAudioTags('[crying] hello [whispers]')).toBe('hello');
    expect(stripAudioTags('[chuckles] [gasps]')).toBe('');
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

// ── replaceTagsForDisplay — audio tag → 타깃 언어 슬랭 ────────────────────────

describe('replaceTagsForDisplay', () => {
  describe('laughs', () => {
    it('각 언어별 슬랭으로 치환', () => {
      expect(replaceTagsForDisplay('[laughs]', 'ko')).toBe('ㅋㅋㅋ');
      expect(replaceTagsForDisplay('[laughs]', 'ja')).toBe('www');
      expect(replaceTagsForDisplay('[laughs]', 'en')).toBe('lol');
      expect(replaceTagsForDisplay('[laughs]', 'th')).toBe('555');
      expect(replaceTagsForDisplay('[laughs]', 'hi')).toBe('हाहा');
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
    it('[sighs] 는 그대로 통과 (현재 prepareTextForTTS 가 emit 하지 않으므로 실제 데이터에 나오지 않음)', () => {
      expect(replaceTagsForDisplay('[sighs]', 'ko')).toBe('[sighs]');
      expect(replaceTagsForDisplay('[sighs]', 'ja')).toBe('[sighs]');
    });
  });

  describe('문장 내 부분 치환 (사용자 시나리오)', () => {
    it('ko → ja: ㅋㅋㅋ 포함 문장 → www', () => {
      // 번역 어때요?ㅋㅋㅋ → prepareTextForTTS → "번역 어때요?[laughs]"
      // → Gemini ja → "翻訳はどうですか？[laughs]" → display(ja) → "翻訳はどうですか？www"
      expect(replaceTagsForDisplay('翻訳はどうですか？[laughs]', 'ja')).toBe(
        '翻訳はどうですか？www',
      );
    });

    it('여러 태그 동시 치환 (ja)', () => {
      expect(
        replaceTagsForDisplay('[laughs] 今日.. でも.. [sad]', 'ja'),
      ).toBe('www 今日.. でも.. (泣)');
    });
  });

  describe('지원 외 언어 fallback', () => {
    it('알 수 없는 언어는 default 슬랭(영어 기준)', () => {
      expect(replaceTagsForDisplay('[laughs]', 'zh')).toBe('lol');
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
      expect(replaceTagsForDisplay('hello  [laughs]  world', 'en')).toBe(
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
    expect(hasSpeakableContent('[laughs]')).toBe(true);
    expect(hasSpeakableContent('[sad]')).toBe(true);
    expect(hasSpeakableContent('[sighs]')).toBe(true); // defensive — 외부 경로 호환
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
    expect(ensureSpeakableForTTS('[laughs]')).toBe('[laughs].');
    expect(ensureSpeakableForTTS('[sad]')).toBe('[sad].');
  });

  it('연속 태그 단독도 패딩', () => {
    expect(ensureSpeakableForTTS('[laughs][sad]')).toBe('[laughs][sad].');
  });

  it('태그 + 발화 가능 텍스트는 패딩 안 함', () => {
    expect(ensureSpeakableForTTS('[laughs] 안녕')).toBe('[laughs] 안녕');
    expect(ensureSpeakableForTTS('안녕 [laughs]')).toBe('안녕 [laughs]');
  });

  it('태그 없는 일반 텍스트는 변경 없음', () => {
    expect(ensureSpeakableForTTS('안녕하세요')).toBe('안녕하세요');
  });

  it('빈 문자열 / whitespace-only 는 패딩 안 함 (BE validation 이 먼저 막음)', () => {
    expect(ensureSpeakableForTTS('')).toBe('');
    expect(ensureSpeakableForTTS('   ')).toBe('   ');
  });
});
