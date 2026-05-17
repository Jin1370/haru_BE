import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateQuery } from '../middleware/validate';
import { requireNotFrozen } from '../utils/freezeGuard';
import { AuthRequest, type VoiceIntroSlotLanguage } from '../types';
import { pickViewerSlot } from './swipe';

const matchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  before: z.string().datetime().optional(),
});

interface MatchSummary {
  match_id: string;
  last_message_id: string | null;
  last_message_preview: string | null;
  last_message_sender_id: string | null;
  last_message_created_at: string | null;
  // mig 017 v3 에서 추가: 마지막 메시지의 status / listened_at 을 RPC 단계에서
  // 노출. FE MatchItem 의 마스킹 분기 (본인 발신 / 상대 발신·미청취 등) 가
  // 별도 fetch 없이 평가 가능하도록 함.
  last_message_audio_status: 'pending' | 'processing' | 'ready' | 'failed' | null;
  last_message_listened_at: string | null;
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

  // 3. 매치별 마지막 메시지 + 읽지 않은 수 + 라운드트립 기반 unlock 플래그 (RPC v3)
  //
  // read-at-removal-list-mask sprint:
  //   - v3 는 unread 산정을 listened_at IS NULL 기준으로 전환 + audio_status='ready'
  //     필터 적용 (voice-first-message-gate follow-up 의 채팅방 GET 필터와 정합).
  //   - last_message 후보 SELECT 에 viewer 시점 필터 (sender_id = viewer OR
  //     audio_status='ready') 적용 → 수신자에게 안 보이는 메시지가 카드 미리보기
  //     자리에 잡혀 빈 상태로 보이는 회귀 차단.
  //   - 응답에 last_message_audio_status / last_message_listened_at 두 필드 추가
  //     (FE 마스킹 분기용 raw 필드).
  const matchIds = matches.map((m) => m.id);
  const [{ data: summaries, error: rpcError }, mutesResult] = await Promise.all([
    supabase.rpc('get_match_summaries_v3', {
      match_ids: matchIds,
      viewer_id: req.userId!,
    }),
    // mig 022: viewer 가 mute 한 match_id 일괄 조회. RLS 가 본인 행만 통과시키므로
    // user_id 필터는 defense-in-depth. mig 미적용 윈도우에서 PostgREST 가 404 를
    // 주면 mutedSet 은 빈 Set 으로 폴백 → 응답에 muted=false 일관 노출 (회귀 X).
    supabase
      .from('match_mutes')
      .select('match_id')
      .eq('user_id', req.userId!)
      .in('match_id', matchIds),
  ]);
  // silent-success 가드: mig 017 미적용 상태에서 BE 만 deploy 되면 RPC not found
  // 가 발생해도 응답이 빈 매치 목록 + unread=0 으로 silent-degrade 된다. listened
  // POST 의 schema-drift 가드와 동일 패턴 — 500 으로 가시화.
  if (rpcError) {
    res.status(500).json({ error: rpcError.message });
    return;
  }

  const summaryMap = new Map<string, MatchSummary>(
    ((summaries || []) as MatchSummary[]).map((s) => [s.match_id, s])
  );

  const mutedSet = new Set<string>(
    (mutesResult.data ?? []).map((row: { match_id: string }) => row.match_id),
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

    // tombstone (언매치 또는 상대 탈퇴) 매치는 unread badge 가 사용자 혼동을
    // 유발하므로 0 으로 강제. RPC 는 raw 값을 주고 라우트가 정책적으로 normalize.
    // read-at-removal-list-mask sprint (strategist 우려 2 의 follow-up).
    const isTombstone = !!match.unmatched_at || !!rawPartner?.deleted_at;
    const unreadCount = isTombstone ? 0 : Number(summary?.unread_count || 0);

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
      // 응답 wire 형식의 키 이름 (id/original_text/sender_id/created_at) 은
      // 기존 그대로 유지하고, 값만 v3 RPC 의 last_message_preview 에서 가져온다.
      // audio_status / listened_at 은 FE 마스킹 분기용 신규 필드.
      //
      // tombstone(언매치/상대 탈퇴) 매치는 last_message.original_text 를 null 로
      // normalize — FE 분기 1번이 tombstone 카피로 덮지만, raw API 응답을 직접
      // 보는 경로(reverse engineer/직접 호출) 에서도 차단 직전 마지막 메시지
      // 원문이 노출되지 않도록 defense-in-depth (read-at-removal-list-mask
      // safety 권고 #2).
      last_message: summary?.last_message_id
        ? {
            id: summary.last_message_id,
            original_text: isTombstone ? null : summary.last_message_preview,
            sender_id: summary.last_message_sender_id,
            created_at: summary.last_message_created_at,
            audio_status: summary.last_message_audio_status,
            listened_at: summary.last_message_listened_at,
          }
        : null,
      unread_count: unreadCount,
      // mig 022: per-match 푸시 옵트아웃 (액션시트 "알림 끄기"). user_preferences.
      // notify_messages 전역 토글과 AND 결합 — pushNotifications.ts 가 두 토글
      // 모두 검사한다.
      muted: mutedSet.has(match.id),
    };
  });

  res.json(results);
});

