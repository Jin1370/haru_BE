import { z } from 'zod';

// 랜딩페이지 출시 대기자 모집 폼. 인증 불필요한 공개 라우트라 입력 검증을 빡빡하게.
// email 은 정규화(lowercase+trim)는 라우트에서, 여기선 형식+길이만.
export const waitlistSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  device_model: z.string().trim().min(1).max(120),
  locale: z.enum(['ko', 'en', 'ja']).optional(),
});
