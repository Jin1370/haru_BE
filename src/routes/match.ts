import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateQuery } from '../middleware/validate';
import { AuthRequest } from '../types';

const matchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  before: z.string().datetime().optional(),
});

interface MatchSummary {
  match_id: string;
  last_message_id: string | null;
  last_message_text: string | null;
  last_message_sender_id: string | null;
  last_message_created_at: string | null;
  unread_count: number;
  round_trip_count: number;
  main_photo_unlocked: boolean;
  all_photos_unlocked: boolean;
}

// mig 014 의 matches 신규 컬럼 (백필 미완/실패 매치는 NULL 가능).
// `.select('*')` 가 자동으로 끌어오므로 별도 select 추가는 불필요.
interface MatchRoundtripColumns {
  round_trip_count: number | null;
  main_photo_unlocked_at: string | null;
  all_photos_unlocked_at: string | null;
}

const router = Router();

router.use(authMiddleware);

// 내 매치 목록 (상대 프로필 + 마지막 메시지 + 읽지 않은 수)
//
// mig 013 이후: 언매치된 매치도 응답에 포함시켜 FE 에서 "매치 종료"
// tombstone 으로 렌더링한다. 본인이 hidden_by 에 들어가 있으면 본인
// 시야에서만 제외 (상대방은 별개로 보유). 활성 매치 노출 정책은
// 변함 없음 — block/report/unmatch 동선이 동일하게 unmatched_at 을
// 세팅한다.
router.get('/', validateQuery(matchListQuerySchema), async (req: AuthRequest, res: Response) => {
  const limit = req.query.limit as unknown as number;
  const before = req.query.before as string | undefined;

  // 1. 매치 조회. 언매치된 매치도 tombstone 노출용으로 포함하되, 본인이
  // 숨김 처리(hidden_by 에 자기 user_id append)한 매치는 본인 목록에서만
  // 제외. PostgREST 의 cs(=contains) 연산자에 단일 원소 배열을 넘긴다.
  let matchQuery = supabase
    .from('matches')
    .select('*')
    .or(`user1_id.eq.${req.userId!},user2_id.eq.${req.userId!}`)
    .not('hidden_by', 'cs', `{${req.userId!}}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    matchQuery = matchQuery.lt('created_at', before);
  }

  const { data: matches, error } = await matchQuery;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!matches || matches.length === 0) {
    res.json([]);
    return;
  }

  // 2. Partner 프로필 배치 조회
  const partnerIds = matches.map((m) =>
    m.user1_id === req.userId! ? m.user2_id : m.user1_id
  );

  // mig 009 이후 단일 scalar `language` 컬럼이 source of truth.
  // mig 012 이후 deleted_at 가 tombstone 마커 — FE 가 이 값을 보고
  // "탈퇴한 사용자" 라벨로 렌더링한다 (display_name 은 비어있음).
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name, photos, nationality, language, deleted_at')
    .in('id', partnerIds);

  const profileMap = new Map(
    (profiles || []).map((p) => [p.id, { ...p, language: (p.language as string | null) ?? '' }]),
  );

  // 3. 매치별 마지막 메시지 + 읽지 않은 수 + 라운드트립 기반 unlock 플래그 (RPC v2)
  const matchIds = matches.map((m) => m.id);
  const { data: summaries } = await supabase.rpc('get_match_summaries_v2', {
    match_ids: matchIds,
    viewer_id: req.userId!,
  });

  const summaryMap = new Map<string, MatchSummary>(
    ((summaries || []) as MatchSummary[]).map((s) => [s.match_id, s])
  );

  // 4. 조합
  // 보안 경계: Supabase Storage URL 은 public 이므로 FE 블러는 UX 보호일 뿐.
  //            all_photos_unlocked=false 인 경우 서버에서 photos 배열을 잘라
  //            메인 1장만 노출한다 (photos[0] 이 없으면 빈 배열).
  //
  // mig 014 이후 photo_access 산출 우선순위:
  //   1차 = matches.*_unlocked_at IS NOT NULL (트리거가 단조 set 한 컬럼 진실)
  //   폴백 = get_match_summaries_v2 RPC 의 *_unlocked (rt>=임계치 즉석 계산)
  //          — 014b 백필 실패로 *_unlocked_at 이 NULL 인 매치에 대비.
  // round_trip_count 도 컬럼 우선, NULL 이면 v2 RPC 결과, 그래도 없으면 0.
  const results = matches.map((match) => {
    const partnerId = match.user1_id === req.userId! ? match.user2_id : match.user1_id;
    const summary = summaryMap.get(match.id);
    const rawPartner = profileMap.get(partnerId);

    const cols = match as unknown as MatchRoundtripColumns;
    // `!= null` (loose) intentional: 트리거가 적용되기 전 mig 014 윈도우 동안
    // 컬럼이 응답에 빠져 `undefined` 로 도착할 수 있다. `!== null` 은
    // undefined 를 통과시켜 모든 매치가 unlock=true 로 응답되는
    // 사진 노출 사고를 만든다 — null/undefined 둘 다 잠금 의미로 처리.
    const mainUnlocked =
      cols.main_photo_unlocked_at != null
        ? true
        : Boolean(summary?.main_photo_unlocked);
    const allUnlocked =
      cols.all_photos_unlocked_at != null
        ? true
        : Boolean(summary?.all_photos_unlocked);

    const photoAccess = {
      main_photo_unlocked: mainUnlocked,
      all_photos_unlocked: allUnlocked,
    };

    // 백필 실패 매치(rt=NULL)는 0 으로 정규화. FE 의 photoAccessStore
    // downgrade guard 가 잠금 역행을 차단하므로 0 으로 보내도 안전.
    const roundTripCount =
      cols.round_trip_count != null
        ? cols.round_trip_count
        : Number(summary?.round_trip_count ?? 0);

    const partner = rawPartner
      ? {
          id: rawPartner.id,
          display_name: rawPartner.display_name,
          nationality: rawPartner.nationality,
          language: rawPartner.language,
          deleted_at: (rawPartner.deleted_at as string | null) ?? null,
          photos: photoAccess.all_photos_unlocked
            ? (rawPartner.photos ?? [])
            : (rawPartner.photos ?? []).slice(0, 1),
        }
      : null;

    return {
      match_id: match.id,
      created_at: match.created_at,
      // unmatched_at 가 채워져 있으면 FE 가 채팅 종료 tombstone 으로
      // 렌더 + 입력창 비활성화. 새 메시지 POST 는 message.ts 에서 동일
      // 컬럼으로 막는다.
      unmatched_at: (match.unmatched_at as string | null) ?? null,
      partner,
      photo_access: photoAccess,
      round_trip_count: roundTripCount,
      last_message: summary?.last_message_id
        ? {
            id: summary.last_message_id,
            original_text: summary.last_message_text,
            sender_id: summary.last_message_sender_id,
            created_at: summary.last_message_created_at,
          }
        : null,
      unread_count: Number(summary?.unread_count || 0),
    };
  });

  res.json(results);
});

// 매치를 본인 목록에서만 숨김 (mig 013).
//
// 활성 매치 (unmatched_at IS NULL AND partner.deleted_at IS NULL) 는
// 거부 — 활성 매치를 정리하려면 차단/언매치를 먼저 거쳐 tombstone 으로
// 만들어야 한다. 멱등하다: 이미 hidden_by 에 들어 있으면 추가 작업 없이
// 204. 양쪽이 모두 숨긴 매치 하드 삭제는 별도 클린업 잡(향후) 대상.
router.post('/:matchId/hide', async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
  const userId = req.userId!;

  const { data: match } = await supabase
    .from('matches')
    .select('id, user1_id, user2_id, unmatched_at, hidden_by')
    .eq('id', matchId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .single();

  if (!match) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }

  // tombstone 인지 검증 — unmatched_at 또는 상대 partner.deleted_at 이
  // 채워져 있어야 hide 가능. 활성 매치는 400.
  const partnerId = match.user1_id === userId ? match.user2_id : match.user1_id;
  let isTombstone = !!match.unmatched_at;
  if (!isTombstone) {
    const { data: partner } = await supabase
      .from('profiles')
      .select('deleted_at')
      .eq('id', partnerId)
      .maybeSingle();
    isTombstone = !!partner?.deleted_at;
  }
  if (!isTombstone) {
    res.status(400).json({
      error: 'Active match cannot be hidden — unmatch or block first',
      code: 'MATCH_ACTIVE',
    });
    return;
  }

  const currentHidden = (match.hidden_by as string[] | null) ?? [];
  if (currentHidden.includes(userId)) {
    // already hidden — idempotent 204
    res.status(204).end();
    return;
  }

  const { error: updateErr } = await supabase
    .from('matches')
    .update({ hidden_by: [...currentHidden, userId] })
    .eq('id', matchId);
  if (updateErr) {
    res.status(500).json({ error: updateErr.message });
    return;
  }

  res.status(204).end();
});

// 언매치 전용 엔드포인트는 제거됨 — 언매치/차단 결과가 동일하므로 FE 의
// "언매치" 액션은 POST /api/block 으로 통합. matches.unmatched_at 컬럼은
// block/report 흐름에서 soft-delete 마커로 계속 사용된다.

export default router;
