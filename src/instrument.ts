import * as Sentry from '@sentry/node';

// 반드시 index.ts 의 "맨 첫 import" 로 불러올 것 — 다른 모듈이 로드되기 전에
// Sentry 가 먼저 init 되어야 자동 계측(HTTP/Express)이 정상 동작한다.
//
// NODE_ENV=test 는 스킵 (vitest 실행 중 외부 전송 방지).
// SENTRY_DSN 미설정이면 조용히 비활성 (로컬에서 DSN 없이 돌려도 무해).
if (process.env.NODE_ENV !== 'test' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // 환경분리 도입 시 SENTRY_ENVIRONMENT 만 dev/stage/prod 로 다르게 주면 됨.
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // 성능 트레이스 샘플링 — 출시 초기엔 낮게. 필요 시 상향.
    tracesSampleRate: 0.2,
  });
}
