import { describe, it, expect } from 'vitest';
import {
  sanitizeAudioTags,
  stripAudioTags,
  stripNonAudibleTags,
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
} from '../src/utils/textNormalization';

// ── sanitizeAudioTags — Gemini 출력 화이트리스트 검증 ─────────────────────────
// 감정 마커 → audio tag 치환은 이제 Gemini(translation.ts STEP 1)가 수행하고,
// 그 출력을 이 함수가 화이트리스트로 검증한다 (regex prepareTextForTTS 폐지).

describe('sanitizeAudioTags — 화이트리스트 검증', () => {
  it('화이트리스트 태그는 보존', () => {
    expect(sanitizeAudioTags('안녕[laughs]')).toBe('안녕[laughs]');
    expect(sanitizeAudioTags('슬프다 [sad]')).toBe('슬프다 [sad]');
    expect(sanitizeAudioTags('[laughs] 오늘 [sad]')).toBe('[laughs] 오늘 [sad]');
    // 모든 화이트리스트 태그 (eleven_v3 표준)
    expect(sanitizeAudioTags('[sighs][crying][chuckles][whispers]')).toBe(
      '[sighs][crying][chuckles][whispers]',
    );
  });

  it('화이트리스트 외 well-formed 태그는 제거', () => {
    expect(sanitizeAudioTags('안녕[laugh]')).toBe('안녕'); // [laugh] 변형 제거
    expect(sanitizeAudioTags('화났어[angry]')).toBe('화났어');
    expect(sanitizeAudioTags('[wtf] hello')).toBe('hello');
    expect(sanitizeAudioTags('a[foo]b')).toBe('ab');
  });

  it('대소문자/공백은 canonical 소문자로 정규화', () => {
    expect(sanitizeAudioTags('[LAUGHS]')).toBe('[laughs]');
    expect(sanitizeAudioTags('[ Sad ]')).toBe('[sad]');
    expect(sanitizeAudioTags('[Laughs]')).toBe('[laughs]');
  });

  it('malformed / unclosed 태그 조각 제거', () => {
    expect(sanitizeAudioTags('안녕 [laughs 오늘')).toBe('안녕 오늘'); // 닫는 대괄호 없음
    expect(sanitizeAudioTags('끝에 [sad')).toBe('끝에');
    expect(sanitizeAudioTags('[laughs][sad')).toBe('[laughs]'); // 두번째만 malformed
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
    expect(sanitizeAudioTags('[laughs]')).toBe('[laughs]');
  });

  it('태그 단독이 화이트리스트 외면 빈 문자열 (호출처가 missing 처리)', () => {
    expect(sanitizeAudioTags('[giggles]')).toBe('');
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

// ── stripNonAudibleTags — TTS 입력에서 [laughs] 만 audible, 나머지 display-only ─

describe('stripNonAudibleTags', () => {
  it('[laughs] 는 보존 (audible)', () => {
    expect(stripNonAudibleTags('웃기네 [laughs]')).toBe('웃기네 [laughs]');
    expect(stripNonAudibleTags('[laughs] 안녕')).toBe('[laughs] 안녕');
  });

  it('[sad] 는 제거 (display-only, TTS 로 흐느낌 안 냄)', () => {
    expect(stripNonAudibleTags('슬프다[sad]')).toBe('슬프다');
    expect(stripNonAudibleTags('오늘 힘들어 [sad] 그래도')).toBe('오늘 힘들어 그래도');
  });

  it('[laughs] 외 모든 화이트리스트 태그 제거', () => {
    expect(stripNonAudibleTags('[sighs][crying][chuckles]')).toBe('');
    expect(stripNonAudibleTags('hi [whispers] there')).toBe('hi there');
  });

  it('laughs + sad 혼합 → laughs 만 남김', () => {
    expect(stripNonAudibleTags('안녕[laughs] 슬프네[sad]')).toBe('안녕[laughs] 슬프네');
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
    it('[sighs] 는 그대로 통과 (Gemini 는 [laughs]/[sad] 만 emit 하므로 실제 데이터에 나오지 않음)', () => {
      expect(replaceTagsForDisplay('[sighs]', 'ko')).toBe('[sighs]');
      expect(replaceTagsForDisplay('[sighs]', 'ja')).toBe('[sighs]');
    });
  });

  describe('문장 내 부분 치환 (사용자 시나리오)', () => {
    it('ko → ja: ㅋㅋㅋ 포함 문장 → www', () => {
      // 번역 어때요?ㅋㅋㅋ → Gemini(STEP1 태깅+ja 번역) → "翻訳はどうですか？[laughs]"
      // → display(ja) → "翻訳はどうですか？www"
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
