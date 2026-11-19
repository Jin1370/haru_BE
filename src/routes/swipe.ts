import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  swipeBodySchema,
  swipeQuerySchema,
  quotaQuerySchema,
  revealBodySchema,
  playlistParamsSchema,
  playlistOpenBodySchema,
  playlistSeenBodySchema,
} from '../schemas/swipe';
import { getStarBalance, revealLike, refundLikeReveal, sumLedger, InsufficientStarsError } from '../services/stars';
import { getBlurredMainPhotos } from '../services/photoBlur';
import {
  CARD_RESET_AMOUNT,
  cardResetCost,
  REVEAL_STAR_COST,
  REVEAL_FREE_INTERVAL_MS,
  AD_REWARD_DAILY_MAX,
  AD_REWARD_STARS,
} from '../constants/stars';
import { AuthRequest, type VoiceIntroSlotLanguage } from '../types';
import { sendPushToUser } from '../services/pushNotifications';
import { requireNotFrozen } from '../utils/freezeGuard';
import { env } from '../config/env';
import { createSignedUrlFromStored } from '../services/storage';
import { VOICE_INTRO_BUCKET } from '../services/voiceIntro';
import { fetchReadyPhotosByUser } from '../services/profilePhotos';
import { buildCampaignBotCard, isCampaignBot, sendCampaignBotMessages } from '../services/campaignBot';

// 시청자 언어 → 보이스 인트로 슬롯 매핑 (mig 011).
// ko/ja/en 활성. th/hi/그 외/null 은 'en' 폴백 (FE 의 영문 강제 정책과 일관).
export function pickViewerSlot(viewerLanguage: string | null | undefined): VoiceIntroSlotLanguage {
  if (viewerLanguage === 'ko' || viewerLanguage === 'ja' || viewerLanguage === 'en') {
    return viewerLanguage;
  }
  return 'en';
}

const router = Router();

// 받은 좋아요(GET /likes-received) 가 한 번에 처리할 최신 좋아요 상한.
// (E) 옛 코드는 likers/프로필/사진을 무제한 로드 → 인기 사용자가 수천 개 좋아요를
// 받으면 거대한 IN 쿼리 + 수천 행 materialization. 최신 N 개로 바운드해 핫패스를
// 안정화한다. FE 는 일일 50 한도로 어차피 천천히 소화하므로 N 개 일괄 반환으로 충분.
// 트레이드오프: 최신 N 개를 모두 이미 응답(스와이프)한 사용자는 그보다 오래된
// 미응답 좋아요가 있어도 노출 안 됨 (A1 과 동일한 freshness 편향, 후속 페이지네이션 대상).
export const LIKES_RECEIVED_MAX = 300;

router.use(authMiddleware);

// 탐색 후보 — 점수 높은 순. liked_you = 이 사람이 나에게 이미 인사함. passed_at = 내가 넘긴
// 사람이면 넘긴 시각 ('다시 보기' 후보), 새 후보면 null.
type PoolCandidate = { id: string; score: number; liked_you: boolean; passed_at: string | null };

// 플레이리스트 한 칸에 넣을 나에게 인사한 사람 수 상한. 탐색에서도 매치가 나게 섞되,
// 전부 넣으면 받은 인사 탭을 열 이유가 사라진다.
export const LIKED_YOU_SLOTS = 2;
// 칸을 고를 때 나에게 인사한 사람에게 더하는 점수 (조정 손잡이). 0 이 기본 — 인사한 사람은
// 최근 활동한 사람이라 이미 접속 가산을 받아, 가산 없이도 칸마다 0~2명이 섞인다. prod 실데이터
// 24명 시뮬레이션: +0 은 1-2-2-1-1-2…, 1-1-1-2-0-1… 처럼 섞이고, +10 은 대부분 2-2-2-2… 로
// 앞 칸부터 꽉 찼다.
export const LIKED_YOU_PICK_BONUS = 0;

// 점수 순 후보에서 플레이리스트 한 칸(n명)을 고른다 — 인사한 사람은 LIKED_YOU_PICK_BONUS 를
// 더한 점수로 줄 세워 앞에서부터 담되 칸당 LIKED_YOU_SLOTS 명까지만 (넘는 사람은 건너뜀).
// 인사 안 한 사람이 모자라 n명이 안 차면 건너뛴 인사한 사람으로 마저 채운다 (빈 칸보다 바로
// 매치될 카드가 낫다). 카드 순서는 그 점수 순 그대로.
export function pickPlaylistCards<T extends { id: string; score: number; liked_you: boolean }>(
  pool: T[],
  n: number,
): string[] {
  const ranked = [...pool].sort(
    (a, b) =>
      b.score + (b.liked_you ? LIKED_YOU_PICK_BONUS : 0) - (a.score + (a.liked_you ? LIKED_YOU_PICK_BONUS : 0)) ||
      (a.id < b.id ? -1 : 1),
  );
  const out: T[] = [];
  const skipped: T[] = [];
  let likers = 0;
  for (const c of ranked) {
    if (out.length >= n) break;
    if (c.liked_you && likers >= LIKED_YOU_SLOTS) {
      skipped.push(c);
      continue;
    }
    if (c.liked_you) likers++;
    out.push(c);
  }
  if (out.length < n) {
    const chosen = new Set([...out, ...skipped.slice(0, n - out.length)].map((c) => c.id));
    return ranked.filter((c) => chosen.has(c.id)).map((c) => c.id);
  }
  return out.map((c) => c.id);
}

// 무료 칸(그날 처음 여는 칸)에 넣을 새 카드 장수 — 남은 새 카드가 줄수록 천천히 줄이고 나머지를
// '다시 보기'(넘겼던 사람)로 채운다. 남은 새 카드 50+ → 10장, 40 → 9, 25 → 7, 10 → 5, 3 → 3, 0 → 0.
// 새 카드를 한 번에 다 쓰지 않고 여러 날에 나눠, 카드가 바닥나지 않게 한다.
export function freeNewSlots(freshCount: number): number {
  return Math.min(freshCount, CARD_RESET_AMOUNT, Math.round(4 + freshCount / 8));
}

// 넘겼던 사람 — 점수 순. DB 가 대기 기간(3일 × 2^(넘긴 횟수-1))이 지난 사람만 주고, 점수는 넘긴
// 횟수 × 10 만큼 깎아 둔다 (같은 사람이 반복될수록 드물게·뒤로).
function recycledBestFirst(pool: PoolCandidate[]): PoolCandidate[] {
  return pool.filter((c) => c.passed_at).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

// 무료 칸: 새 카드 freeNewSlots 장 (점수 순·인사한 사람 칸당 2명) + 나머지는 다시 보기.
// 다시 보기 카드가 모자라면 새 카드로 마저 채워 10장을 맞춘다 (플레이리스트 기본 구성은 10장).
// 덜 채워 열면 다음 목록 조회의 빈자리 채우기가 새 카드로 채워, 열기 전에 보여 준 LP 수가 줄어든다.
export function pickFreePlaylist(pool: PoolCandidate[]): string[] {
  const fresh = pool.filter((c) => !c.passed_at);
  const recycled = recycledBestFirst(pool);
  const recycledSlots = Math.min(recycled.length, CARD_RESET_AMOUNT - freeNewSlots(fresh.length));
  const picks = pickPlaylistCards(fresh, CARD_RESET_AMOUNT - recycledSlots);
  const again = recycled.slice(0, CARD_RESET_AMOUNT - picks.length).map((c) => c.id);
  return [...picks, ...again];
}

// 별사탕 칸: 새 카드로만 꽉 찬 10장. 새 카드가 10장이 안 되면 열 수 없다 (빈 배열) — 돈을 내고
// 넘겼던 카드를 받지 않게.
export function pickPaidPlaylist(pool: PoolCandidate[]): string[] {
  const picks = pickPlaylistCards(pool.filter((c) => !c.passed_at), CARD_RESET_AMOUNT);
  return picks.length === CARD_RESET_AMOUNT ? picks : [];
}

// 빈자리를 채울 순서 — 새 카드(인사 안 한 사람 점수 순 → 인사한 사람) 다음에 넘겼던 사람(점수 순).
function fillOrder(pool: PoolCandidate[]): PoolCandidate[] {
  const fresh = pool.filter((c) => !c.passed_at);
  return [...fresh.filter((c) => !c.liked_you), ...fresh.filter((c) => c.liked_you), ...recycledBestFirst(pool)];
}

const poolError = (status: number, error: string): { status: number; error: string } => ({ status, error });

// 캠페인 봇을 이미 처리했는가 (스와이프·차단·오늘 플레이리스트) — 처리했으면 다시 넣지 않는다.
// 조회 실패면 처리한 것으로 본다 (같은 봇을 두 번 넣는 것보다 안 넣는 쪽이 낫다).
async function isBotHandled(userId: string, botId: string | null): Promise<boolean> {
  if (!botId || env.discover.hiddenUserIds.includes(botId)) return true;
  const results = await Promise.all([
    supabase.from('swipes').select('id').eq('swiper_id', userId).eq('swiped_id', botId).is('reset_at', null).limit(1),
    supabase
      .from('blocks')
      .select('blocker_id')
      .or(`and(blocker_id.eq.${userId},blocked_id.eq.${botId}),and(blocker_id.eq.${botId},blocked_id.eq.${userId})`)
      .limit(1),
    supabase.from('discover_playlist_items').select('candidate_id').eq('user_id', userId).eq('candidate_id', botId).limit(1),
  ]);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    console.error('[discover] bot check failed:', failed.error.message);
    return true;
  }
  return results.some((r) => (r.data ?? []).length > 0);
}

// 탐색 후보 풀 — 노출 가능한 사람 전원을 DB 가 점수순으로 준다 (discover_pool, mig 067).
// 내가 넘긴 사람도 passed_at 을 달고 포함된다 (다시 보기 후보). 제외: 나 / 인사함 / 차단 / 오늘 플레이리스트 멤버 / 받은 인사 탭에서 연 사람 /
// 같은 언어 / 사진 0장 / 내 언어 보이스 한마디 없음 / 섀도우 숨김 / 캠페인 봇(따로 주입).
async function loadDiscoverPool(userId: string) {
  const { data: viewerProfile } = await supabase.from('profiles').select('language').eq('id', userId).single();
  if (!viewerProfile) return poolError(404, 'Profile not found');
  const slot = pickViewerSlot(viewerProfile.language as string | null);
  const botId = env.campaign.botUserId;

  const [rpcResult, botAlreadyHandled] = await Promise.all([
    supabase.rpc('discover_pool', {
      p_user: userId,
      p_slot: slot,
      p_exclude: [...env.discover.hiddenUserIds, ...(botId ? [botId] : [])],
    }),
    isBotHandled(userId, botId),
  ]);
  if (rpcResult.error) return poolError(500, rpcResult.error.message);
  const scored = ((rpcResult.data ?? []) as any[]).map((r) => ({
    id: r.id as string,
    score: Number(r.score),
    liked_you: !!r.liked_you,
    passed_at: (r.passed_at as string | null) ?? null,
  }));
  return { scored, slot, botAlreadyHandled };
}

