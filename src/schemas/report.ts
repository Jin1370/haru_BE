import { z } from 'zod';

export const reportSchema = z.object({
  reported_id: z.string().uuid(),
  reason: z.enum([
    'spam',
    'inappropriate',
    'fake_profile',
    'harassment',
    'underage',
    'voice_impersonation',
    'other',
  ]),
  description: z.string().max(500).optional(),
});
