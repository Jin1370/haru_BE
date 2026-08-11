// mig 052 — photoConversion 의 거부 사유 분류 단위 회귀.
//
// 배경: 옛 폴백이 'sexual' 이라, 우리가 키워드로 못 잡는 거부 유형(대표적으로
// 저작권 캐릭터 likeness)이 전부 성적 콘텐츠 차단으로 audit 에 기록됐다.
// 실제 오분류 사례가 나와(스파이더맨 사진) 폴백을 'other' 로 바꿨다.
//
// 본 파일은 detectModerationRejection 순수 함수만 검증 — OpenAI/Azure 라이브
// 호출도, Supabase 접촉도 없음.

import { describe, it, expect, vi } from 'vitest';

// jimp / openai 는 import 부작용만 회피하면 되므로 최소 스텁.
vi.mock('openai', () => ({
  default: class MockOpenAI {},
  toFile: vi.fn(),
}));

import { detectModerationRejection } from '../src/services/photoConversion';

// Azure/OpenAI 가 실제로 던지는 에러 shape (SDK APIError).
const azureFilterError = (message: string) => ({
  status: 400,
  code: 'content_filter',
  message,
});

describe('detectModerationRejection', () => {
  it('키워드 미매칭 거부는 sexual 이 아니라 other 로 분류한다 (mig 052 핵심)', () => {
    // 저작권 캐릭터 거부 — minor/self-harm/drug/sexual 어느 키워드도 없다.
    const r = detectModerationRejection(
      azureFilterError(
        'Your request was rejected by the content management policy. ' +
          'The image appears to depict a copyrighted character.',
      ),
    );
    expect(r.rejected).toBe(true);
    expect(r.category).toBe('other');
  });

  it('sexual 키워드가 실제로 있으면 sexual 로 분류한다', () => {
    const r = detectModerationRejection(
      azureFilterError('Blocked by content management policy: sexual content detected.'),
    );
    expect(r.category).toBe('sexual');
  });

  it('minor / self_harm / drug 키워드 매칭은 회귀 없이 유지된다', () => {
    expect(
      detectModerationRejection(azureFilterError('content policy: possible minor depicted'))
        .category,
    ).toBe('minor');
    expect(
      detectModerationRejection(azureFilterError('content policy: self-harm imagery')).category,
    ).toBe('self_harm');
    expect(
      detectModerationRejection(azureFilterError('content policy: illicit drug use')).category,
    ).toBe('drug');
  });

  it('모더레이션이 아닌 에러(타임아웃/5xx)는 rejected=false — retry 대상으로 남는다', () => {
    expect(detectModerationRejection({ status: 500, message: 'internal error' }).rejected).toBe(
      false,
    );
    expect(detectModerationRejection(new Error('fetch failed')).rejected).toBe(false);
  });

  it('제공자 원문을 rawMessage 로 보존한다 (원본 사진은 거부 즉시 폐기되므로 유일한 증거)', () => {
    const message = 'Your request was rejected by the content management policy.';
    expect(detectModerationRejection(azureFilterError(message)).rawMessage).toBe(message);
  });
});
