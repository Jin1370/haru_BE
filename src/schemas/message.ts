import { z } from 'zod';

export const emotionSchema = z.enum([
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'excited',
  'whispering',
  'laughing',
]);

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  emotion: emotionSchema.optional(),
  // idempotent-send: 클라이언트 생성 멱등 키. 제공 시 messages.id 로 사용,
  // 미제공 시 서버 randomUUID() 폴백 (옛 FE 하위호환). uuid 형식 검증으로
  // 임의 문자열 PK 주입/injection 표면 차단. wire-only 필드 — messages.id 컬럼에
  // 매핑되며 별도 컬럼으로 저장하지 않는다.
  client_message_id: z.string().uuid().optional(),
  // message-reply: 답장 대상 메시지 id. 같은 매치의 메시지여야 하며 라우트가
  // 검증한다 (다른 매치 id 를 넣어 GET 응답의 인용으로 남의 대화 본문을
  // 끌어오는 경로 차단).
  reply_to_id: z.string().uuid().optional(),
});

export const messageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // Supabase TIMESTAMPTZ serialises as `...+00:00`, not `...Z`. zod's
  // `.datetime()` defaults reject timezone offsets, so the FE round-tripping
  // its own `messages[].created_at` back as the `before` cursor would 400
  // here — silently looping `loadOlder` because the catch resets the ref.
  // `{ offset: true }` accepts both `+00:00` and `Z` forms.
  before: z.string().datetime({ offset: true }).optional(),
  // message-reply(점프): 아래로(더 최신) 넘기는 커서. before 의 거울.
  after: z.string().datetime({ offset: true }).optional(),
  // message-reply(점프): 이 메시지를 가운데 둔 구간을 한 번에. 인용 원본이
  // 로드 범위 밖일 때 "나올 때까지 50개씩 계속 요청" 루프를 한 번으로 줄인다.
  around: z.string().uuid().optional(),
});

// message-reactions: 리액션 슬러그. mig 054 의 CHECK 제약과 정확히 같은 5개.
// 표시 이모지는 FE `constants/messageReactions.ts` 가 소유한다 (글리프 교체 시
// 마이그레이션 불필요). 값 추가/변경 시 mig + 이 배열 + FE 상수 3곳 동시 갱신.
export const messageReactionValues = [
  'heart',
  'thumbsup',
  'laugh',
  'wow',
  'sad',
] as const;

export const messageReactionSchema = z.object({
  // null = 리액션 해제. 같은 값 재선택은 FE 가 토글로 null 로 바꿔 보낸다.
  reaction: z.enum(messageReactionValues).nullable(),
});

export type MessageReaction = (typeof messageReactionValues)[number];
