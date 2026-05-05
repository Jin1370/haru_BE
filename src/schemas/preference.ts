import { z } from 'zod';
import { LANGUAGE_CODES, NATIONALITY_CODES } from './profile';

export const preferenceSchema = z.object({
  min_age: z.number().int().min(18).max(100).optional().default(18),
  max_age: z.number().int().min(18).max(100).optional().default(100),
  preferred_genders: z.array(z.enum(['male', 'female', 'other']))
    .optional()
    .default(['male', 'female', 'other']),
  // Whitelisted language codes. Empty = no language preference. Mig 009
  // dropped the level dimension — preference is now just "this user's
  // primary language must be one of these codes" (or any, when empty).
  preferred_languages: z.array(z.enum(LANGUAGE_CODES)).optional().default([]),
  // ISO-3166-1 alpha-2 country codes from the launch whitelist. Empty = no
  // nationality preference.
  preferred_nationalities: z.array(z.enum(NATIONALITY_CODES)).optional().default([]),
}).refine((data) => data.min_age <= data.max_age, {
  message: 'min_age must be less than or equal to max_age',
  path: ['min_age'],
});
