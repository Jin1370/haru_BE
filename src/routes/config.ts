import { Router, Request, Response } from 'express';
import { env } from '../config/env';

// 강제 업데이트 게이트 (최소판). 인증 불필요 — 앱이 부팅 시 가장 먼저 호출한다.
// FE 가 자기 앱 버전과 min_version 을 로컬에서 비교해, 미만이면 차단 화면을 띄우고
// 스토어로 보낸다. BE 는 값만 내려주는 dumb config provider (비교 로직 없음).
// 값 출처는 env (마이그/DB 없음) — 자세한 운영 의도는 config/env.ts appConfig 주석.
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    min_version: env.appConfig.minVersion,
    ios_store_url: env.appConfig.iosStoreUrl,
    android_store_url: env.appConfig.androidStoreUrl,
  });
});

export default router;
