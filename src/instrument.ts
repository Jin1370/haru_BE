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
    // 성능 트레이스 비활성 (0). 무료 플랜 스팬 쿼터 보호 + 현재 트레이싱 데이터 미사용.
    // 앱 속도/병목 분석이 필요해지면 0.05~0.2 로 올린다.
    tracesSampleRate: 0,
    // "외부 의존성 실패 시 console.error 가시화" 컨벤션(CLAUDE.md)을 그대로 Sentry
    // 이벤트로 승격 — catch 마다 captureException 을 심는 대신 로그 한 곳만 계측.
    // warn 은 운영 신호(모더레이션 등)라 제외, error 만.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    // 클라이언트 연결 끊김(multer upload abort)은 서버 버그가 아니라 정상 클라이언트 동작.
    ignoreErrors: ['Request aborted'],
  });
}
