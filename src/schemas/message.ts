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
});

export const messageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // Supabase TIMESTAMPTZ serialises as `...+00:00`, not `...Z`. zod's
  // `.datetime()` defaults reject timezone offsets, so the FE round-tripping
  // its own `messages[].created_at` back as the `before` cursor would 400
  // here — silently looping `loadOlder` because the catch resets the ref.
  // `{ offset: true }` accepts both `+00:00` and `Z` forms.
  before: z.string().datetime({ offset: true }).optional(),
});
