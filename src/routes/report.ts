import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { reportSchema } from '../schemas/report';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

// message-moderation-v1 (PR2): 누적 신고 자동 freeze 평가.
//
// 트리거 위치: report INSERT 성공 + 자동 차단 + 자동 매치 해제 모두 끝낸 뒤.
// 본 함수가 실패해도 신고 응답은 항상 정상 (201) — freeze 실패가 신고 자체를
// 막지 않는다 (push-notifications 의 fire-and-forget 패턴과 동일).
//
// race 안전성:
//   - DB UNIQUE (reporter_id, reported_id) (mig 002) 가 동일 reporter 중복 INSERT
//     차단 → count(*) 가 count(DISTINCT reporter_id) 와 항등.
//   - 동시 신고 race: 두 신고가 동시에 threshold 도달 → 두 UPDATE 실행되지만
//     `.is('frozen_at', null)` 조건절로 첫 한 번만 실제 set. 두 번째는 0 rows.
//   - updated.length > 0 가드로 freeze_events 중복 INSERT 도 차단.
//
// 침묵 통지 정책 (05a 항목 2,5): 사용자에게 별도 통지 X. 다음 mutating 호출
// 시 freezeGuard 미들웨어가 403 → FE 글로벌 핸들러가 모달 1회. freeze_events
// 가 침묵 정책의 법적 근거 (CS 응대 시 reporter 정보 제공).
async function evaluateAutoFreeze(reportedId: string): Promise<void> {
  const threshold = env.moderation.autoFreezeReportThreshold;

  // 누적 카운트 + reporter_ids 한 번에 조회. UNIQUE 제약으로 count(*) 는
  // count(DISTINCT reporter_id) 와 같지만, reporter_ids 배열을 audit log 에 보존하기
  // 위해 select 도 함께 수행. idx_reports_reported_pending (mig 021) 사용.
  const { data: reporterRows, count: reportCount, error: countError } = await supabase
    .from('reports')
    .select('reporter_id', { count: 'exact' })
    .eq('reported_id', reportedId);

  if (countError) {
    console.error('[moderation.freeze.count_failed]', {
      reported_id: reportedId,
      error: countError.message,
    });
    return;
  }

  if (reportCount === null || reportCount < threshold) {
    return;
  }

  // 임계치 도달 — freeze 시도. .is('frozen_at', null) 조건절로 idempotent.
  const { data: updated, error: freezeErr } = await supabase
    .from('profiles')
    .update({ is_active: false, frozen_at: new Date().toISOString() })
    .eq('id', reportedId)
    .is('frozen_at', null)
    .select('id');

  if (freezeErr) {
    console.error('[moderation.freeze.update_failed]', {
      reported_id: reportedId,
      error: freezeErr.message,
    });
    return;
  }

  // updated.length === 0 이면 이미 frozen 상태 → audit 중복 INSERT 차단.
  if (!updated || updated.length === 0) {
    return;
  }

  // distinct reporter_ids — UNIQUE 제약으로 사실상 distinct 이지만 방어적으로 Set.
  const reporterIds = Array.from(
    new Set((reporterRows ?? []).map((r: { reporter_id: string }) => r.reporter_id)),
  );

  const { error: auditErr } = await supabase
    .from('freeze_events')
    .insert({
      frozen_user_id: reportedId,
      report_count_at_trigger: reportCount,
      reporter_ids: reporterIds,
    });

  if (auditErr) {
    // audit INSERT 실패는 freeze 자체를 롤백하지 않음 — 콘솔 로그로 가시화.
    // 05a 항목 5 의 "자동화된 결정 근거 보존" 요건은 만족 못 하지만 freeze 효과는
    // 유효 → 운영이 즉시 인지하고 admin 으로 수동 audit 복원하도록 한다.
    console.error('[moderation.freeze.audit_insert_failed]', {
      reported_id: reportedId,
      report_count: reportCount,
      reporter_count: reporterIds.length,
      error: auditErr.message,
    });
  }

  console.warn('[moderation.freeze.applied]', {
    reported_id: reportedId,
    report_count: reportCount,
    reporter_count: reporterIds.length,
    threshold,
    at: new Date().toISOString(),
  });
}

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

  // message-moderation-v1 (PR2): 누적 신고 자동 freeze 평가.
  // 에러는 함수 내부에서 console.error 로 흡수 — 신고 응답 자체를 막지 않는다.
  await evaluateAutoFreeze(reported_id);

  res.status(201).json({ status: 'reported' });
});

export default router;