// 탐색 카드 한 장의 응답 모양. 내부 정렬 키와 created_at 은 뺀다.
// 보안 경계: 사진은 메인 1장으로 잘라 추가 사진 URL 노출을 막고, photo_access 는 정책상
// 항상 잠금이다. mig 034: photos[0] = profile_photos.converted_url(메인).
// mig 011: voice_intro_audio_urls 에서 시청자 언어 슬롯만 단일 URL 로 미러한다.
// LAUNCH_CHECKLIST #3: voice-intro-audio 버킷이 private 라 저장된 URL 을 응답 직전
// 짧은 TTL 서명 URL 로 바꾼다 (영구 URL 익명 대량 수집 차단).
async function toDiscoverCard(
  row: any,
  readyPhotosByUser: Map<string, string[]>,
  slot: VoiceIntroSlotLanguage,
): Promise<Record<string, unknown> & { id: string }> {
  const { _intra, created_at, voice_intro_audio_urls, ...rest } = row;
  const slotUrls = (voice_intro_audio_urls ?? {}) as Partial<Record<VoiceIntroSlotLanguage, string | null>>;
  return {
    ...rest,
    voice_intro_audio_url: await createSignedUrlFromStored(VOICE_INTRO_BUCKET, slotUrls[slot]),
    photos: (readyPhotosByUser.get(row.id) ?? []).slice(0, 1),
    photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
  };
}

