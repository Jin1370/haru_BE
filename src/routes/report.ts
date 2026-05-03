import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { reportSchema } from '../schemas/report';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

// 신고 — 안전 우선 정책: 신고 한 번으로 자동 차단 + 매치 해제까지 함께 처리.
// 사용자가 추가 작업 없이 즉시 가해자로부터 분리되도록 한다.
router.post('/', validateBody(reportSchema), async (req: AuthRequest, res: Response) => {
  const { reported_id, reason, description } = req.body;

  if (reported_id === req.userId) {
    res.status(400).json({ error: 'Cannot report yourself' });
    return;
  }

  const { error: reportError } = await supabase.from('reports').insert({
    reporter_id: req.userId!,
    reported_id,
    reason,
    description,
  });

  if (reportError) {
    if (reportError.code === '23505') {
      res.status(409).json({ error: 'Already reported this user' });
      return;
    }
    res.status(500).json({ error: reportError.message });
    return;
  }

  // 자동 차단 — 이미 차단돼 있으면(23505) 무시.
  await supabase.from('blocks').insert({
    blocker_id: req.userId!,
    blocked_id: reported_id,
  });

  // 자동 매치 해제 — 두 사람 사이의 활성 매치가 있으면 soft delete.
  const [id1, id2] = [req.userId!, reported_id].sort();
  await supabase
    .from('matches')
    .update({ unmatched_at: new Date().toISOString(), unmatched_by: req.userId! })
    .eq('user1_id', id1)
    .eq('user2_id', id2)
    .is('unmatched_at', null);

  res.status(201).json({ status: 'reported' });
});

export default router;
