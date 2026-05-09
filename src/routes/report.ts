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

  // 자동 매치 해제 + actor 의 hidden_by 자동 append.
  // 신고 직후 본인 시야에서 매치가 즉시 사라지도록 hidden_by 에 자기
  // user_id 추가 (mig 013). 상대방 화면에는 tombstone 으로 남는다.
  // 자세한 동작 근거는 block.ts 동일 블록 주석 참고.
  const [id1, id2] = [req.userId!, reported_id].sort();
  const { data: match } = await supabase
    .from('matches')
    .select('id, hidden_by, unmatched_at')
    .eq('user1_id', id1)
    .eq('user2_id', id2)
    .maybeSingle();

  if (match) {
    const currentHidden = (match.hidden_by as string[] | null) ?? [];
    const nextHidden = currentHidden.includes(req.userId!)
      ? currentHidden
      : [...currentHidden, req.userId!];

    const updates: Record<string, unknown> = { hidden_by: nextHidden };
    if (!match.unmatched_at) {
      updates.unmatched_at = new Date().toISOString();
      updates.unmatched_by = req.userId!;
    }

    await supabase.from('matches').update(updates).eq('id', match.id);
  }

  res.status(201).json({ status: 'reported' });
});

export default router;
