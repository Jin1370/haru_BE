import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import {
  registerTokenSchema,
  unregisterTokenSchema,
  updatePreferencesSchema,
} from '../schemas/notifications';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

// Expo Push Token 등록 (upsert by expo_push_token).
// 같은 토큰이 다른 user_id 에 묶여 있으면(기기 재로그인) onConflict 로 자동 transfer.
router.post('/token', validateBody(registerTokenSchema), async (req: AuthRequest, res: Response) => {
  const { expo_push_token, platform } = req.body as {
    expo_push_token: string;
    platform: 'ios' | 'android';
  };

  const { data, error } = await supabase
    .from('device_tokens')
    .upsert(
      {
        user_id: req.userId!,
        expo_push_token,
        platform,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'expo_push_token' },
    )
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

// 토큰 해제 (로그아웃 시). 본인 소유 토큰만 삭제 가능.
router.delete('/token', validateBody(unregisterTokenSchema), async (req: AuthRequest, res: Response) => {
  const { expo_push_token } = req.body as { expo_push_token: string };

  const { error } = await supabase
    .from('device_tokens')
    .delete()
    .eq('expo_push_token', expo_push_token)
    .eq('user_id', req.userId!);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(204).send();
});

// 옵트아웃 상태 조회. user_preferences 행이 없으면 default true 반환.
router.get('/preferences', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('user_preferences')
    .select('notify_messages, notify_matches')
    .eq('user_id', req.userId!)
    .maybeSingle();

  res.json({
    notify_messages: data?.notify_messages ?? true,
    notify_matches: data?.notify_matches ?? true,
  });
});

// 옵트아웃 토글 업데이트. user_preferences 행이 없으면 생성.
router.patch('/preferences', validateBody(updatePreferencesSchema), async (req: AuthRequest, res: Response) => {
  const patch = req.body as {
    notify_messages?: boolean;
    notify_matches?: boolean;
  };

  const { data, error } = await supabase
    .from('user_preferences')
    .upsert(
      {
        user_id: req.userId!,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('notify_messages, notify_matches')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    notify_messages: data.notify_messages ?? true,
    notify_matches: data.notify_matches ?? true,
  });
});

export default router;
