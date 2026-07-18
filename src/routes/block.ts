import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { blockSchema } from '../schemas/block';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

// 차단
router.post('/', validateBody(blockSchema), async (req: AuthRequest, res: Response) => {
  const { blocked_id } = req.body;

  if (blocked_id === req.userId) {
    res.status(400).json({ error: 'Cannot block yourself' });
    return;
  }

  const { error } = await supabase.from('blocks').insert({
    blocker_id: req.userId!,
    blocked_id,
  });

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Already blocked' });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }

  await softDeleteAndHideMatch(req.userId!, blocked_id);

  res.status(201).json({ status: 'blocked' });
});

// 차단/신고 시 기존 매치 soft delete + actor 의 hidden_by 자동 append (report.ts 공용).
// hidden_by 에 자기 user_id 가 들어가면 GET /api/matches 의
// `.not('hidden_by', 'cs', '{viewerId}')` 필터로 본인 시야에서만
// 즉시 사라진다 (mig 013). 상대방은 tombstone 으로 그대로 보유.
//
// 이미 언매치된 매치(상대가 먼저 차단/신고했던 케이스)에 대해서도
// hidden_by 만은 추가해야 하므로 unmatched_at 필터 없이 매치 행을
// 먼저 select 한 뒤 read-modify-write 한다.
export async function softDeleteAndHideMatch(actorId: string, otherId: string): Promise<void> {
  const [id1, id2] = [actorId, otherId].sort();
  const { data: match } = await supabase
    .from('matches')
    .select('id, hidden_by, unmatched_at')
    .eq('user1_id', id1)
    .eq('user2_id', id2)
    .maybeSingle();

  if (!match) return;

  const currentHidden = (match.hidden_by as string[] | null) ?? [];
  const nextHidden = currentHidden.includes(actorId)
    ? currentHidden
    : [...currentHidden, actorId];

  const updates: Record<string, unknown> = { hidden_by: nextHidden };
  if (!match.unmatched_at) {
    updates.unmatched_at = new Date().toISOString();
    updates.unmatched_by = actorId;
  }

  await supabase.from('matches').update(updates).eq('id', match.id);
}

// 차단 해제
router.delete('/:blockedId', async (req: AuthRequest, res: Response) => {
  const { blockedId } = req.params;

  const { error, count } = await supabase
    .from('blocks')
    .delete({ count: 'exact' })
    .eq('blocker_id', req.userId!)
    .eq('blocked_id', blockedId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (count === 0) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }

  res.json({ status: 'unblocked' });
});

// 차단 목록
router.get('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('blocks')
    .select('blocked_id, created_at, profile:profiles!blocked_id(id, display_name)')
    .eq('blocker_id', req.userId!)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // mig 034: profiles.photos 컬럼 폐지. 차단 상대 썸네일은 profile_photos 의 메인
  // (position=0, status='ready') converted_url 을 별도 조회해 profile.photos 배열로
  // 미러 (FE 차단 목록 shape 유지).
  const blockedIds = (data ?? []).map((row: any) => row.blocked_id as string);
  const mainPhotoByUser = new Map<string, string>();
  if (blockedIds.length > 0) {
    const { data: photoRows, error: photoErr } = await supabase
      .from('profile_photos')
      .select('user_id, converted_url, status, position')
      .in('user_id', blockedIds)
      .eq('status', 'ready')
      .eq('position', 0);
    if (photoErr) {
      console.error('[block.list.profile_photos_select_failed]', photoErr.message);
    } else {
      ((photoRows ?? []) as Array<{ user_id: string; converted_url: string | null }>).forEach((r) => {
        if (r.converted_url) mainPhotoByUser.set(r.user_id, r.converted_url);
      });
    }
  }

  const withPhotos = (data ?? []).map((row: any) => {
    const main = mainPhotoByUser.get(row.blocked_id);
    return {
      ...row,
      profile: row.profile
        ? { ...row.profile, photos: main ? [main] : [] }
        : row.profile,
    };
  });

  res.json(withPhotos);
});

export default router;
