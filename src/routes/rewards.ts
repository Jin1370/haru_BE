import { Router, Request, Response } from 'express';
import { createVerify } from 'crypto';
import { env } from '../config/env';
import { grantStars } from '../services/stars';
import { adStarsRemainingToday } from './swipe';
import { AD_REWARD_STARS, STAR_PRODUCTS } from '../constants/stars';

// 별사탕 충전 입구 (mig 059). 둘 다 외부 서버가 호출하므로 authMiddleware 없음 —
// 각자의 서명/비밀값으로 검증한다. 앱이 "결제/시청 완료" 라고 알려주는 경로는 없다
// (조작된 클라이언트가 공짜 별사탕을 받는 우회 차단).

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── AdMob 보상형 광고 서버측 검증 (SSV) ─────────────────────────────
// https://developers.google.com/admob/android/ssv
// 구글이 GET 으로 호출. 서명 대상은 쿼리스트링 중 "&signature=" 앞부분 그대로.
// user_id 는 앱이 광고 로드 시 ServerSideVerificationOptions 로 넣은 우리 userId.
const ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const KEY_CACHE_MS = 24 * 60 * 60 * 1000;
let keyCache: { at: number; keys: Map<string, string> } | null = null;

async function getAdmobKeys(force = false): Promise<Map<string, string>> {
  if (!force && keyCache && Date.now() - keyCache.at < KEY_CACHE_MS) return keyCache.keys;
  const res = await fetch(ADMOB_KEYS_URL);
  if (!res.ok) throw new Error(`admob keys ${res.status}`);
  const body = (await res.json()) as { keys: Array<{ keyId: number; pem: string }> };
  const keys = new Map(body.keys.map((k) => [String(k.keyId), k.pem]));
  keyCache = { at: Date.now(), keys };
  return keys;
}

export function verifyAdmobSignature(rawQuery: string, pem: string): boolean {
  const sigIdx = rawQuery.indexOf('&signature=');
  if (sigIdx === -1) return false;
  const message = rawQuery.slice(0, sigIdx);
  const signature = new URLSearchParams(rawQuery.slice(sigIdx + 1)).get('signature');
  if (!signature) return false;
  const verifier = createVerify('sha256');
  verifier.update(message);
  return verifier.verify(pem, Buffer.from(signature, 'base64url'));
}

router.get('/admob', async (req: Request, res: Response) => {
  const rawQuery = req.originalUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(rawQuery);
  const keyId = params.get('key_id');
  if (!keyId) {
    res.status(400).json({ error: 'missing key_id' });
    return;
  }

  let pem = (await getAdmobKeys()).get(keyId);
  // 구글이 키를 교체한 직후 — 캐시를 한 번 새로 받는다.
  if (!pem) pem = (await getAdmobKeys(true)).get(keyId);
  if (!pem || !verifyAdmobSignature(rawQuery, pem)) {
    console.warn('[rewards.admob] signature rejected', { keyId });
    res.status(400).json({ error: 'invalid signature' });
    return;
  }

  const userId = params.get('user_id') ?? '';
  const transactionId = params.get('transaction_id');
  // AdMob 콘솔의 "확인 URL" 테스트는 user_id 없이 온다 — 서명만 통과하면 200.
  if (!UUID_RE.test(userId) || !transactionId) {
    res.json({ ok: true, granted: false });
    return;
  }

  // ponytail: 한도 확인→지급이 원자적이지 않아 동시 콜백 2개가 한도를 1 넘길 수 있다.
  // 하루 광고 2회 한도라 허용.
  if ((await adStarsRemainingToday(userId)) <= 0) {
    res.json({ ok: true, granted: false, reason: 'daily_limit' });
    return;
  }
  const granted = await grantStars(userId, AD_REWARD_STARS, false, 'ad', transactionId);
  res.json({ ok: true, granted });
});

// ── RevenueCat 웹훅 (스토어 구매) ─────────────────────────────────
// 대시보드 → Webhooks 에 이 URL + Authorization 헤더 값(REVENUECAT_WEBHOOK_AUTH) 등록.
// 소모성 상품 구매는 NON_RENEWING_PURCHASE 이벤트. app_user_id 는 앱이
// Purchases.logIn(userId) 로 맞춘 우리 userId. 같은 거래가 재전송돼도
// (kind='purchase', ref=transaction_id) 유니크로 한 번만 지급.
router.post('/revenuecat', async (req: Request, res: Response) => {
  const auth = env.monetization.revenuecatWebhookAuth;
  if (!auth || req.headers.authorization !== auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const event = req.body?.event ?? {};
  if (event.type !== 'NON_RENEWING_PURCHASE') {
    res.json({ ok: true, ignored: event.type ?? null });
    return;
  }

  const amount = STAR_PRODUCTS[event.product_id as string];
  const userId = String(event.app_user_id ?? '');
  const transactionId = event.transaction_id as string | undefined;
  if (!amount || !UUID_RE.test(userId) || !transactionId) {
    // 200 으로 받아야 RevenueCat 이 무한 재시도하지 않는다. 대신 크게 남긴다.
    console.error('[rewards.revenuecat] unhandled purchase', {
      product: event.product_id,
      user: userId,
      tx: transactionId,
    });
    res.json({ ok: true, granted: false });
    return;
  }

  // ponytail: 환불(CANCELLATION)은 별사탕을 회수하지 않는다. 규모가 커지면 추가.
  const granted = await grantStars(userId, amount, true, 'purchase', transactionId);
  if (event.environment === 'SANDBOX') console.log('[rewards.revenuecat] sandbox purchase', { userId, amount });
  res.json({ ok: true, granted });
});

export default router;
