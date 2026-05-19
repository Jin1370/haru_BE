import { z } from 'zod';

export const registerTokenSchema = z.object({
  expo_push_token: z
    .string()
    .startsWith('ExponentPushToken[')
    .max(200),
  platform: z.enum(['ios', 'android']),
});

export const unregisterTokenSchema = z.object({
  expo_push_token: z.string().startsWith('ExponentPushToken[').max(200),
});

export const updatePreferencesSchema = z
  .object({
    notify_messages: z.boolean().optional(),
    notify_matches: z.boolean().optional(),
  })
  .refine(
    (v) => v.notify_messages !== undefined || v.notify_matches !== undefined,
    { message: 'At least one field is required' },
  );