// 받은 좋아요 목록 — 나를 like 한 사용자 중, 내가 아직 응답 스와이프 하지 않았고
// 차단 양방향에 걸리지 않은 active 후보. 최신 LIKES_RECEIVED_MAX 개 좋아요만 스캔
// 해 다운스트림 페치를 바운드한다 (E). 응답 shape 은 디스커버 카드와 동일하게
// 사진 1장 / photo_access 잠금 / voice_intro 시청자 언어 슬롯 미러 — FE 의 SwipeCard
// 컴포넌트를 그대로 재사용할 수 있게 한다.
//
// 사전 필터: 성별/연령 (user_preferences) + viewer 본인 언어 동일 후보 제외 (cross-language
// 정책) — 디스커버와 동일하게 적용. 언어/국가 선호는 SQL 단계에서 거르지 않고 티어
// 정렬 신호로만 사용 (디스커버 동일 패턴).
//
// 정렬: 탐색과 같은 (tier ASC, intra DESC).
//
// 일일 50장 한도와는 무관하게 GET 은 무료(조회는 카운트 안 함). 실제 스와이프
// 행위(POST /swipe)는 디스커버 swipe 와 동일 엔드포인트를 공유하므로 quota 도 함께 적용됨.
router.get('/likes-received', async (req: AuthRequest, res: Response) => {
  // 돌려받은 무료 카드(mig 069 — 무료로 연 카드의 상대가 사라져 인사가 안 들어간 경우). 인사 직후
  // 앱이 바로 받는 이 조회에서 가져가며 지운다 — 아래에서 열 카드가 없으면 그대로 사라진다
  // (나중에 새 인사가 와서 저절로 열리지 않게, 사용자 결정).
  let freeCredits = 0;
  if (env.monetization.enabled) {
    const { data: taken, error: takeErr } = await supabase.rpc('take_like_free_credits', { p_viewer: req.userId! });
    if (takeErr) console.error('[likes-received] free credit take failed:', takeErr.message);
    else freeCredits = Number(taken) || 0;
  }

  // 1) 나를 like 한 사람들 (시간 역순, 최신 LIKES_RECEIVED_MAX 개로 바운드).
  //    (E) UNIQUE(swiper_id, swiped_id) 라 distinct liker. 인기 사용자가 수천 명에게
  //    좋아요를 받아도 다운스트림(프로필/사진 IN 페치)이 최신 N 명으로 묶인다.
  const [likesResult, openedResult] = await Promise.all([
    supabase
      .from('swipes')
      .select('swiper_id, created_at')
      .eq('swiped_id', req.userId!)
      .eq('direction', 'like')
      .order('created_at', { ascending: false })
      .limit(LIKES_RECEIVED_MAX),
    // 열어 둔 카드(무료·별사탕) — 최신 N 개 밖으로 밀려나도, 플레이리스트에 함께 들어가도 빠지지
    // 않게 따로 받는다. 공개 기록은 그 사람이 나를 like 했을 때만 생긴다.
    env.monetization.enabled
      ? supabase.from('like_reveals').select('liker_id').eq('viewer_id', req.userId!)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const likesError = likesResult.error ?? openedResult.error;
  if (likesError) {
    res.status(500).json({ error: likesError.message });
    return;
  }

  // 연 카드라도 그 사람의 인사가 지금 남아 있을 때만 — 인사가 없어졌으면 받은 인사가 아니다.
  const revealedIds = (openedResult.data ?? []).map((r: any) => r.liker_id as string);
  const { data: stillLiked, error: stillLikedErr } =
    revealedIds.length > 0
      ? await supabase
          .from('swipes')
          .select('swiper_id')
          .eq('swiped_id', req.userId!)
          .eq('direction', 'like')
          .in('swiper_id', revealedIds)
      : { data: [], error: null };
  if (stillLikedErr) {
    res.status(500).json({ error: stillLikedErr.message });
    return;
  }
  const openedIds = new Set((stillLiked ?? []).map((r: any) => r.swiper_id as string));
  const likerIds = [
    ...new Set([...(likesResult.data ?? []).map((l: any) => l.swiper_id as string), ...openedIds]),
  ];
  if (likerIds.length === 0) {
    res.json([]);
    return;
  }

  // 2) 내가 이미 스와이프한 상대 + 차단 양방향 + viewer 본인 언어를 병렬 조회.
  //    likes-received 풀에서 제거할 ID 집합 (이미 응답 끝난 like 는 매치/패스 결과로
  //    별도 추적되므로 받은 좋아요 카드로 다시 노출할 의미 없음).
  // 다시보기(reset_at)된 pass 는 "아직 응답 안 함" 으로 본다 (예전 DELETE 와 동일 결과).
  const [viewerSwipesResult, blocksResult, viewerProfileResult, playlistResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id').eq('swiper_id', req.userId!).is('reset_at', null),
    supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId!},blocked_id.eq.${req.userId!}`),
    supabase.from('profiles').select('language').eq('id', req.userId!).single(),
    // 오늘 탐색 플레이리스트에 든 사람은 숨긴다 — 같은 사람을 두 탭에서 따로 보지 않게.
    supabase.from('discover_playlist_items').select('candidate_id').eq('user_id', req.userId!),
  ]);
  if (playlistResult.error) {
    res.status(500).json({ error: playlistResult.error.message });
    return;
  }

  // 플레이리스트 멤버 숨기기는 유료화 ON 에서만 — OFF 는 받은 인사 탭이 무료라, 보이던 카드가
  // 플레이리스트를 열었다는 이유로 사라지지 않게 한다 (같은 사람이 두 탭에 함께 보일 수 있다).
  // 탐색에서 한 번 지나친 사람(초기화 때 자동 기록된 넘김 포함)도 응답한 것으로 보고 빼낸다 (틴더와 같다).
  const swipedSet = new Set<string>([
    ...(viewerSwipesResult.data ?? []).map((s: any) => s.swiped_id as string),
    // 열어 둔 카드는 플레이리스트에 함께 들어가도 숨기지 않는다 (공개와 플레이리스트 열기가 거의
    // 동시에 일어난 경우 — 평소엔 공개한 사람은 플레이리스트 후보에서 빠진다).
    ...(env.monetization.enabled
      ? (playlistResult.data ?? []).map((r: any) => r.candidate_id as string).filter((id) => !openedIds.has(id))
      : []),
  ]);
  const blockedSet = new Set<string>(
    (blocksResult.data ?? []).map((b: any) =>
      b.blocker_id === req.userId! ? (b.blocked_id as string) : (b.blocker_id as string),
    ),
  );
  const viewerLanguage = (viewerProfileResult.data?.language as string | null) ?? '';

  const eligibleIds = likerIds.filter(
    (id) => !swipedSet.has(id) && !blockedSet.has(id) && !env.discover.hiddenUserIds.includes(id),
  );
  if (eligibleIds.length === 0) {
    res.json([]);
    return;
  }

  // 3) 프로필 일괄 조회 — discover hot path 와 동일한 컬럼 집합.
  const query = supabase
    .from('profiles')
    .select(
      'id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests, created_at',
    )
    .in('id', eligibleIds)
    .eq('is_active', true)
    .is('frozen_at', null);

  const { data: profiles, error: profilesError } = await query;

  if (profilesError) {
    res.status(500).json({ error: profilesError.message });
    return;
  }

  // mig 034: profile_photos 일괄 조회 (디스커버와 동일 패턴 — position ASC 전체 ready).
  const candidateIds = (profiles ?? []).map((row: any) => row.id as string);
  const readyPhotosByUser = await fetchReadyPhotosByUser(candidateIds, 'likes-received');

  // 4) 가시 후보 필터 — 사진 0장 / 언어 미설정 / viewer 와 같은 언어 후보 제외.
  //    cross-language 정책은 디스커버와 동일하게 적용 (받은 좋아요 풀에 같은 언어가
  //    있다면 그건 viewer 언어 설정 이전에 받은 좋아요. 현재 정책상 노출 차단).
  const slot = pickViewerSlot(viewerLanguage);
  const visible = (profiles ?? []).filter((row: any) => {
    if (!row.language) return false;
    if (viewerLanguage && row.language === viewerLanguage) return false;
    if ((readyPhotosByUser.get(row.id) ?? []).length === 0) return false;
    // 차별점 1 강제 (디스커버와 동일): voice clone 없거나 voice intro 미작성이면
    // 시청자 언어 슬롯이 비어있어 SwipeCard 재생 버튼이 disabled 가 된다. 받은
    // 좋아요도 같은 SwipeCard 를 재사용하므로 무음 카드를 노출 단계에서 제외.
    const slotUrls = (row.voice_intro_audio_urls ?? {}) as Partial<
      Record<VoiceIntroSlotLanguage, string | null>
    >;
    if (!slotUrls[slot]) return false;
    return true;
  });

  // 5) 점수 정렬: 탐색과 같은 점수 (DB 함수 discover_score, mig 067 — 관심사·사진·신규·
  //    최근 접속·대칭 jitter).
  const { data: scoreRows, error: scoreError } = await supabase.rpc('discover_score', {
    p_user: req.userId!,
    p_ids: visible.map((row: any) => row.id as string),
  });
  if (scoreError) {
    res.status(500).json({ error: scoreError.message });
    return;
  }
  const scoreById = new Map(((scoreRows ?? []) as any[]).map((r) => [r.id as string, Number(r.score)]));
  const scored = visible
    .map((row: any) => ({ ...row, _intra: scoreById.get(row.id) ?? 0 }))
    .sort((a, b) => b._intra - a._intra || (a.id < b.id ? -1 : 1));

  // 별사탕 유료화: 공개한 사람(본 순서대로) 뒤에 아직 안 연 사람 전원을 잠긴(블러) 카드로
  // 내려준다. 잠긴 카드 맨 앞이 다음 무료 카드 — 고정돼서(like_card_pins) 열릴 때까지 바뀌지
  // 않는다(점수 높은 인사가 새로 와도 타이머가 붙은 카드가 옮겨 가지 않게). 무료 카드를 쓸 수
  // 있게 되면 여기서 그 카드를 자동으로 연다 — 앱이 꺼져 있었어도 다음에 들어오면 열려 있고,
  // 앱 조작으로 고를 수 없다. 나머지 잠긴 카드는 별사탕으로만 연다.
  let visibleRows = scored;
  let lockedRows: (typeof scored)[number][] = [];
  let justRevealedId: string | null = null;
  if (env.monetization.enabled && scored.length > 0) {
    const [revealsResult, pinResult, nextFree] = await Promise.all([
      supabase
        .from('like_reveals')
        .select('liker_id, revealed_at')
        .eq('viewer_id', req.userId!)
        .in('liker_id', scored.map((r) => r.id)),
      supabase.from('like_card_pins').select('liker_id').eq('viewer_id', req.userId!).maybeSingle(),
      getNextFreeRevealAt(req.userId!),
    ]);
    if (revealsResult.error || pinResult.error) {
      res.status(500).json({ error: (revealsResult.error ?? pinResult.error)!.message });
      return;
    }
    const revealedAt = new Map<string, string>(
      (revealsResult.data ?? []).map((r: any) => [r.liker_id as string, r.revealed_at as string]),
    );
    const pinnedId = (pinResult.data?.liker_id as string | undefined) ?? null;
    let split = splitLikeCards(scored, revealedAt, pinnedId);

    if (nextFree === null && split.locked.length > 0) {
      const target = split.locked[0].id;
      const won = await claimFreeReveal(req.userId!, target);
      if (won === null) {
        res.status(500).json({ error: 'free reveal failed' });
        return;
      }
      // 동시에 온 다른 요청이 먼저 연 카드가 있으면 그 카드를 연 것으로 본다.
      revealedAt.set(won, new Date().toISOString());
      justRevealedId = won;
      split = splitLikeCards(scored, revealedAt, null);
    }

    // 돌려받은 무료 카드(위에서 가져옴)로 타이머와 상관없이 잠긴 카드 맨 앞을 연다. 위에서 타이머
    // 카드가 열렸어도 그다음 카드에 쓴다 — 미루면 나중에 저절로 열린다.
    for (let i = 0; i < freeCredits && split.locked.length > 0; i++) {
      const target = split.locked[0].id;
      const { error: openErr } = await supabase
        .from('like_reveals')
        .insert({ viewer_id: req.userId!, liker_id: target, paid: true, free_credit: true });
      if (openErr && openErr.code !== '23505') {
        console.error('[likes-received] free credit open failed:', openErr.message);
        break;
      }
      revealedAt.set(target, new Date().toISOString());
      justRevealedId = target;
      split = splitLikeCards(scored, revealedAt, null);
    }

    visibleRows = split.visible;
    lockedRows = split.locked;
    const nextTarget = lockedRows[0]?.id ?? null;
    if (nextTarget && nextTarget !== pinnedId) {
      const { error: pinErr } = await supabase
        .from('like_card_pins')
        .upsert({ viewer_id: req.userId!, liker_id: nextTarget, pinned_at: new Date().toISOString() });
      if (pinErr) console.error('[likes-received] pin failed:', pinErr);
    }
  }

  // 미뤄 둔 인사 알림(mig 074) 중 지금 화면에 나간 카드 몫은 취소한다 — 이미 본 인사를 오전 9시에 또
  // 알리지 않게. 다시 플레이리스트에 뽑혀 숨겨진 사람은 scored 에 없어 그대로 남는다.
  if (scored.length > 0) {
    supabase
      .from('swipes')
      .update({ like_notify_at: null })
      .eq('swiped_id', req.userId!)
      .in('swiper_id', scored.map((r) => r.id as string))
      .not('like_notify_at', 'is', null)
      .then(({ error: clearErr }) => {
        if (clearErr) console.error('[likes-received] held push cancel failed:', clearErr.message);
      });
  }

  // 가장 최근에 인사한 사람 — 받은 인사 알림을 누르고 들어오면 앱이 이 카드에서 시작한다. 잠긴
  // 카드여도 표시한다 (모자이크된 채로 그 카드에서 시작 — 잠긴 카드는 내용이 가짜라 새는 정보 없음).
  const scoredIds = new Set(scored.map((r) => r.id as string));
  const latestLikerId = (likesResult.data ?? [])
    .map((l: any) => l.swiper_id as string)
    .find((id) => scoredIds.has(id));

  // 6) 응답 가공 — discover 와 동일하게 사진 1장 / photo_access 잠금 / voice intro
  //    시청자 언어 슬롯 미러. FE SwipeCard 재사용을 보장하기 위해 shape 일치.
  // mig 034: photos[0] 은 profile_photos.converted_url(메인). (slot 은 visible
  //   필터 직전에 이미 계산됨.)
  // LAUNCH_CHECKLIST #3: discover 와 동일 — private 버킷 전환에 맞춰 응답 직전
  // voice intro slot URL 을 짧은 TTL 서명 URL 로 변환.
  const results: Record<string, unknown>[] = await Promise.all(
    visibleRows.map(async ({ _intra, voice_intro_audio_urls, created_at, ...rest }) => {
      const slotUrls = (voice_intro_audio_urls ?? {}) as Partial<
        Record<VoiceIntroSlotLanguage, string | null>
      >;
      const photoUrls: string[] = (readyPhotosByUser.get(rest.id as string) ?? []).slice(0, 1);
      return {
        ...rest,
        voice_intro_audio_url: await createSignedUrlFromStored(
          VOICE_INTRO_BUCKET,
          slotUrls[slot] as string | null | undefined,
        ),
        photos: photoUrls,
        photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
        // 방금 무료로 열린 카드 — 앱이 이 카드에서 시작한다.
        ...(rest.id === justRevealedId ? { just_revealed: true } : {}),
        ...(rest.id === latestLikerId ? { latest_like: true } : {}),
      };
    }),
  );

  // 잠긴 카드의 id 는 실제 liker id — 공개 요청(POST /likes-received/reveal)에 쓴다.
  // UUID 만으로는 다른 정보를 조회할 경로가 없다.
  if (lockedRows.length > 0) {
    const blurred = await getBlurredMainPhotos(lockedRows.map((r) => r.id));
    lockedRows.forEach((row, i) => {
      results.push({
        ...toLockedCard(row, blurred.get(row.id), row.id),
        // 다음 무료 카드 — 앱은 이 카드에만 "무료 오픈까지" 타이머를 붙인다.
        ...(i === 0 ? { free_next: true } : {}),
        ...(row.id === latestLikerId ? { latest_like: true } : {}),
      });
    });
  }

  res.json(results);
});

// 무료 카드 한 장 열기 — 받은 인사 탭에 들어갈 때 목록 요청이 거의 동시에 두 번 나가면,
// 둘 다 "무료 카드 있음" 을 보고 각자 다른 카드를 열 수 있다. 일단 넣은 뒤 24시간 안의 무료
// 공개를 다시 읽어 가장 먼저 들어간 한 장만 남기고 내 것이 아니면 지운다. 남은 카드 id 를
// 돌려준다 (실패면 null).
async function claimFreeReveal(viewerId: string, likerId: string): Promise<string | null> {
  const { error: insErr } = await supabase
    .from('like_reveals')
    .insert({ viewer_id: viewerId, liker_id: likerId, paid: false });
  if (insErr && insErr.code !== '23505') {
    console.error('[likes-received] free reveal insert failed:', insErr.message);
    return null;
  }
  const since = new Date(Date.now() - REVEAL_FREE_INTERVAL_MS).toISOString();
  const { data, error } = await supabase
    .from('like_reveals')
    .select('liker_id, revealed_at')
    .eq('viewer_id', viewerId)
    .eq('paid', false)
    .gte('revealed_at', since)
    .order('revealed_at', { ascending: true })
    .order('liker_id', { ascending: true });
  if (error || !data?.length) {
    console.error('[likes-received] free reveal check failed:', error?.message);
    return likerId;
  }
  const winner = data[0].liker_id as string;
  // 내가 방금 넣은 줄만 되돌린다. 이미 있던 줄(23505 — 다른 요청이 열어 이미 화면에 보여 준
  // 카드)을 지우면 열린 카드가 다시 잠긴다.
  if (winner !== likerId && !insErr) {
    const { error: delErr } = await supabase
      .from('like_reveals')
      .delete()
      .eq('viewer_id', viewerId)
      .eq('liker_id', likerId)
      .eq('paid', false);
    if (delErr) console.error('[likes-received] free reveal rollback failed:', delErr.message);
  }
  return winner;
}

// 유료화 ON 의 카드 나누기. rows 는 점수순으로 받는다.
// 공개한 카드(무료든 별사탕이든)는 공개 시각 = 본 시각 순으로 앞에, 그 뒤에 아직 안 연
// 사람 전원을 잠긴 카드로 둔다. 잠긴 카드 맨 앞은 다음 무료 카드 — 고정된 사람(pinnedId)이
// 아직 안 열렸으면 그 사람, 아니면 점수 1위. 나머지는 점수순.
export function splitLikeCards<T extends { id: string }>(
  rows: T[],
  revealedAt: Map<string, string>,
  pinnedId: string | null,
): { visible: T[]; locked: T[] } {
  const at = (r: T) => new Date(revealedAt.get(r.id)!).getTime();
  const visible = rows.filter((r) => revealedAt.has(r.id)).sort((a, b) => at(a) - at(b));
  const unrevealed = rows.filter((r) => !revealedAt.has(r.id));
  const pinned = unrevealed.find((r) => r.id === pinnedId);
  const locked = pinned ? [pinned, ...unrevealed.filter((r) => r !== pinned)] : unrevealed;
  return { visible, locked };
}

// 받은 좋아요 푸시 게이트 — 이 like 가 수신자의 받은 좋아요 탭에 실제로 노출되는가.
// 위 GET /likes-received 의 visible 필터(이미 스와이프함 / is_active / 크로스언어 /
// 사진 / 시청자 언어 보이스 인트로 슬롯)를 한 명분으로 재사용.
// 노출되지 않을 like 까지 푸시하면 "좋아요 왔다" 는 알림을 열었는데 탭이 그대로인
// 거짓 신호가 된다. 차단·freeze 는 sendPushToUser 가 이미 검사하므로 생략.
async function isLikeVisibleToReceiver(likerId: string, receiverId: string): Promise<boolean> {
  const [receiverProfile, receiverSwipe] = await Promise.all([
    supabase.from('profiles').select('language').eq('id', receiverId).maybeSingle(),
    // 수신자가 이미 이 상대를 스와이프(pass)했으면 받은 좋아요 풀에서 제외됨.
    supabase
      .from('swipes')
      .select('id')
      .eq('swiper_id', receiverId)
      .eq('swiped_id', likerId)
      .is('reset_at', null)
      .limit(1),
  ]);

  // 조회 오류는 "안 보임" 으로 넘기지 않고 던진다 — 호출처가 알림을 미뤄 다시 확인한다.
  const lookupErr = receiverProfile.error ?? receiverSwipe.error;
  if (lookupErr) throw new Error(`like visibility: ${lookupErr.message}`);
  if ((receiverSwipe.data ?? []).length > 0) return false;
  // 유료화 ON 은 수신자의 오늘 플레이리스트에 든 사람을 받은 인사 탭에서 숨긴다 (GET /likes-received).
  // 알림을 열었는데 탭에 없는 거짓 신호가 되지 않게 푸시도 보내지 않는다 — 플레이리스트에서 만난다.
  if (env.monetization.enabled) {
    const { data: inPlaylist, error: playlistErr } = await supabase
      .from('discover_playlist_items')
      .select('candidate_id')
      .eq('user_id', receiverId)
      .eq('candidate_id', likerId)
      .limit(1);
    if (playlistErr) throw new Error(`like visibility playlist: ${playlistErr.message}`);
    if ((inPlaylist ?? []).length > 0) return false;
  }
  // 섀도우 숨김 계정의 like 는 받은 좋아요 탭에 안 뜨므로 푸시도 보내지 않는다
  // (열었는데 탭이 그대로인 거짓 신호 방지).
  if (env.discover.hiddenUserIds.includes(likerId)) return false;

  const viewerLanguage = (receiverProfile.data?.language as string | null) ?? '';

  const { data: liker, error } = await supabase
    .from('profiles')
    .select('language, voice_intro_audio_urls')
    .eq('id', likerId)
    .eq('is_active', true)
    .is('frozen_at', null)
    .maybeSingle();
  if (error) throw new Error(`like visibility liker: ${error.message}`);
  const row = liker as any;
  if (!row?.language) return false;
  if (viewerLanguage && row.language === viewerLanguage) return false;

  const slotUrls = (row.voice_intro_audio_urls ?? {}) as Partial<
    Record<VoiceIntroSlotLanguage, string | null>
  >;
  if (!slotUrls[pickViewerSlot(viewerLanguage)]) return false;

  const photos = await fetchReadyPhotosByUser([likerId], 'like-push');
  return (photos.get(likerId) ?? []).length > 0;
}

// ── 플레이리스트 때문에 미룬 받은 인사 알림 (mig 074) ──────────────────
// 받는 사람의 플레이리스트에 든 사람의 인사는 받은 인사 탭에서 숨겨져 바로 알리지 않는다.
// 그 플레이리스트가 끝나면(현지 새벽 5시) 안 본 카드의 사람은 받은 인사 탭에 들어가므로, 그날
// 현지 오전 9시(끝나는 시각 + 4시간)에 알린다. 봤으면 초기화 때 넘김으로 기록돼 보내지 않는다.
const HELD_LIKE_NOTIFY_DELAY_MS = 4 * 60 * 60 * 1000;
const HELD_LIKE_RETRY_MS = 10 * 60 * 1000;

// 받는 사람의 플레이리스트(끝났지만 아직 정리 전인 것 포함)에 그 사람이 들어 있으면 그 플레이리스트가
// 끝나는 시각, 아니면 null.
async function playlistHoldUntil(receiverId: string, likerId: string): Promise<string | null> {
  const { data: items, error } = await supabase
    .from('discover_playlist_items')
    .select('playlist_id')
    .eq('user_id', receiverId)
    .eq('candidate_id', likerId);
  if (error) throw new Error(`discover_playlist_items: ${error.message}`);
  const ids = (items ?? []).map((i: any) => i.playlist_id as number);
  if (ids.length === 0) return null;
  const { data: lists, error: listErr } = await supabase
    .from('discover_playlists')
    .select('expires_at')
    .in('id', ids)
    .order('expires_at', { ascending: false })
    .limit(1);
  if (listErr) throw new Error(`discover_playlists: ${listErr.message}`);
  return (lists ?? [])[0]?.expires_at ?? null;
}

// holdUntil = 그 사람이 든 플레이리스트가 끝나는 시각. null = 확인하다 오류가 났다 — 알림을 잃지 않게
// 10분 뒤 다시 본다 (그때 다시 확인한다).
async function scheduleHeldLikePush(likerId: string, receiverId: string, holdUntil: string | null): Promise<void> {
  // 끝난 플레이리스트가 정리 실패로 남아 있으면 끝나는 시각이 이미 지났다 — 한 시간 뒤 다시 본다.
  const at =
    holdUntil === null
      ? Date.now() + HELD_LIKE_RETRY_MS
      : Math.max(new Date(holdUntil).getTime() + HELD_LIKE_NOTIFY_DELAY_MS, Date.now() + 60 * 60 * 1000);
  const { error } = await supabase
    .from('swipes')
    .update({ like_notify_at: new Date(at).toISOString() })
    .eq('swiper_id', likerId)
    .eq('swiped_id', receiverId)
    .eq('direction', 'like');
  if (error) console.error('[heldLikePush] schedule failed:', error.message);
}

// 알릴 시각이 된 미룬 인사를 보낸다. 서버 여러 대가 같이 돌아도 시각을 먼저 지운 쪽만 보낸다.
// ponytail: 한 번에 200건 — 넘치면 다음 차례에 이어서 보낸다.
export async function sendHeldLikePushes(): Promise<{ sent: number }> {
  const { data: due, error } = await supabase
    .from('swipes')
    .select('id, swiper_id, swiped_id')
    .eq('direction', 'like')
    .lte('like_notify_at', new Date().toISOString())
    .limit(200);
  if (error) {
    console.error('[heldLikePush] lookup failed:', error.message);
    return { sent: 0 };
  }
  let sent = 0;
  for (const row of (due ?? []) as { id: string; swiper_id: string; swiped_id: string }[]) {
    const { data: claimed, error: claimErr } = await supabase
      .from('swipes')
      .update({ like_notify_at: null })
      .eq('id', row.id)
      .not('like_notify_at', 'is', null)
      .select('id');
    if (claimErr) {
      console.error('[heldLikePush] claim failed:', claimErr.message);
      continue;
    }
    if ((claimed ?? []).length === 0) continue;
    try {
      // 끝난 플레이리스트를 정리해야 본 카드가 넘김으로 기록되고(그러면 보내지 않는다) 안 본 사람이
      // 받은 인사 탭에 나타난다. 앱을 안 켰으면 정리 전이다.
      await finalizePastPlaylists(row.swiped_id);
      // 그사이 새 플레이리스트에 다시 뽑혔으면 그 플레이리스트가 끝난 날로 다시 미룬다.
      const hold = await playlistHoldUntil(row.swiped_id, row.swiper_id);
      if (hold) {
        await scheduleHeldLikePush(row.swiper_id, row.swiped_id, hold);
        continue;
      }
      if (await isLikeVisibleToReceiver(row.swiper_id, row.swiped_id)) {
        await sendPushToUser(row.swiped_id, { type: 'like', liker_id: row.swiper_id });
        sent++;
      }
    } catch (e) {
      // 알림 시각을 이미 지웠다 — 다시 적어 두지 않으면 이 인사는 알림 없이 끝난다.
      console.error('[heldLikePush] send failed, retrying later:', (e as Error).message);
      await scheduleHeldLikePush(row.swiper_id, row.swiped_id, null);
    }
  }
  return { sent };
}

export function startHeldLikePushScheduler(): void {
  const run = () => {
    sendHeldLikePushes().catch((e) => console.error('[heldLikePush] run failed:', (e as Error).message));
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

// 하루가 바뀌는 시각 (사용자 현지). 저녁~새벽 1시가 가장 활발해서 자정 대신 사용이 가장 적은
// 새벽 5시로 둔다 — 밤에 연 플레이리스트가 한창 쓰는 중에 초기화되지 않는다.
const DAY_START_HOUR = 5;

// 사용자 로컬 하루(새벽 5시 ~ 다음 날 새벽 5시)의 [시작, 끝) UTC 범위와 그 하루의 날짜.
// tzOffset 은 JS Date#getTimezoneOffset() 시맨틱 (UTC - local, 분).
function computeLocalDayRangeUtc(nowMs: number, tzOffset: number): {
  fromIso: string; toIso: string; localDate: string;
} {
  // 5시간 서쪽 시간대의 자정 = 현지 새벽 5시
  const tzOffsetMinutes = tzOffset + DAY_START_HOUR * 60;
  // local time 의 timestamp(=UTC 처럼 다루는 가상값) = now - offset
  const localNowAsUtcMs = nowMs - tzOffsetMinutes * 60_000;
  const local = new Date(localNowAsUtcMs);
  // local 자정의 "가상 UTC" 시각
  const localMidnightAsUtcMs = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
  );
  // 실제 UTC instant 로 환산
  const utcMidnightMs = localMidnightAsUtcMs + tzOffsetMinutes * 60_000;
  return {
    fromIso: new Date(utcMidnightMs).toISOString(),
    toIso: new Date(utcMidnightMs + 24 * 60 * 60 * 1000).toISOString(),
    localDate: local.toISOString().slice(0, 10),
  };
}

// ── 별사탕 유료화 헬퍼 (env.monetization.enabled 일 때만 호출) ──────────

// 다음 무료 카드 시각. null = 지금 무료 카드 사용 가능.
async function getNextFreeRevealAt(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('like_reveals')
    .select('revealed_at')
    .eq('viewer_id', userId)
    .eq('paid', false)
    .order('revealed_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`like_reveals: ${error.message}`);
  const last = (data ?? [])[0]?.revealed_at as string | undefined;
  if (!last) return null;
  const next = new Date(last).getTime() + REVEAL_FREE_INTERVAL_MS;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

// 잠긴 카드 — 일반 카드와 같은 모양이지만 내용은 가짜. FE 가 카드 전체에 블러를
// 씌우므로 화면에선 구별되지 않고, 응답에는 이름·나이·소개·보이스·원본 사진이 없다.
// 성별·국적은 블러 너머로도 보이는 수준의 정보라 그대로 둔다.
function toLockedCard(row: any, blurredUrl: string | undefined, id: string): Record<string, unknown> {
  const mask = (s: string | null | undefined, max: number) =>
    s ? '•'.repeat(Math.min(Math.max(s.length, 2), max)) : null;
  return {
    id,
    locked: true,
    display_name: mask(row.display_name, 8) ?? '••••',
    birth_date: '2000-01-01',
    gender: row.gender,
    nationality: row.nationality,
    language: row.language,
    voice_intro: mask(row.voice_intro, 60),
    voice_intro_audio_url: null,
    interests: [],
    photos: blurredUrl ? [blurredUrl] : [],
    photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
  };
}

function monetizationOff(res: Response): boolean {
  if (env.monetization.enabled) return false;
  res.status(403).json({ error: 'Monetization is disabled', code: 'monetization_disabled' });
  return true;
}

// 광고 보상 하루 한도의 "하루" — 사용자 휴대폰 시간대의 새벽 5시 기준 (플레이리스트와 같다). 광고 콜백(SSV)은 앱이 실어 보낸
// custom_data, quota 는 tz_offset_minutes 로 받는다. 없거나 이상하면(옛 앱) KST.
// ponytail: 시간대를 동쪽으로 바꾸면 그날 본 광고가 '오늘' 밖으로 빠져 하루 한도만큼 더 볼 수 있다.
// 끝까지 본 광고라 허용 — 막으려면 플레이리스트처럼 그날 첫 광고 때 끝나는 시각을 저장한다.
export function adTzOffset(raw: unknown): number {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return -540;
  const n = Number(raw);
  return n >= -840 && n <= 840 ? n : -540;
}

export async function adStarsRemainingToday(userId: string, tzOffsetMinutes = -540): Promise<number> {
  const granted = await sumLedger(userId, 'ad', computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes).fromIso);
  return Math.max(0, AD_REWARD_DAILY_MAX - Math.floor(granted / AD_REWARD_STARS));
}

// 별사탕 잔액·받은 좋아요 무료 카드 타이머·광고 남은 횟수. 두 탭 헤더와 모달이 공유한다.
router.get('/quota', async (req: AuthRequest, res: Response) => {
  res.json({
    monetization_enabled: env.monetization.enabled,
    ...(env.monetization.enabled
      ? await getMonetizationQuota(req.userId!, adTzOffset(req.query.tz_offset_minutes))
      : {}),
  });
});

// quota 응답의 유료화 필드 — 별사탕 잔액, 받은 좋아요 무료 카드 타이머, 광고 남은 횟수.
async function getMonetizationQuota(userId: string, tzOffsetMinutes: number) {
  const [stars, nextFreeRevealAt, adsRemaining] = await Promise.all([
    getStarBalance(userId),
    getNextFreeRevealAt(userId),
    adStarsRemainingToday(userId, tzOffsetMinutes),
  ]);
  return {
    stars: { free: stars.free, paid: stars.paid, total: stars.free + stars.paid },
    next_free_reveal_at: nextFreeRevealAt,
    ads_remaining: adsRemaining,
  };
}

// ── 탐색 플레이리스트 (mig 063) ─────────────────────────────────────
// 하루 3개(사용자 로컬 날짜). 처음 여는 1개는 무료, 나머지는 장수 비례 별사탕
// (유료화 OFF 면 1개만 고를 수 있다). 여는 순간 점수순 다음 최대 10명을 고정한다.
// 이름·커버는 FE 장식이라 어느 칸을 먼저 열든 같은 상위 10명이 들어간다.
// 화면에 나온 카드는 FE 가 처음 볼 때 seen 으로 기록한다. 다음 날 처음 조회할 때 본 카드
// 중 대화 신청(like) 안 한 카드만 pass 로 기록하고 지난 플레이리스트를 지운다 — 안 본
// 카드의 사람은 다시 후보로 돌아간다. 남아 있는 행은 항상 "아직 pass 처리 전" 이다.

const PLAYLIST_COUNT = 3;

// 끝난 플레이리스트에서 본 카드를 pass 로 기록하고 지운다. 실패하면 지우지 않고
// 다음 조회에서 다시 시도한다 — 그동안은 플레이리스트 행이 그 사람들을 후보에서 뺀다.
async function finalizePastPlaylists(userId: string): Promise<void> {
  const { data: old, error } = await supabase
    .from('discover_playlists')
    .select('id')
    .eq('user_id', userId)
    .lte('expires_at', new Date().toISOString());
  if (error) {
    console.error('[playlists] finalize lookup failed:', error.message);
    return;
  }
  if (!old || old.length === 0) return;
  const oldIds = old.map((p: any) => p.id as number);

  const { data: items, error: itemsErr } = await supabase
    .from('discover_playlist_items')
    .select('candidate_id')
    .in('playlist_id', oldIds)
    .eq('seen', true);
  if (itemsErr) {
    console.error('[playlists] finalize items failed:', itemsErr.message);
    return;
  }
  const seenIds = [...new Set((items ?? []).map((i: any) => i.candidate_id as string))];
  // 받은 인사 탭에서 열어 둔 사람은 넘김으로 기록하지 않는다 — 기록하면 그 탭에서 영영 빠진다
  // (공개와 플레이리스트 열기가 거의 동시에 일어나 두 곳에 함께 든 경우).
  const { data: opened, error: openedErr } =
    seenIds.length > 0
      ? await supabase.from('like_reveals').select('liker_id').eq('viewer_id', userId).in('liker_id', seenIds)
      : { data: [], error: null };
  if (openedErr) {
    console.error('[playlists] finalize reveals failed:', openedErr.message);
    return;
  }
  const openedSet = new Set((opened ?? []).map((r: any) => r.liker_id as string));
  const ids = seenIds.filter((id) => !openedSet.has(id));

  if (ids.length > 0) {
    const { data: existing, error: existingErr } = await supabase
      .from('swipes')
      .select('swiped_id, reset_at, direction, pass_count')
      .eq('swiper_id', userId)
      .in('swiped_id', ids);
    if (existingErr) {
      console.error('[playlists] finalize swipes failed:', existingErr.message);
      return;
    }
    const has = new Map((existing ?? []).map((r: any) => [r.swiped_id as string, r]));
    const missing = ids.filter((id) => !has.has(id));
    // 다시보기(reset_at)로 풀에 돌아왔던 사람은 기존 행을 다시 pass 로 되돌린다.
    const recycled = ids.filter((id) => has.get(id)?.reset_at);
    // 넘겼던 카드를 다시 보고 또 넘겼다 — 넘긴 시각을 지금으로, 넘긴 횟수를 +1 (다음 대기 기간이
    // 두 배로 늘고 다시 보기 순서에서 더 깎인다). 횟수별로 묶어 갱신한다.
    const againByCount = new Map<number, string[]>();
    for (const id of ids) {
      const row = has.get(id);
      if (!row || row.reset_at || row.direction !== 'pass') continue;
      const n = (row.pass_count as number | null) ?? 1;
      againByCount.set(n, [...(againByCount.get(n) ?? []), id]);
    }
    const pass = { direction: 'pass', source: 'playlist' };
    const [insertResult, updateResult, againResult] = await Promise.all([
      missing.length > 0
        ? supabase
            .from('swipes')
            .upsert(
              missing.map((swiped_id) => ({ swiper_id: userId, swiped_id, ...pass })),
              { onConflict: 'swiper_id,swiped_id', ignoreDuplicates: true },
            )
        : Promise.resolve({ error: null }),
      recycled.length > 0
        ? supabase
            .from('swipes')
            .update({ ...pass, reset_at: null })
            .eq('swiper_id', userId)
            .in('swiped_id', recycled)
        : Promise.resolve({ error: null }),
      Promise.all(
        [...againByCount].map(([n, list]) =>
          supabase
            .from('swipes')
            .update({ created_at: new Date().toISOString(), pass_count: n + 1 })
            .eq('swiper_id', userId)
            .in('swiped_id', list),
        ),
      ).then((rs) => rs.find((r) => r.error) ?? { error: null }),
    ]);
    const finalizeErr = insertResult.error ?? updateResult.error ?? againResult.error;
    if (finalizeErr) {
      console.error('[playlists] finalize pass failed:', finalizeErr.message);
      return;
    }
  }

  const { error: deleteErr } = await supabase.from('discover_playlists').delete().in('id', oldIds);
  if (deleteErr) console.error('[playlists] finalize delete failed:', deleteErr.message);
}

// 오늘 플레이리스트 = 아직 끝나지 않은 것 (mig 068). 끝나는 시각은 그날 처음 열 때의 휴대폰
// 시간대로 정해 저장한다 — 요청마다 시간대로 다시 계산하면 시간대가 바뀐 순간(여행·설정)
// 연 플레이리스트가 초기화 전에 다시 잠기거나 일찍 초기화된다.
async function getTodayPlaylists(userId: string) {
  const { data, error } = await supabase
    .from('discover_playlists')
    .select('id, idx, day, expires_at')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString());
  if (error) throw new Error(`discover_playlists: ${error.message}`);
  return (data ?? []) as { id: number; idx: number; day: string; expires_at: string }[];
}

// 플레이리스트에 고정된 카드. 그사이 탈퇴·정지·숨김·차단된 사람과 사진이 없어진 사람은
// 조용히 뺀다. requested = 이미 대화 신청함.
async function loadPlaylistCards(userId: string, playlistId: number): Promise<Record<string, unknown>[]> {
  const { data: items, error } = await supabase
    .from('discover_playlist_items')
    .select('candidate_id, position')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true });
  if (error) throw new Error(`discover_playlist_items: ${error.message}`);
  const ids = (items ?? []).map((i: any) => i.candidate_id as string);
  if (ids.length === 0) return [];

  const [viewerResult, profilesResult, blocksResult, likedResult, likedYouResult] = await Promise.all([
    supabase.from('profiles').select('language').eq('id', userId).single(),
    supabase
      .from('profiles')
      .select('id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests')
      .in('id', ids)
      .eq('is_active', true)
      .is('frozen_at', null),
    supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    supabase.from('swipes').select('swiped_id').eq('swiper_id', userId).eq('direction', 'like').in('swiped_id', ids),
    supabase.from('swipes').select('swiper_id').eq('swiped_id', userId).eq('direction', 'like').in('swiper_id', ids),
  ]);
  const failed = [profilesResult, blocksResult, likedResult, likedYouResult].find((r) => r.error);
  if (failed?.error) throw new Error(`playlist cards: ${failed.error.message}`);

  const slot = pickViewerSlot(viewerResult.data?.language as string | null);
  const blocked = new Set(
    (blocksResult.data ?? []).map((b: any) => (b.blocker_id === userId ? b.blocked_id : b.blocker_id) as string),
  );
  const requested = new Set((likedResult.data ?? []).map((r: any) => r.swiped_id as string));
  const likedYou = new Set((likedYouResult.data ?? []).map((r: any) => r.swiper_id as string));
  const rows = new Map((profilesResult.data ?? []).map((p: any) => [p.id as string, p]));
  const photos = await fetchReadyPhotosByUser(ids, 'playlist');

  const cards = await Promise.all(
    ids.map(async (id) => {
      let card: Record<string, unknown> | null;
      if (isCampaignBot(id)) card = await buildCampaignBotCard(slot);
      else {
        const row = rows.get(id);
        if (!row || blocked.has(id) || env.discover.hiddenUserIds.includes(id)) return null;
        if ((photos.get(id) ?? []).length === 0) return null;
        card = await toDiscoverCard(row, photos, slot);
      }
      if (!card) return null;
      return {
        ...card,
        requested: requested.has(id),
        // 유료화 OFF 의 좋아요 한도 사전 게이트용 (GET / 와 같은 의미). ON 에선 받은 좋아요
        // 공개를 우회하므로 내보내지 않는다.
        ...(env.monetization.enabled ? {} : { liked_you: likedYou.has(id) || isCampaignBot(id) }),
      };
    }),
  );
  return cards.filter((c): c is NonNullable<typeof c> => c !== null);
}

// 플레이리스트에 들어간 뒤 나간 사람 — 탈퇴·정지·숨김, 상대가 나를 차단, 보여 줄 사진 없음.
// 이 자리는 새 후보로 채운다. 내가 차단·신고한 사람은 넣지 않는다 — 내가 고른 것이라,
// 넣으면 마음에 안 드는 카드를 차단해 새 카드로 바꿔 산 것보다 많이 볼 수 있다.
async function goneMemberIds(userId: string, ids: string[]): Promise<Set<string>> {
  const gone = new Set<string>();
  if (ids.length === 0) return gone;
  const [profilesResult, blockedMeResult, photos] = await Promise.all([
    supabase.from('profiles').select('id, is_active, frozen_at').in('id', ids),
    supabase.from('blocks').select('blocker_id').eq('blocked_id', userId).in('blocker_id', ids),
    fetchReadyPhotosByUser(ids, 'playlist-gone'),
  ]);
  if (profilesResult.error || blockedMeResult.error) {
    // 못 세면 채우지 않는 쪽(나간 사람 없음)으로 — 잘못 채워 칸이 넘치는 것보다 낫다.
    console.error('[playlists] gone check failed:', (profilesResult.error ?? blockedMeResult.error)!.message);
    return gone;
  }
  const profiles = new Map((profilesResult.data ?? []).map((p: any) => [p.id as string, p]));
  const blockedMe = new Set((blockedMeResult.data ?? []).map((b: any) => b.blocker_id as string));
  for (const id of ids) {
    const p = profiles.get(id);
    if (
      !p?.is_active ||
      p.frozen_at ||
      env.discover.hiddenUserIds.includes(id) ||
      blockedMe.has(id) ||
      (photos.get(id) ?? []).length === 0
    ) {
      gone.add(id);
    }
  }
  return gone;
}

// 카드 화면에서 나간 사람에게 인사한 순간 그 한 자리를 새 후보로 메워 응답에 실어 보낸다
// (화면을 나갔다 오지 않아도 된다). 한 자리만 — 같은 화면에 인사하지 않은 나간 사람이 더
// 있어도 그 카드는 화면에 남아 있으므로, 그 몫은 LP 선택 화면(GET /playlists)에서 채운다.
// 채운 후보 id 를 돌려준다 (후보가 없거나 꽉 찼으면 빈 배열).
async function refillPlaylist(userId: string, playlistId: number): Promise<string[]> {
  const { data: items, error } = await supabase
    .from('discover_playlist_items')
    .select('candidate_id, position')
    .eq('playlist_id', playlistId);
  if (error) throw new Error(`discover_playlist_items: ${error.message}`);
  const members = (items ?? [])
    .map((i: any) => i.candidate_id as string)
    .filter((id) => id !== env.campaign.botUserId);
  const gone = await goneMemberIds(userId, members);
  const room = Math.min(1, CARD_RESET_AMOUNT - members.filter((id) => !gone.has(id)).length);
  if (room <= 0) return [];

  // 인사 안 한 사람부터 — 칸당 인사한 사람 상한은 열 때 섞은 몫으로 충분하다. 인사 안 한
  // 사람이 없으면 인사한 사람, 그것도 없으면 넘겼던 사람(오래된 순)으로라도 채운다.
  const pool = await loadDiscoverPool(userId);
  if ('error' in pool) throw new Error(`discover pool: ${pool.error}`);
  const add = fillOrder(pool.scored).slice(0, room).map((r) => r.id);
  if (add.length === 0) return [];

  const last = Math.max(0, ...(items ?? []).map((i: any) => i.position as number));
  const { error: upsertErr } = await supabase.from('discover_playlist_items').upsert(
    add.map((candidateId, i) => ({
      playlist_id: playlistId,
      user_id: userId,
      candidate_id: candidateId,
      position: last + i + 1,
    })),
    { onConflict: 'playlist_id,candidate_id', ignoreDuplicates: true },
  );
  if (upsertErr) throw new Error(`playlist refill: ${upsertErr.message}`);
  return add;
}

// 오늘 연 칸이 덜 찼으면(열 때 후보가 모자랐음) 그 뒤 생긴 후보를 먼저 채운다 — 먼저 연 칸
// (id 작은 쪽)부터 칸당 최대 CARD_RESET_AMOUNT 명. 후보가 띄엄띄엄 생길 때 1명짜리 칸이
// 여러 개로 쪼개져 하루 3칸을 낭비하지 않게 한다. rest = 채우고 남은 후보 (새 칸 몫).
export function allocatePlaylistTopUp(
  playlistIds: number[],
  counts: Map<number, number>,
  candidates: string[],
): { fills: { playlistId: number; add: string[] }[]; rest: string[] } {
  let rest = candidates;
  const fills: { playlistId: number; add: string[] }[] = [];
  for (const id of [...playlistIds].sort((a, b) => a - b)) {
    const room = CARD_RESET_AMOUNT - (counts.get(id) ?? 0);
    if (room <= 0 || rest.length === 0) continue;
    fills.push({ playlistId: id, add: rest.slice(0, room) });
    rest = rest.slice(room);
  }
  return { fills, rest };
}

// 오늘의 플레이리스트 3칸. 안 연 칸의 price 는 지금 열면 낼 별사탕 (0 = 무료).
router.get('/playlists', validateQuery(quotaQuerySchema), async (req: AuthRequest, res: Response) => {
  await finalizePastPlaylists(req.userId!);

  const [today, pool] = await Promise.all([
    getTodayPlaylists(req.userId!),
    loadDiscoverPool(req.userId!),
  ]);
  if ('error' in pool) {
    res.status(pool.status).json({ error: pool.error });
    return;
  }

  // 칸별 인원(캠페인 봇·나간 사람 제외)과 마지막 순서. 열고 나서 탈퇴·정지 등으로 나간
  // 사람은 세지 않아, 그 자리를 아래 채우기가 새 후보로 메운다 (산 만큼 카드를 본다).
  const counts = new Map<number, number>();
  const lastPosition = new Map<number, number>();
  if (today.length > 0) {
    const { data: items, error } = await supabase
      .from('discover_playlist_items')
      .select('playlist_id, candidate_id, position')
      .in('playlist_id', today.map((p) => p.id));
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    const gone = await goneMemberIds(
      req.userId!,
      (items ?? []).map((i: any) => i.candidate_id as string).filter((id) => id !== env.campaign.botUserId),
    );
    for (const i of items ?? []) {
      lastPosition.set(i.playlist_id, Math.max(lastPosition.get(i.playlist_id) ?? 0, i.position));
      if (i.candidate_id !== env.campaign.botUserId && !gone.has(i.candidate_id)) {
        counts.set(i.playlist_id, (counts.get(i.playlist_id) ?? 0) + 1);
      }
    }
  }

  // 같은 요청이 겹쳐도 PK 중복은 무시된다.
  // ponytail: 동시에 다른 칸을 여는 요청과 겹치면 한 사람이 두 칸에 들어갈 수 있다 — 드물어 허용.
  // 덜 찬 칸은 새 카드(인사 안 한 사람 → 인사한 사람)부터, 모자라면 넘겼던 사람으로 마저 채운다.
  // ponytail: 별사탕 칸도 넘겼던 사람으로 채워질 수 있다 — 별사탕 칸은 새 카드 10장으로만 열려
  // 나간 사람 몫만 비고, 새 카드가 바닥났을 때뿐이다.
  const { fills } = allocatePlaylistTopUp(
    today.map((p) => p.id),
    counts,
    fillOrder(pool.scored).map((r) => r.id),
  );
  const filled = new Set(fills.flatMap((f) => f.add));
  const rest = pool.scored.filter((r) => !filled.has(r.id));
  for (const { playlistId, add } of fills) {
    const start = lastPosition.get(playlistId) ?? 0;
    const { error } = await supabase.from('discover_playlist_items').upsert(
      add.map((candidateId, i) => ({
        playlist_id: playlistId,
        user_id: req.userId!,
        candidate_id: candidateId,
        position: start + i + 1,
      })),
      { onConflict: 'playlist_id,candidate_id', ignoreDuplicates: true },
    );
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    counts.set(playlistId, (counts.get(playlistId) ?? 0) + add.length);
  }

  // 지금 새 칸을 열면 받을 장수 — 열기(POST /open)와 같은 고르기라 expected_count 와 맞는다.
  // 첫 칸은 무료(새 카드 + 다시 보기), 그 뒤 칸은 별사탕(새 카드 10장일 때만).
  const free = today.length === 0;
  const freePicks = free ? pickFreePlaylist(rest) : [];
  const available = free ? freePicks.length : pickPaidPlaylist(rest).length;
  // 열 수 있는 별사탕 칸 수 — 무료 칸을 열고 남을 새 카드로 10장씩.
  const freshLeft = rest.filter((r) => !r.passed_at && !freePicks.includes(r.id)).length;
  const paidLps = Math.min(PLAYLIST_COUNT - today.length - (free ? 1 : 0), Math.floor(freshLeft / CARD_RESET_AMOUNT));
  const openableLps = (free && available > 0 ? 1 : 0) + Math.max(0, paidLps);
  const playlists = Array.from({ length: PLAYLIST_COUNT }, (_, idx) => {
    const opened = today.find((p) => p.idx === idx);
    return opened
      ? { idx, opened: true, count: counts.get(opened.id) ?? 0 }
      : { idx, opened: false, price: free ? 0 : cardResetCost(available) };
  });
  res.json({
    available_count: available,
    // 초기화 시각 — 연 칸이 있으면 그 칸이 끝나는 시각, 없으면 지금 열면 끝날 시각(휴대폰
    // 시간대 다음 새벽 5시). 앱의 "초기화까지" 와 초기화 처리가 이 값을 쓴다 (시간대가 바뀐 날에도 서버와 일치).
    resets_at:
      today[0]?.expires_at ??
      computeLocalDayRangeUtc(Date.now(), req.query.tz_offset_minutes as unknown as number).toIso,
    // FE 는 ceil(candidate_count / CARD_RESET_AMOUNT) 로 보여줄 안 연 LP 수를 정한다 — 남은 인원이
    // 아니라 열 수 있는 칸 수 × 칸 크기로 보낸다 (별사탕 칸은 새 카드 10장이 남아야 보인다).
    candidate_count: openableLps * CARD_RESET_AMOUNT,
    // 유료화 OFF 는 하루 1개 — 고른 뒤엔 그 칸만 보여준다.
    playlists: !env.monetization.enabled && !free ? playlists.filter((p) => p.opened) : playlists,
  });
});

router.get('/playlists/:idx', validateQuery(quotaQuerySchema), async (req: AuthRequest, res: Response) => {
  const params = playlistParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: 'Invalid playlist' });
    return;
  }
  const playlist = (await getTodayPlaylists(req.userId!)).find((p) => p.idx === params.data.idx);
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not opened', code: 'playlist_not_opened' });
    return;
  }
  res.json({ idx: playlist.idx, cards: await loadPlaylistCards(req.userId!, playlist.id) });
});

// 처음 화면에 나온 카드 기록. 같은 카드를 다시 보내도 결과가 같다 (앱이 화면을 나갈 때
// 실패한 기록을 한 번 더 보낸다).
router.post(
  '/playlists/:idx/seen',
  validateQuery(quotaQuerySchema),
  validateBody(playlistSeenBodySchema),
  async (req: AuthRequest, res: Response) => {
    const params = playlistParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid playlist' });
      return;
    }
    const playlist = (await getTodayPlaylists(req.userId!)).find((p) => p.idx === params.data.idx);
    if (!playlist) {
      res.status(404).json({ error: 'Playlist not opened', code: 'playlist_not_opened' });
      return;
    }
    const { error } = await supabase
      .from('discover_playlist_items')
      .update({ seen: true })
      .eq('playlist_id', playlist.id)
      .in('candidate_id', req.body.candidate_ids);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  },
);

// 플레이리스트 열기. 무료 칸이 아니면 차감 전에 곡 수를 다시 세어, 사용자가 확인한
// 곡 수(expected_count)와 다르면(적든 많든) 차감 없이 409 cards_changed + 현재 곡 수 —
// 가격이 곡 수에 비례해, 늘었을 때 그냥 열면 확인한 것보다 많이 차감된다.
router.post(
  '/playlists/:idx/open',
  requireNotFrozen,
  validateQuery(quotaQuerySchema),
  validateBody(playlistOpenBodySchema),
  async (req: AuthRequest, res: Response) => {
    const params = playlistParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid playlist' });
      return;
    }
    const idx = params.data.idx;
    const userId = req.userId!;
    const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
    await finalizePastPlaylists(userId);

    const today = await getTodayPlaylists(userId);
    // 그날 처음 여는 칸이면 지금 휴대폰 시간대의 다음 새벽 5시에 끝나고, 이미 연 칸이 있으면 그 칸과
    // 함께 끝난다 (세 칸이 같이 초기화).
    const { localDate, toIso } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
    const day = today[0]?.day ?? localDate;
    const expiresAt = today[0]?.expires_at ?? toIso;
    const opened = today.find((p) => p.idx === idx);
    if (opened) {
      res.json({ idx, cards: await loadPlaylistCards(userId, opened.id) });
      return;
    }

    const pool = await loadDiscoverPool(userId);
    if ('error' in pool) {
      res.status(pool.status).json({ error: pool.error });
      return;
    }
    const first = today.length === 0;
    // 첫 칸은 무료(새 카드 + 다시 보기), 그 뒤 칸은 별사탕(새 카드 10장일 때만).
    const picks = first ? pickFreePlaylist(pool.scored) : pickPaidPlaylist(pool.scored);
    const expected = req.body.expected_count as number | undefined;
    if (picks.length === 0 || (expected !== undefined && picks.length !== expected)) {
      res.status(409).json({ error: 'Available cards changed', code: 'cards_changed', available_count: picks.length });
      return;
    }

    // 유료화 OFF 는 하루 1개다 (FE 도 연 칸 하나만 보여준다).
    if (!env.monetization.enabled && !first) {
      res.status(409).json({ error: 'Playlist already chosen today', code: 'playlist_limit' });
      return;
    }
    const stars = first ? 0 : cardResetCost(picks.length);
    // 캠페인 봇은 그날 첫 플레이리스트 맨 뒤에 붙인다 (카드 한도·곡 수 가격과 무관).
    if (first && !pool.botAlreadyHandled && env.campaign.postUrls[pool.slot]) {
      picks.push(env.campaign.botUserId!);
    }

    const { data: playlistId, error } = await supabase.rpc('open_playlist', {
      p_user: userId,
      p_day: day,
      p_expires: expiresAt,
      p_idx: idx,
      p_stars: stars,
      p_first: env.monetization.enabled && first,
      p_candidates: picks,
    });
    if (error) {
      if (error.message.includes('insufficient_stars')) {
        res.status(402).json({ error: 'Not enough stars', code: 'insufficient_stars' });
        return;
      }
      // 고른 사람 일부가 그사이 다른 칸에 들어갔다(두 기기에서 거의 동시에 연 경우) — mig 066 이
      // 차감까지 취소했다. 인원이 바뀐 것과 같으니 다시 묻는다.
      if (error.message.includes('cards_changed')) {
        res.status(409).json({ error: 'Available cards changed', code: 'cards_changed' });
        return;
      }
      // 같은 칸을 동시에 연 경합 — 먼저 열린 쪽을 돌려준다 (이쪽 차감은 함께 취소됨).
      // 무료 칸을 동시에 두 번 열면 not_first 로 오므로 같은 칸이 열렸는지 먼저 본다.
      if (error.code === '23505' || error.message.includes('not_first')) {
        const again = (await getTodayPlaylists(userId)).find((p) => p.idx === idx);
        if (again) {
          res.json({ idx, cards: await loadPlaylistCards(userId, again.id) });
          return;
        }
      }
      // 그사이 다른 기기에서 오늘 첫 플레이리스트(다른 칸)를 열었다 — 무료가 아니게 됐다.
      if (error.message.includes('not_first')) {
        res.status(409).json({ error: 'Playlist price changed', code: 'playlist_changed' });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ idx, cards: await loadPlaylistCards(userId, playlistId as number) });
  },
);

// 상대와 정상적으로 상호작용할 수 없는 상태인가 — 탈퇴·정지·숨김, 또는 어느 쪽이든 차단.
// 카드를 받은 뒤에 이렇게 바뀔 수 있어(받아둔 덱) 차감·기록·매치 전에 확인한다.
// 사유는 응답에 넣지 않는다 — 차단·정지 여부가 상대에게 드러나면 안 된다.
async function isUserUnavailable(viewerId: string, targetId: string): Promise<boolean> {
  if (env.discover.hiddenUserIds.includes(targetId)) return true;
  const [profileResult, blockResult] = await Promise.all([
    supabase.from('profiles').select('is_active, frozen_at').eq('id', targetId).maybeSingle(),
    supabase
      .from('blocks')
      .select('blocker_id')
      .or(
        `and(blocker_id.eq.${viewerId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${viewerId})`,
      )
      .limit(1),
  ]);
  if (profileResult.error) throw new Error(`profiles: ${profileResult.error.message}`);
  if (blockResult.error) throw new Error(`blocks: ${blockResult.error.message}`);
  const profile = profileResult.data;
  return !profile?.is_active || !!profile.frozen_at || (blockResult.data ?? []).length > 0;
}

// 내가 상대를 차단했는가 (신고도 자동 차단). 실패하면 차단으로 본다 — 환불을 막는 쪽이 안전.
async function viewerBlocked(viewerId: string, targetId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('blocks')
    .select('blocker_id')
    .eq('blocker_id', viewerId)
    .eq('blocked_id', targetId)
    .limit(1);
  if (error) {
    console.error('[swipe] viewer block check failed:', error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

// 잠긴 받은 좋아요 카드 1명 공개 — 별사탕 REVEAL_STAR_COST 개, 또는 free=true 면 무료
// 카드(24시간에 1장). 무료 카드는 FE 가 잠긴 카드를 화면에 띄우는 순간 부른다 — 내용을
// 공개 기록과 함께 내주므로 "봤다" 신고를 빼먹는 변조 앱도 무료로 볼 수 없다.
// 상대가 그사이 탈퇴·정지·차단됐으면 차감 없이 revealed=false.
router.post(
  '/likes-received/reveal',
  requireNotFrozen,
  validateBody(revealBodySchema),
  async (req: AuthRequest, res: Response) => {
    if (monetizationOff(res)) return;
    const { liker_id, free } = req.body;
    const me = req.userId!;

    const [likeResult, revealResult, answeredResult] = await Promise.all([
      supabase
        .from('swipes')
        .select('id')
        .eq('swiper_id', liker_id)
        .eq('swiped_id', me)
        .eq('direction', 'like')
        .maybeSingle(),
      supabase.from('like_reveals').select('liker_id').eq('viewer_id', me).eq('liker_id', liker_id).maybeSingle(),
      // 내가 이미 응답한 상대 (탐색에서 넘김·대화 신청) — 받은 인사 목록에서 빠지는 사람이라
      // 열어도 볼 수 없다.
      supabase.from('swipes').select('id').eq('swiper_id', me).eq('swiped_id', liker_id).is('reset_at', null).limit(1),
    ]);
    const lookupErr = likeResult.error ?? revealResult.error ?? answeredResult.error;
    if (lookupErr) {
      res.status(500).json({ error: lookupErr.message });
      return;
    }
    if (!likeResult.data || (await isUserUnavailable(me, liker_id))) {
      res.json({ revealed: false });
      return;
    }
    if (revealResult.data) {
      res.json({ revealed: true });
      return;
    }
    // 갱신 전 목록에서 연 경우 — 차감 없이 거절하고 앱이 목록을 다시 받는다 (아래 플레이리스트와 같은 처리).
    if ((answeredResult.data ?? []).length > 0) {
      res.status(409).json({ error: 'Card changed', code: 'card_changed' });
      return;
    }
    // 오늘 탐색 플레이리스트에 든 사람은 받은 인사 탭에서 숨겨진다 — 갱신 전 화면에서 열면 연
    // 카드가 숨겨지고, 탐색에서 지나치면 초기화 때 넘김 처리돼 별사탕을 쓰고도 영영 못 본다. 차감 없이
    // 거절한다 (앱은 목록을 다시 받는다). 이유는 말하지 않는다 — 플레이리스트의 그 사람이 나에게
    // 인사했다는 유료 정보가 드러나지 않게.
    const { data: inPlaylist, error: playlistErr } = await supabase
      .from('discover_playlist_items')
      .select('candidate_id')
      .eq('user_id', me)
      .eq('candidate_id', liker_id)
      .limit(1);
    if (playlistErr) {
      res.status(500).json({ error: playlistErr.message });
      return;
    }
    if ((inPlaylist ?? []).length > 0) {
      res.status(409).json({ error: 'Card changed', code: 'card_changed' });
      return;
    }

    if (free) {
      // 무료 카드는 고정된 다음 무료 카드(맨 앞 잠긴 카드)만 — 앱은 이 경로를 쓰지 않고 목록 조회가
      // 자동으로 연다. 조작된 앱이 원하는 카드를 고르거나 동시에 여러 장을 열지 못하게 목록 조회와
      // 같은 claimFreeReveal 로 한 장만 남긴다.
      const { data: pin, error: pinErr } = await supabase
        .from('like_card_pins')
        .select('liker_id')
        .eq('viewer_id', me)
        .maybeSingle();
      if (pinErr) {
        res.status(500).json({ error: pinErr.message });
        return;
      }
      if (pin?.liker_id !== liker_id || (await getNextFreeRevealAt(me)) !== null) {
        res.status(409).json({ error: 'No free card now', code: 'free_unavailable' });
        return;
      }
      const won = await claimFreeReveal(me, liker_id);
      if (won === null) {
        res.status(500).json({ error: 'free reveal failed' });
        return;
      }
      if (won !== liker_id) {
        res.status(409).json({ error: 'No free card now', code: 'free_unavailable' });
        return;
      }
      res.json({ revealed: true });
      return;
    }

    // 연타로 이미 공개됐으면 차감까지 함께 취소된다 — 어느 쪽이든 공개된 상태.
    try {
      await revealLike(me, liker_id, REVEAL_STAR_COST);
    } catch (e) {
      if (e instanceof InsufficientStarsError) {
        res.status(402).json({ error: 'Not enough stars', code: 'insufficient_stars' });
        return;
      }
      throw e;
    }

    res.json({ revealed: true });
  },
);

// 스와이프
//
// message-moderation-v1 (PR2): freeze 사용자의 like 시도를 차단.
// GET /api/discover 와 GET /likes-received 는 이미 SQL 단계에서 `.eq('is_active', true)`
// 필터로 freeze 사용자를 다른 viewer 의 노출 풀에서 제거한다 (회귀 매트릭스 #1, #2).
// 본 POST 만 가드 — 본인의 능동 swipe 행위를 막아 reciprocal like 매치 생성 경로
// 자체를 차단.
router.post('/swipe', requireNotFrozen, validateQuery(swipeQuerySchema), validateBody(swipeBodySchema), async (req: AuthRequest, res: Response) => {
  const { swiped_id, direction } = req.body;
  const monetized = env.monetization.enabled;

  // 받아둔 카드의 상대가 그사이 탈퇴·정지·차단됐으면 아무것도 기록·차감하지 않고 넘긴다.
  // 무료 카드도 쓰지 않고 매치도 만들지 않는다. 오류가 아니라 카드가 자연스럽게 지나간다.
  if (!isCampaignBot(swiped_id) && (await isUserUnavailable(req.userId!, swiped_id))) {
    // 공개한 받은 좋아요 카드에 좋아요 — 매치를 기대하고 쓴 것을 돌려준다: 별사탕으로 열었으면
    // 별사탕, 무료 카드로 열었으면 무료 카드(24시간 타이머). 패스는 사용자가 넘기기로 한 것이라
    // 돌려주지 않는다. 내가 차단(=신고)한 상대도 돌려주지 않는다 — 열어 보고 마음에 안 들면
    // 신고한 뒤 인사를 보내 공개 비용을 되찾는 우회가 된다.
    const refund =
      monetized &&
      req.body.source === 'likes' &&
      direction === 'like' &&
      !(await viewerBlocked(req.userId!, swiped_id))
        ? await refundLikeReveal(req.userId!, swiped_id)
        : { stars: 0, freeRestored: false };
    // 플레이리스트 카드였으면 그 자리를 바로 새 후보로 채워 카드를 함께 보낸다 — 산 만큼 본다.
    // 실패해도 건너뛰기 자체는 성공이다 (다음에 탐색 탭을 열 때 다시 채운다).
    let replacements: Record<string, unknown>[] = [];
    if (req.body.source === 'playlist') {
      try {
        const today = await getTodayPlaylists(req.userId!);
        const { data: holder } = today.length
          ? await supabase
              .from('discover_playlist_items')
              .select('playlist_id')
              .in('playlist_id', today.map((p) => p.id))
              .eq('candidate_id', swiped_id)
              .limit(1)
          : { data: [] };
        const playlistId = (holder ?? [])[0]?.playlist_id as number | undefined;
        if (playlistId !== undefined) {
          const added = await refillPlaylist(req.userId!, playlistId);
          if (added.length > 0) {
            const cards = await loadPlaylistCards(req.userId!, playlistId);
            replacements = cards.filter((c) => added.includes(c.id as string));
          }
        }
      } catch (e) {
        console.error('[swipe] playlist refill failed:', (e as Error).message);
      }
    }
    res.json({
      direction,
      match: null,
      skipped: true,
      ...(refund.stars > 0 ? { refunded_stars: refund.stars } : {}),
      ...(refund.freeRestored ? { free_restored: true } : {}),
      ...(replacements.length > 0 ? { replacements } : {}),
    });
    return;
  }

  // 탐색의 대화 신청은 플레이리스트가 곧 카드 한도다 — 오늘 내 플레이리스트에 든
  // 상대인지 확인한다. 안 그러면 아무 후보에게나 보낼 수 있고, 초기화 시각이 지난 플레이리스트
  // (다음 조회 때 pass 처리될 카드)에도 보낼 수 있다.
  if (req.body.source === 'playlist') {
    const today = await getTodayPlaylists(req.userId!);
    const { data: member, error: memberErr } =
      today.length > 0
        ? await supabase
            .from('discover_playlist_items')
            .select('candidate_id')
            .in('playlist_id', today.map((p) => p.id))
            .eq('candidate_id', swiped_id)
            .limit(1)
        : { data: [], error: null };
    if (memberErr) {
      res.status(500).json({ error: memberErr.message });
      return;
    }
    if ((member ?? []).length === 0) {
      res.status(403).json({ error: 'Not in your playlist', code: 'not_in_playlist' });
      return;
    }
  }

  // 0) 기존 스와이프. 예전 다시보기(reset_at)로 풀에 돌아온 사람이면 기존 행을 갱신한다.
  //    그 외 기존 행은 이미 스와이프함 → 409.
  const { data: existing, error: existingErr } = await supabase
    .from('swipes')
    .select('id, reset_at, direction, created_at')
    .eq('swiper_id', req.userId!)
    .eq('swiped_id', swiped_id)
    .maybeSingle();
  if (existingErr) {
    res.status(500).json({ error: existingErr.message });
    return;
  }
  // 오늘 플레이리스트의 '다시 보기' 카드(예전에 넘긴 사람)는 위에서 멤버임을 확인했다 — 그
  // 넘김 기록을 인사로 바꾼다.
  const passedPlaylistCard =
    !!existing && !existing.reset_at && existing.direction === 'pass' && req.body.source === 'playlist';
  if (existing && !existing.reset_at && !passedPlaylistCard) {
    res.status(409).json({ error: 'Already swiped this user' });
    return;
  }
  const recycled = !!existing;

  // 1) reciprocal(=상대가 나를 이미 like) 판정 — 매치 생성과 받은 좋아요 탭 검증에 쓴다.
  //    like 일 때만 조회. silent-success 룰 (CLAUDE.md): PGRST116(no rows)=상대가
  //    아직 like 안 함=정상, 그 외 error 는 가시화. silent 통과 시 reciprocal 매치
  //    trigger 가 안 일어나는 회귀 가능.
  let reciprocal: { id: string } | null = null;
  if (direction === 'like') {
    const { data, error: reciprocalErr } = await supabase
      .from('swipes')
      .select('id')
      .eq('swiper_id', swiped_id)
      .eq('swiped_id', req.userId!)
      .eq('direction', 'like')
      .single();
    if (reciprocalErr && reciprocalErr.code !== 'PGRST116') {
      res.status(500).json({ error: reciprocalErr.message });
      return;
    }
    reciprocal = data ?? null;

    // 캠페인 봇은 스와이프를 하지 않으므로 reciprocal 행이 존재할 수 없다. 봇을
    // like 하면 항상 매치가 성사되도록 여기서 강제한다.
    if (!reciprocal && isCampaignBot(swiped_id)) {
      reciprocal = { id: 'campaign-bot' };
    }
  }

  // 2) 받은 좋아요 탭 대화 신청 (유료화 ON). 클라이언트 주장만 믿지 않고 (상대가 나를
  //    like) AND (공개함) 을 확인한다 — 안 그러면 공개 안 한 상대에게 보내 매치 여부로
  //    누가 날 좋아했는지 알아낼 수 있다. 무료 카드도 화면에 나올 때 공개로 기록된다.
  const source: 'likes' | 'playlist' = req.body.source === 'likes' ? 'likes' : 'playlist';
  if (source === 'likes' && monetized && direction === 'like') {
    const { data: reveal, error: revealErr } = await supabase
      .from('like_reveals')
      .select('liker_id')
      .eq('viewer_id', req.userId!)
      .eq('liker_id', swiped_id)
      .maybeSingle();
    if (revealErr) {
      res.status(500).json({ error: revealErr.message });
      return;
    }
    if (!reciprocal || !reveal) {
      res.status(403).json({ error: 'Like is not revealed', code: 'like_not_revealed' });
      return;
    }
  }

  // 3) 기록. 예전 다시보기 카드는 기존 행 갱신.
  const row = { direction, source };
  // 기존 행 갱신은 읽은 상태 그대로일 때만 — 같은 카드에 동시에 두 번 인사하면 둘 다 갱신에
  // 성공해 매치 알림이 두 번 갔다. 바뀐 행이 없으면 다른 요청이 먼저 처리한 것 (409).
  const { data: updated, error: swipeError } = recycled
    ? await supabase
        .from('swipes')
        .update({ ...row, reset_at: null, created_at: new Date().toISOString() })
        .eq('id', existing!.id)
        .eq('direction', existing!.direction)
        .eq('created_at', existing!.created_at)
        .select('id')
    : await supabase.from('swipes').insert({ swiper_id: req.userId!, swiped_id, ...row }).select('id');

  if (!swipeError && recycled && (updated ?? []).length === 0) {
    res.status(409).json({ error: 'Already swiped this user' });
    return;
  }
  if (swipeError) {
    if (swipeError.code === '23505') {
      res.status(409).json({ error: 'Already swiped this user' });
      return;
    }
    res.status(500).json({ error: swipeError.message });
    return;
  }

  // 4) 매치 생성 — reciprocal 은 위 1)에서 이미 조회됨(재조회 제거). reciprocal 은
  //    like AND 상대 like 존재일 때만 non-null 이므로 별도 direction 체크 불필요.
  let match: { id: string; user1_id: string; user2_id: string } | null = null;
  if (reciprocal) {
    const [user1, user2] = [req.userId!, swiped_id].sort();
      const { data: newMatch, error: matchError } = await supabase
        .from('matches')
        .insert({ user1_id: user1, user2_id: user2 })
        .select()
        .single();

      if (matchError?.code === '23505') {
        // 동시 like로 인한 중복 — 기존 매치 조회. error 가시화 (silent-success
        // 룰): 옛 코드는 existing null 시 match 가 그대로 null 이 되어 사용자가
        // "매치됐는데 안 됨" 응답 받는 회귀가 가능.
        const { data: existing, error: existingErr } = await supabase
          .from('matches')
          .select()
          .eq('user1_id', user1)
          .eq('user2_id', user2)
          .single();
        if (existingErr || !existing) {
          res.status(500).json({
            error: existingErr?.message ?? 'Match concurrency fallback failed',
          });
          return;
        }
        match = existing;
      } else if (!matchError) {
        match = newMatch;
      } else {
        res.status(500).json({ error: matchError.message });
        return;
      }

      // 캠페인 봇 매치 — 자동 안내 메시지 2건. fire-and-forget (TTS 합성이
      // 5~10초 걸리므로 스와이프 응답을 붙잡지 않는다). FE 는 그동안 채팅방에
      // "작성 중" 인디케이터를 띄운다.
      if (match && isCampaignBot(swiped_id)) {
        sendCampaignBotMessages(match.id, req.userId!).catch((err) =>
          console.error('[sendCampaignBotMessages]', err),
        );
      }

      // push-notifications sprint: 매치 성사 시 상대에게 푸시 발송. 인사를 보내 연결시킨 본인은 앱 안의
      // 대화 연결 모달로 이미 알기 때문에 보내지 않는다 (인사는 앱 안에서만 보내므로 본인 알림은 늘 중복).
      // unmatch 후 재match (소프트 삭제 후 23505 fallback) 케이스에도 발송 — 매치 부활도 알림 가치 있음.
      if (match) {
        const matchId = match.id;
        supabase
          .from('profiles')
          .select('display_name')
          .eq('id', req.userId!)
          .maybeSingle()
          .then(({ data: me, error: meErr }) => {
            if (meErr) console.error('[sendPushToUser match] name lookup failed:', meErr.message);
            const myName = (me?.display_name as string | null) ?? '';
            sendPushToUser(swiped_id, {
              type: 'match',
              match_id: matchId,
              matched_user_id: req.userId!,
              matched_name: myName,
            }).catch((err) => console.error('[sendPushToUser match→swiped]', err));
          });
      }
    }

  // 5) 받은 좋아요 푸시 — 매치가 성사되지 않은 like 에만 (성사된 경우는 위 match
  //    푸시가 커버). 익명 문구 + fire-and-forget.
  //    받는 사람의 플레이리스트에 든 사람이면 받은 인사 탭에서 숨겨지므로 지금은 보내지 않고,
  //    그 플레이리스트가 끝난 날 오전 9시로 미뤄 둔다 (sendHeldLikePushes).
  if (direction === 'like' && !reciprocal) {
    const likerId = req.userId!;
    (async () => {
      let hold: string | null = null;
      if (env.monetization.enabled) {
        try {
          hold = await playlistHoldUntil(swiped_id, likerId);
        } catch (e) {
          // 플레이리스트 확인 실패 — 바로 보내면 탭에 없는 거짓 알림일 수 있어 미뤄서 다시 본다.
          console.error('[sendPushToUser like] playlist check failed, deferring:', (e as Error).message);
          return scheduleHeldLikePush(likerId, swiped_id, null);
        }
      }
      if (hold) return scheduleHeldLikePush(likerId, swiped_id, hold);
      let visible: boolean;
      try {
        visible = await isLikeVisibleToReceiver(likerId, swiped_id);
      } catch (e) {
        console.error('[sendPushToUser like] visibility check failed, deferring:', (e as Error).message);
        return scheduleHeldLikePush(likerId, swiped_id, null);
      }
      if (visible) await sendPushToUser(swiped_id, { type: 'like', liker_id: likerId });
    })().catch((err) => console.error('[sendPushToUser like]', err));
  }

  res.json({ direction, match });
});

export default router;
