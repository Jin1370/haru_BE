import { z } from 'zod';
import { CARD_RESET_AMOUNT } from '../constants/stars';

export const swipeBodySchema = z.object({
  swiped_id: z.string().uuid(),
  direction: z.enum(['like', 'pass']),
  // 별사탕 유료화 (mig 059). 미전달 = 탐색 탭 (옛 FE 호환).
  // 'likes' 는 받은 좋아요 탭 — 서버가 (상대가 나를 like) AND (공개함 OR 무료 카드)
  // 를 확인한 뒤에만 카드·좋아요 차감을 면제한다.
  source: z.enum(['discover', 'likes']).optional().default('discover'),
  // 받은 좋아요 탭에서 이 카드를 넘긴 직후 화면에 나올 잠긴 카드. 서버가 맨 앞 카드로
  // 고정한다. 나를 like 한 미공개 후보가 아니면 GET /likes-received 가 무시한다.
  next_card_id: z.string().uuid().optional(),
  // 좋아요 한도 소진 후 사용자가 "별사탕 1개 사용" 을 확인했을 때만 true.
  // 한도 안이면 무시된다 (차감 안 함).
  pay_with_stars: z.boolean().optional().default(false),
});

export const cardResetBodySchema = z.object({
  cards: z.number().int().min(1).max(CARD_RESET_AMOUNT),
});

export const revealBodySchema = z.object({
  liker_id: z.string().uuid(),
});

// POST /swipe 의 서버측 하드 캡 계산용 tz. quotaQuerySchema 와 동일 의미
// (UTC - local, 분). 미전달 시 0(UTC) 폴백 — 구버전 클라이언트 호환.
export const swipeQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840).optional().default(0),
});

export const discoverQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  // 카드 한도(로컬 자정 리셋) 계산용. 미전달 시 UTC — 옛 FE 는 유료화 OFF 에서만 쓰인다.
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840).optional().default(0),
});

// FE 의 Date#getTimezoneOffset() 와 동일 의미: UTC - local, 분 단위.
// 예) KST(+09:00) 는 -540, JST(+09:00) 는 -540, UTC 는 0, PST(-08:00) 는 480.
// 유효 범위는 IANA 의 max abs 14h 보다 살짝 여유있게 잡는다.
export const quotaQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840),
});
