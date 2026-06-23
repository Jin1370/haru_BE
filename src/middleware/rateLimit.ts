import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';

// IP 기준 빈도 제한. req.ip 는 index.ts 의 `trust proxy` 설정에 따라 Fly 프록시
// 뒤에서도 실제 클라이언트 IP 로 해석된다 (그 설정이 없으면 모든 사용자가 프록시
// IP 하나로 묶여 무의미해진다).
//
// 테스트(NODE_ENV=test)에선 skip — supertest 가 같은 IP 로 다수 요청을 보내
// 한도에 걸려 flaky 해지는 것을 방지.
const skipInTest = () => env.nodeEnv === 'test';

function jsonRateLimitHandler(_req: Request, res: Response): void {
  res.status(429).json({ error: 'rate_limited' });
}

// authLimiter 는 /refresh 를 제외한다. 이유:
//   (1) /refresh 는 이미 유효한 refresh token 을 요구하므로 credential stuffing
//       (비번 추측) 의 표면이 아니다 — 보호 대상은 /login·/signup·/otp·/google·
//       /apple (계정/비번 추측) 뿐.
//   (2) 앱이 access token 만료 시 /refresh 를 자동 호출하는데, 여기에 429 가
//       떨어지면 FE(services/api.ts refreshAccessToken)가 비-2xx 를 세션 만료로
//       간주해 clearTokens → onSessionExpired → 강제 로그아웃한다. CGNAT 공유 IP
//       에서 정상 사용자가 조용히 튕기는(그리고 재로그인도 같은 한도에 걸리는)
//       회귀를 차단. mount 가 '/api/auth' 라 미들웨어가 보는 req.path 는 '/refresh'.
const skipAuth = (req: Request) => env.nodeEnv === 'test' || req.path === '/refresh';

// 로그인/가입/OTP/소셜 — credential stuffing (다른 사이트에서 유출된 이메일·비번
// 목록을 봇으로 대량 자동 시도) 차단. 공격은 분당 수백~수천 시도라 넉넉한 한도로도
// 충분히 막히며, 정상 사용자(가끔 로그인)는 걸리지 않는다.
export const authLimiter = rateLimit({
  windowMs: env.rateLimit.authWindowMin * 60_000,
  limit: env.rateLimit.authMax,
  standardHeaders: true, // RateLimit-* 표준 헤더 노출
  legacyHeaders: false, // 구형 X-RateLimit-* 헤더 비활성
  handler: jsonRateLimitHandler,
  skip: skipAuth,
});

// 대기자 폼 — 무작위 이메일을 자동 생성해 무한 제출하면 waitlist 테이블에 쓰레기
// 행이 끝없이 쌓인다 (이메일이 매번 달라 UNIQUE 중복 방지도 안 걸림). 정상 방문자는
// 한 번만 제출하므로 시간당 소수로 제한해도 무해.
export const waitlistLimiter = rateLimit({
  windowMs: env.rateLimit.waitlistWindowMin * 60_000,
  limit: env.rateLimit.waitlistMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
  skip: skipInTest,
});
