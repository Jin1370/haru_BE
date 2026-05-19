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
