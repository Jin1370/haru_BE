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

// 로그인/가입/토큰갱신 — credential stuffing (다른 사이트에서 유출된 이메일·비번
// 목록을 봇으로 대량 자동 시도) 차단. 공격은 분당 수백~수천 시도라 넉넉한 한도로도
// 충분히 막히며, 정상 사용자(가끔 로그인 + 주기적 토큰 갱신)는 걸리지 않는다.
export const authLimiter = rateLimit({
  windowMs: env.rateLimit.authWindowMin * 60_000,
  limit: env.rateLimit.authMax,
  standardHeaders: true, // RateLimit-* 표준 헤더 노출
  legacyHeaders: false, // 구형 X-RateLimit-* 헤더 비활성
  handler: jsonRateLimitHandler,
  skip: skipInTest,
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
