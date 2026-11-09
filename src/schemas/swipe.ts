import { z } from 'zod';
import { CARD_RESET_AMOUNT } from '../constants/stars';

export const swipeBodySchema = z.object({
  swiped_id: z.string().uuid(),
  direction: z.enum(['like', 'pass']),
  // 'likes' 는 받은 좋아요 탭 — 유료화 ON 이면 서버가 (상대가 나를 like) AND (공개함)
  // 을 확인한다.
  // 'playlist' 는 탐색 플레이리스트의 대화 신청 — 서버가 viewer 의 플레이리스트에 든
  // 상대인지 확인한다 (mig 063).
  source: z.enum(['likes', 'playlist']).optional().default('playlist'),
});

export const playlistParamsSchema = z.object({
  idx: z.coerce.number().int().min(0).max(2),
});

export const playlistOpenBodySchema = z.object({
  expected_count: z.number().int().min(1).max(CARD_RESET_AMOUNT).optional(),
});

// free = 무료 카드 (화면에 나오는 순간 공개로 기록). 없으면 별사탕 공개.
export const revealBodySchema = z.object({
  liker_id: z.string().uuid(),
  free: z.boolean().optional().default(false),
});

// 플레이리스트에서 처음 화면에 나온 카드. 자정에 본 카드만 pass 로 기록한다.
export const playlistSeenBodySchema = z.object({
  candidate_ids: z.array(z.string().uuid()).min(1).max(CARD_RESET_AMOUNT + 1),
});

// POST /swipe 의 서버측 하드 캡 계산용 tz. quotaQuerySchema 와 동일 의미
// (UTC - local, 분). 미전달 시 0(UTC) 폴백 — 구버전 클라이언트 호환.
export const swipeQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840).optional().default(0),
});

// FE 의 Date#getTimezoneOffset() 와 동일 의미: UTC - local, 분 단위.
// 예) KST(+09:00) 는 -540, JST(+09:00) 는 -540, UTC 는 0, PST(-08:00) 는 480.
// 유효 범위는 IANA 의 max abs 14h 보다 살짝 여유있게 잡는다.
export const quotaQuerySchema = z.object({
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840),
});