// 채팅 상대의 부가 프로필 (birth_date / interests / 시청자 언어 슬롯 보이스
// 인트로 URL). 디스커버와 정합을 맞추기 위해 voice_intro_audio_url 응답 키는
// viewer 의 profiles.language → pickViewerSlot 매핑 결과로 골라 미러한다.
// 종전에는 FE 가 supabase 에서 직접 단일 voice_intro_audio_url 컬럼을 select
// 했고, 그 컬럼은 mig 011 의 정의상 "작성자 언어 슬롯 미러" 라 시청자가
// 자기 언어가 아닌 작성자 언어로 듣게 되는 비대칭이 있었다.
//
// tombstone 매치(unmatched/partner deleted)도 통과시킨다 — 채팅 화면이 종료
// 상태에서도 과거 partner detail 모달을 열 수 있도록(현재 FE 는 막고 있지만
// 라우트 차원에서 정책을 강제하지 않는다, /api/matches 와 일관). 활성 여부
// 분기가 필요해지면 호출처에서 컨트롤한다.
router.get('/:matchId/partner', async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
  const userId = req.userId!;

  const { data: match, error: matchErr } = await supabase
    .from('matches')
    .select('user1_id, user2_id')
    .eq('id', matchId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .maybeSingle();
  if (matchErr) {
    res.status(500).json({ error: matchErr.message });
    return;
  }
  if (!match) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }

  const partnerId = match.user1_id === userId ? match.user2_id : match.user1_id;

  const [viewerResult, partnerResult] = await Promise.all([
    supabase.from('profiles').select('language').eq('id', userId).maybeSingle(),
    supabase
      .from('profiles')
      .select('birth_date, interests, voice_intro_audio_urls')
      .eq('id', partnerId)
      .maybeSingle(),
  ]);

  if (partnerResult.error) {
    res.status(500).json({ error: partnerResult.error.message });
    return;
  }
  if (!partnerResult.data) {
    res.status(404).json({ error: 'Partner profile not found' });
    return;
  }

  const viewerLanguage = (viewerResult.data?.language as string | null) ?? null;
  const slot = pickViewerSlot(viewerLanguage);
  const slotUrls = (partnerResult.data.voice_intro_audio_urls ?? {}) as Partial<
    Record<VoiceIntroSlotLanguage, string | null>
  >;

  res.json({
    birth_date: (partnerResult.data.birth_date as string | null) ?? '',
    interests: (partnerResult.data.interests as string[] | null) ?? [],
    voice_intro_audio_url: (slotUrls[slot] as string | null | undefined) ?? null,
  });
});

// 매치를 본인 목록에서만 숨김 (mig 013).
//
// 활성 매치 (unmatched_at IS NULL AND partner.deleted_at IS NULL) 는
// 거부 — 활성 매치를 정리하려면 차단/언매치를 먼저 거쳐 tombstone 으로
// 만들어야 한다. 멱등하다: 이미 hidden_by 에 들어 있으면 추가 작업 없이
// 204. 양쪽이 모두 숨긴 매치 하드 삭제는 별도 클린업 잡(향후) 대상.
// message-moderation-v1 (PR2): freeze 사용자 mutating 차단.
router.post('/:matchId/hide', requireNotFrozen, async (req: AuthRequest, res: Response) => {
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

// 매치별 푸시 알림 옵트아웃 (mig 022). 채팅 목록 long-press 액션시트의
// "알림 끄기/켜기" 백업 엔드포인트.
//
// POST = mute (멱등 upsert), DELETE = unmute (멱등 delete). 둘 다 멤버십
// (viewer ∈ {user1_id, user2_id}) 만 검사하고 tombstone 여부는 무시 —
// FE 에서 tombstone 매치는 액션시트의 mute 항목을 미노출하므로 라우트는
// 정책을 강제하지 않는다 (hide 라우트와 동일 결).
//
// freeze 가드 미적용: mute 는 본인 알림 설정 변경일 뿐이라 mutating 차단
// 동선이 아니다 (notifications/preferences 라우트와 일관).
// Express 5 의 req.params 타입은 `string | string[]` 이므로 helper 도
// 그대로 받아 PostgREST 의 `.eq` (unknown 인수) 에 그대로 통과시킨다.
async function ensureMatchMembership(matchId: string | string[], userId: string) {
  const { data, error } = await supabase
    .from('matches')
    .select('id')
    .eq('id', matchId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .maybeSingle();
  return { found: !!data, error };
}

router.post('/:matchId/mute', async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
  const userId = req.userId!;

  const { found, error: memErr } = await ensureMatchMembership(matchId, userId);
  if (memErr) {
    res.status(500).json({ error: memErr.message });
    return;
  }
  if (!found) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }

  // PRIMARY KEY (match_id, user_id) → upsert 가 idempotent. ignoreDuplicates
  // 옵션으로 중복 시 23505 가 아닌 0-row 정상 응답.
  const { error: upErr } = await supabase
    .from('match_mutes')
    .upsert(
      { match_id: matchId, user_id: userId },
      { onConflict: 'match_id,user_id', ignoreDuplicates: true },
    );
  if (upErr) {
    res.status(500).json({ error: upErr.message });
    return;
  }

  res.status(200).json({ muted: true });
});

router.delete('/:matchId/mute', async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
  const userId = req.userId!;

  const { found, error: memErr } = await ensureMatchMembership(matchId, userId);
  if (memErr) {
    res.status(500).json({ error: memErr.message });
    return;
  }
  if (!found) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }

  const { error: delErr } = await supabase
    .from('match_mutes')
    .delete()
    .eq('match_id', matchId)
    .eq('user_id', userId);
  if (delErr) {
    res.status(500).json({ error: delErr.message });
    return;
  }

  res.status(200).json({ muted: false });
});

// 언매치 전용 엔드포인트는 제거됨 — 언매치/차단 결과가 동일하므로 FE 의
// "언매치" 액션은 POST /api/block 으로 통합. matches.unmatched_at 컬럼은
// block/report 흐름에서 soft-delete 마커로 계속 사용된다.

export default router;
