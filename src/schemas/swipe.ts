import { z } from 'zod';

export const swipeBodySchema = z.object({
  swiped_id: z.string().uuid(),
  direction: z.enum(['like', 'pass']),
});

// POST /swipe 의 서버측 하드 캡 계산용 tz. quotaQuerySchema 와 동일 의미
// (UTC - local, 분). 미전달 시 0(UTC) 폴백 — 구버전 클라이언트 호환.
export const swipeQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840).optional().default(0),
});

export const discoverQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

// FE 의 Date#getTimezoneOffset() 와 동일 의미: UTC - local, 분 단위.
// 예) KST(+09:00) 는 -540, JST(+09:00) 는 -540, UTC 는 0, PST(-08:00) 는 480.
// 유효 범위는 IANA 의 max abs 14h 보다 살짝 여유있게 잡는다.
export const quotaQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840),
});
