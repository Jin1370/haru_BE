import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { validateBody } from '../middleware/validate';
import { waitlistSchema } from '../schemas/waitlist';

// 랜딩페이지(haru_FE/web) 출시 대기자 모집 폼 수집. 인증 불필요 — 가입 전 방문자가
// 메일 주소 + 기종을 남긴다. service_role 로 waitlist (RLS service_role 전용)
// 에 upsert. 같은 메일 재제출은 onConflict 로 흡수해 폭주 방지.
const router = Router();

router.post('/', validateBody(waitlistSchema), async (req: Request, res: Response) => {
  const { email, device_model, locale } = req.body as {
    email: string;
    device_model: string;
    locale?: string;
  };

  const { error } = await supabase
    .from('waitlist')
    .upsert(
      { email, device_model, locale: locale ?? null },
      { onConflict: 'email' },
    );

  if (error) {
    // 외부 의존성 호출 error 가시화 룰 (silent-success 금지).
    console.error('[waitlist] insert failed:', error);
    res.status(500).json({ error: 'signup_failed' });
    return;
  }

  res.status(201).json({ ok: true });
});

export default router;
