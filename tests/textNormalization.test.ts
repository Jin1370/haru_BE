import { describe, it, expect } from 'vitest';
import { normalizeSlangInput } from '../src/utils/textNormalization';

// voice_slang_normalization sprint (2026-05-11):
//   재현 케이스 — `ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ` (×12) 가 Gemini ko→ja 번역에서
//   탄식 텍스트(`あ〜`/`はぁ…`) 로 재해석되어 TTS 가 "으..." 사운드를 합성.
//   정규화 후엔 ×4 로 capped → 학습 분포 안의 정상 웃음 매핑(`あはは`) 으로 안정.

describe('normalizeSlangInput', () => {
  describe('Korean ㅋ length-capping (재현 케이스 핵심)', () => {
    it('×4 는 변경 없음 (=경계 통과)', () => {
      expect(normalizeSlangInput('ㅋㅋㅋㅋ', 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×5 → ×4', () => {
      expect(normalizeSlangInput('ㅋㅋㅋㅋㅋ', 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×8 → ×4', () => {
      expect(normalizeSlangInput('ㅋㅋㅋㅋㅋㅋㅋㅋ', 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×12 → ×4 (사용자 재현 버그 케이스)', () => {
      expect(normalizeSlangInput('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×20 → ×4', () => {
      expect(normalizeSlangInput('ㅋ'.repeat(20), 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×50 → ×4', () => {
      expect(normalizeSlangInput('ㅋ'.repeat(50), 'ko')).toBe('ㅋㅋㅋㅋ');
    });

    it('×1~3 는 변경 없음', () => {
      expect(normalizeSlangInput('ㅋ', 'ko')).toBe('ㅋ');
      expect(normalizeSlangInput('ㅋㅋ', 'ko')).toBe('ㅋㅋ');
      expect(normalizeSlangInput('ㅋㅋㅋ', 'ko')).toBe('ㅋㅋㅋ');
    });

    it('문장 중간에 포함된 긴 ㅋ 도 capped — 주변 텍스트 보존', () => {
      const input = '안녕하세요 ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ 반갑습니다';
      expect(normalizeSlangInput(input, 'ko')).toBe('안녕하세요 ㅋㅋㅋㅋ 반갑습니다');
    });

    it('한 문장에 여러 segment 가 있어도 각각 capped', () => {
      const input = 'ㅋㅋㅋㅋㅋㅋㅋ 그리고 ㅋㅋㅋㅋㅋㅋㅋㅋ';
      expect(normalizeSlangInput(input, 'ko')).toBe('ㅋㅋㅋㅋ 그리고 ㅋㅋㅋㅋ');
    });
  });

  describe('Korean ㅎ / ㅠ / ㅜ', () => {
    it('ㅎ ×4 이상 → ×3', () => {
      expect(normalizeSlangInput('ㅎㅎㅎㅎ', 'ko')).toBe('ㅎㅎㅎ');
      expect(normalizeSlangInput('ㅎ'.repeat(20), 'ko')).toBe('ㅎㅎㅎ');
    });

    it('ㅠ ×3 이상 → ×2', () => {
      expect(normalizeSlangInput('ㅠㅠㅠ', 'ko')).toBe('ㅠㅠ');
      expect(normalizeSlangInput('ㅠ'.repeat(15), 'ko')).toBe('ㅠㅠ');
    });

    it('ㅜ ×3 이상 → ×2', () => {
      expect(normalizeSlangInput('ㅜㅜㅜ', 'ko')).toBe('ㅜㅜ');
      expect(normalizeSlangInput('ㅜ'.repeat(15), 'ko')).toBe('ㅜㅜ');
    });
  });

  describe('Japanese rules', () => {
    it("w ×4 이상 → www (lang='ja')", () => {
      expect(normalizeSlangInput('そうだねwwww', 'ja')).toBe('そうだねwww');
      expect(normalizeSlangInput('w'.repeat(20), 'ja')).toBe('www');
    });

    it("草 ×2 이상 → 草 (lang='ja')", () => {
      expect(normalizeSlangInput('草草草草', 'ja')).toBe('草');
    });

    it("ko 발신자 인풋에는 일본어 규칙 적용 안 됨 (lang='ko')", () => {
      // ko 발신자가 'wwwwww' 입력해도 lang='ko' 면 일본어 규칙 비적용 (의도된 동작).
      expect(normalizeSlangInput('wwwwww', 'ko')).toBe('wwwwww');
    });
  });

  describe('Thai rules', () => {
    it("5 ×4 이상 → 555 (lang='th')", () => {
      expect(normalizeSlangInput('5555', 'th')).toBe('555');
      expect(normalizeSlangInput('5'.repeat(20), 'th')).toBe('555');
    });

    it("ko 발신자 인풋의 555 는 보존 (lang='ko')", () => {
      // ko 입력의 555 는 숫자(전화번호 등)일 수 있어 정규화하지 않음.
      expect(normalizeSlangInput('5555', 'ko')).toBe('5555');
    });
  });

  describe('Superset mode (lang=null/undefined)', () => {
    it('lang 미전달 시 모든 언어 규칙 적용', () => {
      expect(normalizeSlangInput('ㅋ'.repeat(20))).toBe('ㅋㅋㅋㅋ');
      expect(normalizeSlangInput('w'.repeat(10))).toBe('www');
      expect(normalizeSlangInput('5'.repeat(10))).toBe('555');
    });

    it('lang=null 도 superset 모드', () => {
      expect(normalizeSlangInput('ㅋ'.repeat(20), null)).toBe('ㅋㅋㅋㅋ');
    });

    it('한 문자열에 ko+ja 슬랭이 섞여있어도 superset 모드면 양쪽 정규화', () => {
      expect(normalizeSlangInput('ㅋㅋㅋㅋㅋㅋ wwwww 草草草')).toBe('ㅋㅋㅋㅋ www 草');
    });
  });

  describe("'en' / 'hi' 등 비활성 언어", () => {
    it("lang='en' 면 어떤 규칙도 적용 안 함", () => {
      expect(normalizeSlangInput('ㅋ'.repeat(20), 'en')).toBe('ㅋ'.repeat(20));
      expect(normalizeSlangInput('wwwww', 'en')).toBe('wwwww');
    });

    it("lang='hi' 도 비활성", () => {
      expect(normalizeSlangInput('ㅋ'.repeat(20), 'hi')).toBe('ㅋ'.repeat(20));
    });
  });

  describe('Edge cases', () => {
    it('빈 문자열', () => {
      expect(normalizeSlangInput('', 'ko')).toBe('');
    });

    it('null/undefined 안전', () => {
      // TypeScript 회피 — 외부에서 잘못된 값이 와도 throw 하지 않음.
      expect(normalizeSlangInput(undefined as unknown as string, 'ko')).toBe(undefined);
      expect(normalizeSlangInput(null as unknown as string, 'ko')).toBe(null);
    });

    it('정규화 대상 없는 정상 문장은 원본 유지', () => {
      const text = '안녕하세요, 오늘 저녁 같이 드실래요?';
      expect(normalizeSlangInput(text, 'ko')).toBe(text);
    });

    it('이모지/제어문자 영향 없음', () => {
      const text = '오늘 너무 좋았어요 🎉 ㅋㅋㅋㅋㅋㅋㅋㅋ';
      expect(normalizeSlangInput(text, 'ko')).toBe('오늘 너무 좋았어요 🎉 ㅋㅋㅋㅋ');
    });

    it('양방향 재사용 — ja 발신자가 ko 슬랭을 보낸 경우 lang=ja 면 미적용', () => {
      // 양방향 적용은 호출부의 lang 인자에 위임. ja 인풋 안에 ko 자모가 섞여도
      // lang='ja' 면 한국어 규칙은 적용 안 됨 (의도된 분리).
      expect(normalizeSlangInput('やばいㅋㅋㅋㅋㅋㅋㅋ', 'ja')).toBe('やばいㅋㅋㅋㅋㅋㅋㅋ');
    });
  });
});
