// message-moderation-v1 follow-up (B 안, 2026-05-18) — OpenAI Moderation unit 회귀.
//
// 통합(supertest) 테스트는 OpenAI 라이브 호출 비용 + flakiness 회피 위해 후속 카드.
// 본 파일은 services/openaiModeration.ts 의 OpenAI SDK 응답 → 카테고리 매핑 로직
// 단위 검증만.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// openai SDK 모킹 — moderations.create 응답을 per-test 제어.
const moderationsCreate = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    moderations = { create: moderationsCreate };
  },
}));

// env.openai.moderationApiKey 가 truthy 여야 client 가 생성됨.
// env.ts 는 process.env 를 startup 1회 평가 — test 시작 전 설정.
process.env.OPENAI_API_KEY = 'test-key-placeholder';

// services/openaiModeration.ts 동적 import (env 평가 후).
let checkOpenAiModeration: typeof import('../src/services/openaiModeration').checkOpenAiModeration;
beforeEach(async () => {
  moderationsCreate.mockReset();
  vi.resetModules();
  ({ checkOpenAiModeration } = await import('../src/services/openaiModeration'));
});

describe('checkOpenAiModeration — 카테고리 매핑', () => {
  it('sexual/minors 위반 → minor 카테고리 차단', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { 'sexual/minors': true, sexual: true } }],
    });
    const r = await checkOpenAiModeration('high school student wants to meet');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('minor'); // 우선순위 매핑상 minor 먼저
    expect(r.rawCategory).toBe('sexual/minors');
  });

  it('self-harm/instructions 위반 → self_harm 카테고리 차단', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { 'self-harm/instructions': true } }],
    });
    const r = await checkOpenAiModeration('here is how to ...');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('self_harm');
  });

  it('illicit 위반 → drug 카테고리 차단', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { illicit: true } }],
    });
    const r = await checkOpenAiModeration('where can i buy ㅁㅏㅇㅑㄱ');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('drug');
    expect(r.rawCategory).toBe('illicit');
  });

  it('sexual 위반 → sexual 카테고리 차단', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { sexual: true } }],
    });
    const r = await checkOpenAiModeration('explicit content');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('sexual');
  });

  it('harassment / hate / violence — 의도적 미차단 (1차 출시 제외 카테고리)', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { harassment: true, hate: true, violence: true } }],
    });
    const r = await checkOpenAiModeration('You are stupid');
    expect(r.blocked).toBe(false);
  });

  it('1인칭 위기 신호 (self-harm only, not /instructions) → 통과 (helpline 분기 후속 카드)', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { 'self-harm': true, 'self-harm/intent': true } }],
    });
    const r = await checkOpenAiModeration('i want to die');
    expect(r.blocked).toBe(false);
  });

  it('정상 메시지 → 통과', async () => {
    moderationsCreate.mockResolvedValue({
      results: [{ categories: { sexual: false, illicit: false } }],
    });
    const r = await checkOpenAiModeration('Nice to meet you!');
    expect(r.blocked).toBe(false);
  });

  it('OpenAI 에러 → fail-open (사전 차단 layer 가 1차 방어선)', async () => {
    moderationsCreate.mockRejectedValue(new Error('rate limit exceeded'));
    const r = await checkOpenAiModeration('any text');
    expect(r.blocked).toBe(false);
  });

  it('응답 비정상 (results 없음) → fail-open', async () => {
    moderationsCreate.mockResolvedValue({ results: [] });
    const r = await checkOpenAiModeration('any text');
    expect(r.blocked).toBe(false);
  });
});

describe('checkOpenAiModeration — fail-open: API key 미설정', () => {
  it('OPENAI_API_KEY 미설정 → 즉시 통과 (SDK 호출 X)', async () => {
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const { checkOpenAiModeration: fn } = await import('../src/services/openaiModeration');
    const r = await fn('any text including 마약');
    expect(r.blocked).toBe(false);
    expect(moderationsCreate).not.toHaveBeenCalled();
  });
});
