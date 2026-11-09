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

type Candidate = {
  id: string;
  language: string;
  nationality: string;
  interests: string[];
  photos: string[];
  created_at: string;
};

type Viewer = {
  id: string;
  interests: string[];
};

type ViewerPrefs = {
  preferred_nationalities: string[];
};

// 사전 SQL 필터: 성별/연령만 (디스커버 / 받은좋아요 공용). 언어·국가 선호는
// 티어 정렬 신호로 사용되므로 여기서 IN 필터로 후보를 제거하지 않는다
// (미부합 후보는 하위 티어로 밀려나 노출만 후순위).
export function applyPrefFilters<Q>(query: Q, prefs: any): Q {
  if (!prefs) return query;
  let q: any = query;
  if (prefs.preferred_genders && prefs.preferred_genders.length > 0) {
    q = q.in('gender', prefs.preferred_genders);
  }
  const now = new Date();
  if (prefs.min_age) {
    const maxBirthDate = new Date(now.getFullYear() - prefs.min_age, now.getMonth(), now.getDate())
      .toISOString().split('T')[0];
    q = q.lte('birth_date', maxBirthDate);
  }
  // max_age 가 슬라이더 상한이면 "그 나이 이상 전부" 의미 — FE 라벨이 `40+` 로
  // 표시하므로(haru_FE/src/components/ui/AgeRangeSlider.tsx:106-107) 상한 필터를
  // 걸지 않는다. 안 그러면 41세 이상은 누구의 디스커버에도 안 뜬다(FE 슬라이더가
  // 40 초과를 저장할 수 없어 모든 계정이 max_age=40).
  // 이 값은 haru_FE/src/utils/preferences.ts 의 MAX_AGE 와 동일해야 한다.
  const OPEN_ENDED_MAX_AGE = 40;
  if (prefs.max_age && prefs.max_age < OPEN_ENDED_MAX_AGE) {
    const minBirthDate = new Date(now.getFullYear() - prefs.max_age - 1, now.getMonth(), now.getDate())
      .toISOString().split('T')[0];
    q = q.gte('birth_date', minBirthDate);
  }
  return q as Q;
}

// 결정적 해시 기반 jitter (같은 viewer-candidate 쌍에 대해 동일 값 반환)
function hashJitter(candidateId: string, viewerId: string, max: number): number {
  let hash = 0;
  const str = candidateId + viewerId;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % (max * 100)) / 100;
}

// 선호 부합 판정. 선호가 비어있으면 무조건 부합(=제약 없음).
export function matchesNationality(candidate: Candidate, prefs: ViewerPrefs): boolean {
  return prefs.preferred_nationalities.length === 0
    || prefs.preferred_nationalities.includes(candidate.nationality);
}

// 2-단계 티어. 작을수록 상위 노출. 언어가 국적에서 파생되면서 선호 언어 차원은
// 제거됐다 (선호 국적이 동일 신호를 커버). 국적 부합 여부만으로 가른다.
//   1: 선호 국가 부합 (선호가 비어있으면 항상 부합)
//   2: 선호 국가 미부합
// 참고: viewer 본인 언어와 같은 후보는 여기 도달 전에 SQL 사전 필터에서 이미 제외됨
// (크로스언어 차별점 — preferred_languages 와 무관한 별도 메커니즘).
export function computeTier(candidate: Candidate, prefs: ViewerPrefs): number {
  return matchesNationality(candidate, prefs) ? 1 : 2;
}

// 동일 티어 안에서의 2차 정렬 점수.
// - 기본 신호(관심사·사진·신규·jitter) 합산 상한은 70.
// - reciprocity: 후보가 이미 viewer 를 like 한 경우. 유료화 OFF 는 +50, ON 은 -15.
// 티어 경계 보호는 정렬 키 우선순위 (tier ASC > intra DESC) 가 담당 —
// reciprocity 가 합산을 얼마나 바꿔도 다른 티어 후보를 넘지 못한다.
export function computeIntraScore(
  candidate: Candidate,
  viewer: Viewer,
  reciprocalLikerIds: Set<string> = new Set(),
): number {
  let score = 0;

  // 관심사 겹침 (최대 30점)
  const viewerInterests = new Set(viewer.interests);
  const overlap = candidate.interests.filter((i) => viewerInterests.has(i)).length;
  score += Math.min(overlap * 10, 30);

  // 프로필 완성도(사진 3장 이상)
  if (candidate.photos.length >= 3) {
    score += 15;
  }

  // 신규 유저 부스트 (7일 이내)
  const daysSinceCreated = (Date.now() - new Date(candidate.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreated <= 7) {
    score += 10;
  }

  // 결정적 jitter (다양성 확보, 페이지네이션 안정성)
  score += hashJitter(candidate.id, viewer.id, 15);

  // reciprocity boost: 후보가 이미 viewer 를 like 한 경우.
  // 유료화 OFF: +50 — 같은 티어 안에서 1순위로 노출해 양방향 마주칠 확률을 높인다.
  // 유료화 ON : -15 — 받은 좋아요 공개가 유료라, 탐색에서 앞에 나오면 공개할 이유가
  // 사라진다.
  if (reciprocalLikerIds.has(candidate.id)) {
    score += env.monetization.enabled ? -15 : 50;
  }

  return score;
}

// 탐색 후보 풀 — 제외·선호 필터·점수 정렬까지. 플레이리스트 목록(곡 수)과 열기가 쓴다.
const poolError = (status: number, error: string): { status: number; error: string } => ({ status, error });

async function loadDiscoverPool(userId: string, limit: number) {

  // 조회자 프로필 — mig 009 이후 단일 scalar `language` 컬럼이 source of truth.
  const { data: viewerProfile } = await supabase
    .from('profiles')
    .select('language, interests')
    .eq('id', userId)
    .single();

  if (!viewerProfile) return poolError(404, 'Profile not found');

  const viewerLanguage = (viewerProfile.language as string | null) ?? '';
  const viewer: Viewer = {
    id: userId,
    interests: (viewerProfile.interests as string[] | null) ?? [],
  };

  // 스와이프/차단/선호도/reciprocity 풀을 병렬 조회.
  // reciprocity 풀 = 나를 like 한(direction='like') 사람들. idx_swipes_swiped 가
  // swiped_id 인덱스를 제공하므로 swiped_id=viewer 필터는 인덱스 사용.
  const [swipedResult, blockedResult, prefsResult, reciprocalResult, playlistResult, revealResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id, reset_at').eq('swiper_id', userId),
    supabase.from('blocks').select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    supabase.from('user_preferences').select('*').eq('user_id', userId).single(),
    supabase
      .from('swipes')
      .select('swiper_id')
      .eq('swiped_id', userId)
      .eq('direction', 'like'),
    // 아직 pass 처리 전인 플레이리스트에 이미 든 사람 (mig 063).
    supabase.from('discover_playlist_items').select('candidate_id').eq('user_id', userId),
    // 받은 좋아요 탭에서 이미 연 사람 — 플레이리스트 한 칸을 본 사람으로 낭비하지 않게.
    supabase.from('like_reveals').select('liker_id').eq('viewer_id', userId),
  ]);
  if (playlistResult.error || revealResult.error) {
    return poolError(500, (playlistResult.error ?? revealResult.error)!.message);
  }

  const reciprocalLikerIds = new Set<string>(
    (reciprocalResult.data ?? []).map((s: any) => s.swiper_id as string),
  );

  const blockedIds = (blockedResult.data || []).map((b: any) =>
    b.blocker_id === userId ? b.blocked_id : b.blocker_id
  );

  // 다시보기(reset_at)로 풀에 돌아온 사람은 제외하지 않는다.
  const excludeIds = [
    userId,
    ...(swipedResult.data ?? []).filter((s: any) => !s.reset_at).map((s: any) => s.swiped_id),
    ...blockedIds,
    ...(playlistResult.data ?? []).map((r: any) => r.candidate_id as string),
    ...(revealResult.data ?? []).map((r: any) => r.liker_id as string),
    // 섀도우 숨김 (env.discover.hiddenUserIds) — 당사자에게는 아무 신호도 가지
    // 않는다. 같은 목록을 GET /likes-received 와 isLikeVisibleToReceiver 에서도 적용.
    ...env.discover.hiddenUserIds,
  ];
  // 캠페인 봇은 선호 성별·나이 필터와 "viewer 와 같은 언어 하드 제외" 를 전부
  // 우회해야 하므로 메인 쿼리에서 빼고 아래에서 직접 주입한다. 단 이미 스와이프
  // 했거나 차단한 경우엔 주입도 하지 않는다 (일반 후보와 동일한 소진 규칙).
  const botAlreadyHandled =
    !env.campaign.botUserId || excludeIds.includes(env.campaign.botUserId);
  const uniqueExcludeIds = [
    ...new Set(env.campaign.botUserId ? [...excludeIds, env.campaign.botUserId] : excludeIds),
  ];

  const prefs = prefsResult.data;

  // 점수 계산용 후보 풀 크기. limit 의 5배를 기본으로 하되 최소 200·최대 500 으로
  // 클램프 — JS 스코어링(tier/intra)이 의미 있는 모집단 위에서 동작하도록 한다.
  // (A1: 옛 코드는 min(limit*5,200) 이라 기본 limit=10 에서 풀이 50 에 불과했고,
  //  ORDER BY 부재로 그 50 도 임의 물리순서 슬라이스였다.)
  const fetchLimit = Math.min(Math.max(limit * 5, 200), 500);

  // mig 011: voice_intro_audio_urls (jsonb) 가 시청자 언어 슬롯의 source. 단일
  // voice_intro_audio_url 은 응답에 미러로 출력하기 위해 슬롯에서 추출.
  // mig 034: profiles.photos 컬럼 폐지. 노출/스코어링용 사진은 모두
  // profile_photos (status='ready' converted_url) 에서 가져온다.
  let query = supabase
    .from('profiles')
    .select('id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests, created_at')
    .eq('is_active', true)
    .is('frozen_at', null);

  if (uniqueExcludeIds.length > 0) {
    query = query.not('id', 'in', `(${uniqueExcludeIds.join(',')})`);
  }

  // 본인 언어 동일 후보 하드 제외 — 크로스언어 매칭이 본 앱 핵심 정책.
  // 본인 언어가 비어있으면(=세팅 미완료) 필터 적용 안 함.
  if (viewerLanguage) {
    query = query.not('language', 'eq', viewerLanguage);
  }

  // A1: 결정적 ORDER BY 로 스코어링 풀 윈도우를 안정화. ORDER BY 부재 시 Postgres
  // 가 호출마다 다른 물리순서 슬라이스를 돌려줘 (a) 같은 viewer 가 호출마다 다른
  // 후보 셋을 점수 매기는 비일관 (b) 풀 바깥 후보 영구 누락 가능성이 있었다.
  // created_at DESC 로 "가장 최근 가입한 fetchLimit 명" 을 결정적으로 모집 →
  // 신규 유저 부스트(intra +10)와도 정합. id 는 동시각 가입 tie-breaker.
  // 풀 안에서의 최종 노출 순서는 아래 JS 의 (tier ASC, intra DESC) 가 결정하므로
  // 이 ORDER BY 는 "어떤 후보를 점수 대상에 넣을지" 만 좌우한다.
  // 인덱스: idx_profiles_active_created (mig 031) 가 is_active=true 부분 +
  // created_at DESC 정렬을 지원.
  query = query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(fetchLimit);

  query = applyPrefFilters(query, prefs);

  const { data, error } = await query;

  if (error) return poolError(500, error.message);

  const viewerPrefs: ViewerPrefs = {
    preferred_nationalities: (prefs?.preferred_nationalities as string[] | null) ?? [],
  };

  // mig 034: profile_photos 일괄 조회 — status='ready' 변환본 전체를 position ASC
  // 로 모아 user 별 배열로 보관. [0] = main(position=0), length = 스코어링용 ready
  // 사진 수. ready 사진이 0장인 사용자는 visible 단계에서 제외 (회원가입 직후 변환
  // 대기 케이스).
  const candidateIds = (data ?? []).map((row: any) => row.id as string);
  const readyPhotosByUser = await fetchReadyPhotosByUser(candidateIds, 'discover');

  // 사진이 한 장도 없는 미완성 프로필 (또는 변환 미완료 사용자) 는 후보에서 제외.
  // 본인 언어 일치 후보는 SQL 단에서 이미 제거됐지만, 마이그레이션 직후 NULL 인 행이
  // 일치 비교에서 빠지지 않도록 JS 단에서 빈 language 행도 함께 차단한다.
  const slot = pickViewerSlot(viewerLanguage);
  const visible = (data ?? []).filter((row: any) => {
    if (!row.language) return false;
    if (viewerLanguage && row.language === viewerLanguage) return false;
    if ((readyPhotosByUser.get(row.id) ?? []).length === 0) return false;
    // 차별점 1 강제: voice clone 없거나 voice intro 미작성이면 시청자 언어 슬롯이
    // 비어있다. voice_intro_audio 는 voice clone 보유 + voice intro 텍스트 작성 시에만
    // 합성되므로, 슬롯 URL 부재 = 둘 중 하나라도 없음. 무음 카드(SwipeCard 재생
    // 버튼 disabled)를 디스커버 노출 단계에서 원천 제외한다.
    const slotUrls = (row.voice_intro_audio_urls ?? {}) as Partial<
      Record<VoiceIntroSlotLanguage, string | null>
    >;
    if (!slotUrls[slot]) return false;
    return true;
  });

  // 티어 + 동일 티어 내 2차 점수 계산 → (tier ASC, intra DESC) 정렬.
  // mig 034: 스코어링의 "사진 3장+" 신호는 profile_photos ready 사진 수로 판정.
  const scored = visible.map((row: any) => {
    const candidate: Candidate = {
      id: row.id,
      language: row.language ?? '',
      nationality: row.nationality,
      interests: row.interests ?? [],
      photos: readyPhotosByUser.get(row.id) ?? [],
      created_at: row.created_at,
    };
    return {
      ...row,
      _tier: computeTier(candidate, viewerPrefs),
      _intra: computeIntraScore(candidate, viewer, reciprocalLikerIds),
    };
  });

  scored.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    return b._intra - a._intra;
  });

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
  const { _tier, _intra, created_at, voice_intro_audio_urls, ...rest } = row;
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
  // 1) 나를 like 한 사람들 (시간 역순, 최신 LIKES_RECEIVED_MAX 개로 바운드).
  //    (E) UNIQUE(swiper_id, swiped_id) 라 distinct liker. 인기 사용자가 수천 명에게
  //    좋아요를 받아도 다운스트림(프로필/사진 IN 페치)이 최신 N 명으로 묶인다.
  const { data: likes, error: likesError } = await supabase
    .from('swipes')
    .select('swiper_id, created_at')
    .eq('swiped_id', req.userId!)
    .eq('direction', 'like')
    .order('created_at', { ascending: false })
    .limit(LIKES_RECEIVED_MAX);

  if (likesError) {
    res.status(500).json({ error: likesError.message });
    return;
  }

  const likerIds = (likes ?? []).map((l: any) => l.swiper_id as string);
  if (likerIds.length === 0) {
    res.json([]);
    return;
  }

  // 2) 내가 이미 스와이프한 상대 + 차단 양방향 + viewer 본인 언어 + 선호도를 병렬 조회.
  //    likes-received 풀에서 제거할 ID 집합 (이미 응답 끝난 like 는 매치/패스 결과로
  //    별도 추적되므로 받은 좋아요 카드로 다시 노출할 의미 없음).
  // 다시보기(reset_at)된 pass 는 "아직 응답 안 함" 으로 본다 (예전 DELETE 와 동일 결과).
  const [viewerSwipesResult, blocksResult, viewerProfileResult, prefsResult, playlistResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id').eq('swiper_id', req.userId!).is('reset_at', null),
    supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId!},blocked_id.eq.${req.userId!}`),
    supabase.from('profiles').select('language, interests').eq('id', req.userId!).single(),
    supabase.from('user_preferences').select('*').eq('user_id', req.userId!).single(),
    // 오늘 탐색 플레이리스트에 든 사람은 숨긴다 — 같은 사람을 두 탭에서 따로 보지 않게.
    supabase.from('discover_playlist_items').select('candidate_id').eq('user_id', req.userId!),
  ]);
  if (playlistResult.error) {
    res.status(500).json({ error: playlistResult.error.message });
    return;
  }

  const swipedSet = new Set<string>([
    ...(viewerSwipesResult.data ?? []).map((s: any) => s.swiped_id as string),
    ...(playlistResult.data ?? []).map((r: any) => r.candidate_id as string),
  ]);
  const blockedSet = new Set<string>(
    (blocksResult.data ?? []).map((b: any) =>
      b.blocker_id === req.userId! ? (b.blocked_id as string) : (b.blocker_id as string),
    ),
  );
  const viewerLanguage = (viewerProfileResult.data?.language as string | null) ?? '';
  const prefs = prefsResult.data;

  const eligibleIds = likerIds.filter(
    (id) => !swipedSet.has(id) && !blockedSet.has(id) && !env.discover.hiddenUserIds.includes(id),
  );
  if (eligibleIds.length === 0) {
    res.json([]);
    return;
  }

  // 3) 프로필 일괄 조회 — discover hot path 와 동일한 컬럼 집합 + 동일한 사전 필터
  //    (성별/연령). 언어 선호는 티어 정렬 신호로 사용되므로 SQL 단계 IN 필터에서
  //    제거하지 않는다 (미부합 후보는 T2/T3 로 밀려나 노출만 후순위).
  let query = supabase
    .from('profiles')
    .select(
      'id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests, created_at',
    )
    .in('id', eligibleIds)
    .eq('is_active', true)
    .is('frozen_at', null);

  query = applyPrefFilters(query, prefs);

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

  // 5) 티어 계산 + 정렬: 탐색과 같은 (tier ASC, intra DESC). 이 풀은 전원이 나를
  //    like 했으므로 reciprocity 는 순서에 영향이 없어 넘기지 않는다.
  const viewerPrefs: ViewerPrefs = {
    preferred_nationalities: (prefs?.preferred_nationalities as string[] | null) ?? [],
  };
  const viewer: Viewer = {
    id: req.userId!,
    interests: (viewerProfileResult.data?.interests as string[] | null) ?? [],
  };

  const scored = visible.map((row: any) => {
    const candidate: Candidate = {
      id: row.id,
      language: row.language ?? '',
      nationality: row.nationality,
      interests: row.interests ?? [],
      photos: readyPhotosByUser.get(row.id) ?? [],
      created_at: row.created_at,
    };
    return {
      ...row,
      _tier: computeTier(candidate, viewerPrefs),
      _intra: computeIntraScore(candidate, viewer),
    };
  });

  scored.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    return b._intra - a._intra;
  });

  // 별사탕 유료화: 공개한 사람(본 순서대로) + 맨 끝 잠긴(블러) 카드 1장만 내려주고,
  // 나머지는 내려주지 않는다 (인원수 비노출 정책). 무료 카드가 있으면 잠긴 카드에
  // free_available 을 붙인다 — FE 가 그 카드를 화면에 띄우는 순간 무료로 공개한다.
  let visibleRows = scored;
  let lockedRow: (typeof scored)[number] | null = null;
  let freeAvailable = false;
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
    const split = splitLikeCards(scored, revealedAt, pinnedId);
    visibleRows = split.visible;
    lockedRow = split.locked;
    freeAvailable = nextFree === null;
    if (lockedRow && lockedRow.id !== pinnedId) {
      const { error: pinErr } = await supabase
        .from('like_card_pins')
        .upsert({ viewer_id: req.userId!, liker_id: lockedRow.id, pinned_at: new Date().toISOString() });
      if (pinErr) console.error('[likes-received] pin failed:', pinErr);
    }
  }

  // 6) 응답 가공 — discover 와 동일하게 사진 1장 / photo_access 잠금 / voice intro
  //    시청자 언어 슬롯 미러. FE SwipeCard 재사용을 보장하기 위해 shape 일치.
  // mig 034: photos[0] 은 profile_photos.converted_url(메인). (slot 은 visible
  //   필터 직전에 이미 계산됨.)
  // LAUNCH_CHECKLIST #3: discover 와 동일 — private 버킷 전환에 맞춰 응답 직전
  // voice intro slot URL 을 짧은 TTL 서명 URL 로 변환.
  const results: Record<string, unknown>[] = await Promise.all(
    visibleRows.map(async ({ _tier, _intra, voice_intro_audio_urls, created_at, ...rest }) => {
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
      };
    }),
  );

  // 잠긴 카드의 id 는 실제 liker id — 공개 요청(POST /likes-received/reveal)에 쓴다.
  // UUID 만으로는 다른 정보를 조회할 경로가 없다.
  if (lockedRow) {
    const blurred = await getBlurredMainPhotos([lockedRow.id]);
    results.push({
      ...toLockedCard(lockedRow, blurred.get(lockedRow.id), lockedRow.id),
      ...(freeAvailable ? { free_available: true } : {}),
    });
  }

  res.json(results);
});

// 유료화 ON 의 카드 나누기. rows 는 점수순으로 받는다.
// 공개한 카드(무료든 별사탕이든)는 공개 시각 = 본 시각 순으로 왼쪽부터, 맨 끝에 아직
// 안 연 사람 1명을 잠긴 카드로 둔다. 잠긴 카드는 고정돼서(like_card_pins) 열릴 때까지
// 바뀌지 않는다 — 점수가 더 높은 좋아요가 와도 보이던 모자이크가 바뀌지 않게.
export function splitLikeCards<T extends { id: string }>(
  rows: T[],
  revealedAt: Map<string, string>,
  pinnedId: string | null,
): { visible: T[]; locked: T | null } {
  const at = (r: T) => new Date(revealedAt.get(r.id)!).getTime();
  const visible = rows.filter((r) => revealedAt.has(r.id)).sort((a, b) => at(a) - at(b));
  const unrevealed = rows.filter((r) => !revealedAt.has(r.id));
  const locked = unrevealed.find((r) => r.id === pinnedId) ?? unrevealed[0] ?? null;
  return { visible, locked };
}

// 받은 좋아요 푸시 게이트 — 이 like 가 수신자의 받은 좋아요 탭에 실제로 노출되는가.
// 위 GET /likes-received 의 visible 필터(이미 스와이프함 / is_active / 성별·연령
// 선호 / 크로스언어 / 사진 / 시청자 언어 보이스 인트로 슬롯)를 한 명분으로 재사용.
// 노출되지 않을 like 까지 푸시하면 "좋아요 왔다" 는 알림을 열었는데 탭이 그대로인
// 거짓 신호가 된다. 차단·freeze 는 sendPushToUser 가 이미 검사하므로 생략.
async function isLikeVisibleToReceiver(likerId: string, receiverId: string): Promise<boolean> {
  const [receiverProfile, prefsResult, receiverSwipe] = await Promise.all([
    supabase.from('profiles').select('language').eq('id', receiverId).maybeSingle(),
    supabase.from('user_preferences').select('*').eq('user_id', receiverId).maybeSingle(),
    // 수신자가 이미 이 상대를 스와이프(pass)했으면 받은 좋아요 풀에서 제외됨.
    supabase
      .from('swipes')
      .select('id')
      .eq('swiper_id', receiverId)
      .eq('swiped_id', likerId)
      .is('reset_at', null)
      .limit(1),
  ]);

  if ((receiverSwipe.data ?? []).length > 0) return false;
  // 섀도우 숨김 계정의 like 는 받은 좋아요 탭에 안 뜨므로 푸시도 보내지 않는다
  // (열었는데 탭이 그대로인 거짓 신호 방지).
  if (env.discover.hiddenUserIds.includes(likerId)) return false;

  const viewerLanguage = (receiverProfile.data?.language as string | null) ?? '';

  let query = supabase
    .from('profiles')
    .select('language, voice_intro_audio_urls')
    .eq('id', likerId)
    .eq('is_active', true)
    .is('frozen_at', null);
  query = applyPrefFilters(query, prefsResult.data);

  const { data: liker, error } = await query.maybeSingle();
  if (error) {
    console.error('[isLikeVisibleToReceiver] liker select error:', error.message);
    return false;
  }
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

// 사용자 로컬 자정 기준 [today_start_utc, today_start_utc + 24h) 범위를 계산.
// tzOffsetMinutes 는 JS Date#getTimezoneOffset() 시맨틱 (UTC - local, 분).
function computeLocalDayRangeUtc(nowMs: number, tzOffsetMinutes: number): {
  fromIso: string; toIso: string; localDate: string;
} {
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

// 광고 보상 하루 한도의 "하루" — SSV 콜백에 사용자 타임존이 없어 KST 자정으로
// 통일한다 (1차 시장 KR/JP 모두 UTC+9). quota 의 ads_remaining 도 같은 경계.
export function kstDayStartIso(nowMs = Date.now()): string {
  return computeLocalDayRangeUtc(nowMs, -540).fromIso;
}

export async function adStarsRemainingToday(userId: string): Promise<number> {
  const granted = await sumLedger(userId, 'ad', kstDayStartIso());
  return Math.max(0, AD_REWARD_DAILY_MAX - Math.floor(granted / AD_REWARD_STARS));
}

// 별사탕 잔액·받은 좋아요 무료 카드 타이머·광고 남은 횟수. 두 탭 헤더와 모달이 공유한다.
router.get('/quota', async (req: AuthRequest, res: Response) => {
  res.json({
    monetization_enabled: env.monetization.enabled,
    ...(env.monetization.enabled ? await getMonetizationQuota(req.userId!) : {}),
  });
});

// quota 응답의 유료화 필드 — 별사탕 잔액, 받은 좋아요 무료 카드 타이머, 광고 남은 횟수.
async function getMonetizationQuota(userId: string) {
  const [stars, nextFreeRevealAt, adsRemaining] = await Promise.all([
    getStarBalance(userId),
    getNextFreeRevealAt(userId),
    adStarsRemainingToday(userId),
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

// 지난 날짜 플레이리스트에서 본 카드를 pass 로 기록하고 지운다. 실패하면 지우지 않고
// 다음 조회에서 다시 시도한다 — 그동안은 플레이리스트 행이 그 사람들을 후보에서 뺀다.
async function finalizePastPlaylists(userId: string, localDate: string): Promise<void> {
  const { data: old, error } = await supabase
    .from('discover_playlists')
    .select('id')
    .eq('user_id', userId)
    .lt('day', localDate);
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
  const ids = [...new Set((items ?? []).map((i: any) => i.candidate_id as string))];

  if (ids.length > 0) {
    const { data: existing, error: existingErr } = await supabase
      .from('swipes')
      .select('swiped_id, reset_at')
      .eq('swiper_id', userId)
      .in('swiped_id', ids);
    if (existingErr) {
      console.error('[playlists] finalize swipes failed:', existingErr.message);
      return;
    }
    const has = new Map((existing ?? []).map((r: any) => [r.swiped_id as string, r.reset_at as string | null]));
    const missing = ids.filter((id) => !has.has(id));
    // 다시보기(reset_at)로 풀에 돌아왔던 사람은 기존 행을 다시 pass 로 되돌린다.
    const recycled = ids.filter((id) => has.get(id));
    const pass = { direction: 'pass', source: 'playlist' };
    const [insertResult, updateResult] = await Promise.all([
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
    ]);
    if (insertResult.error || updateResult.error) {
      console.error('[playlists] finalize pass failed:', (insertResult.error ?? updateResult.error)!.message);
      return;
    }
  }

  const { error: deleteErr } = await supabase.from('discover_playlists').delete().in('id', oldIds);
  if (deleteErr) console.error('[playlists] finalize delete failed:', deleteErr.message);
}

async function getTodayPlaylists(userId: string, localDate: string) {
  const { data, error } = await supabase
    .from('discover_playlists')
    .select('id, idx')
    .eq('user_id', userId)
    .eq('day', localDate);
  if (error) throw new Error(`discover_playlists: ${error.message}`);
  return (data ?? []) as { id: number; idx: number }[];
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
  const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
  const { localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
  await finalizePastPlaylists(req.userId!, localDate);

  const [today, pool] = await Promise.all([
    getTodayPlaylists(req.userId!, localDate),
    loadDiscoverPool(req.userId!, CARD_RESET_AMOUNT),
  ]);
  if ('error' in pool) {
    res.status(pool.status).json({ error: pool.error });
    return;
  }

  // 칸별 인원(캠페인 봇 제외)과 마지막 순서.
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
    for (const i of items ?? []) {
      lastPosition.set(i.playlist_id, Math.max(lastPosition.get(i.playlist_id) ?? 0, i.position));
      if (i.candidate_id !== env.campaign.botUserId) {
        counts.set(i.playlist_id, (counts.get(i.playlist_id) ?? 0) + 1);
      }
    }
  }

  // 같은 요청이 겹쳐도 PK 중복은 무시된다.
  // ponytail: 동시에 다른 칸을 여는 요청과 겹치면 한 사람이 두 칸에 들어갈 수 있다 — 드물어 허용.
  const { fills, rest } = allocatePlaylistTopUp(
    today.map((p) => p.id),
    counts,
    pool.scored.map((r) => r.id as string),
  );
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

  const available = Math.min(rest.length, CARD_RESET_AMOUNT);
  const free = today.length === 0;
  const playlists = Array.from({ length: PLAYLIST_COUNT }, (_, idx) => {
    const opened = today.find((p) => p.idx === idx);
    return opened
      ? { idx, opened: true, count: counts.get(opened.id) ?? 0 }
      : { idx, opened: false, price: free ? 0 : cardResetCost(available) };
  });
  res.json({
    available_count: available,
    // 자르지 않은 남은 후보 수 — FE 가 오늘 채울 수 있는 LP 만 보여주는 데 쓴다 (칸당 최대 CARD_RESET_AMOUNT).
    candidate_count: rest.length,
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
  const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
  const { localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
  const playlist = (await getTodayPlaylists(req.userId!, localDate)).find((p) => p.idx === params.data.idx);
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
    const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
    const { localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
    const playlist = (await getTodayPlaylists(req.userId!, localDate)).find((p) => p.idx === params.data.idx);
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
// 곡 수(expected_count)보다 적으면 차감 없이 409 cards_changed + 현재 곡 수.
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
    const { localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
    await finalizePastPlaylists(userId, localDate);

    const today = await getTodayPlaylists(userId, localDate);
    const opened = today.find((p) => p.idx === idx);
    if (opened) {
      res.json({ idx, cards: await loadPlaylistCards(userId, opened.id) });
      return;
    }

    const pool = await loadDiscoverPool(userId, CARD_RESET_AMOUNT);
    if ('error' in pool) {
      res.status(pool.status).json({ error: pool.error });
      return;
    }
    const picks = pool.scored.slice(0, CARD_RESET_AMOUNT).map((r) => r.id as string);
    const expected = req.body.expected_count as number | undefined;
    if (picks.length === 0 || (expected !== undefined && picks.length < expected)) {
      res.status(409).json({ error: 'Available cards changed', code: 'cards_changed', available_count: picks.length });
      return;
    }

    const first = today.length === 0;
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
      p_day: localDate,
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
      // 그사이 다른 기기에서 오늘 첫 플레이리스트를 열었다 — 무료가 아니게 됐다.
      if (error.message.includes('not_first')) {
        res.status(409).json({ error: 'Playlist price changed', code: 'playlist_changed' });
        return;
      }
      // 같은 칸을 동시에 연 경합 — 먼저 열린 쪽을 돌려준다 (이쪽 차감은 함께 취소됨).
      if (error.code === '23505') {
        const again = (await getTodayPlaylists(userId, localDate)).find((p) => p.idx === idx);
        if (again) {
          res.json({ idx, cards: await loadPlaylistCards(userId, again.id) });
          return;
        }
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

    const [likeResult, revealResult] = await Promise.all([
      supabase
        .from('swipes')
        .select('id')
        .eq('swiper_id', liker_id)
        .eq('swiped_id', me)
        .eq('direction', 'like')
        .maybeSingle(),
      supabase.from('like_reveals').select('liker_id').eq('viewer_id', me).eq('liker_id', liker_id).maybeSingle(),
    ]);
    if (likeResult.error || revealResult.error) {
      res.status(500).json({ error: (likeResult.error ?? revealResult.error)!.message });
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

    if (free) {
      // ponytail: 동시에 다른 카드 2장을 무료로 열면 2장이 나갈 수 있다 (락 없음).
      if ((await getNextFreeRevealAt(me)) !== null) {
        res.status(409).json({ error: 'No free card now', code: 'free_unavailable' });
        return;
      }
      const { error } = await supabase.from('like_reveals').insert({ viewer_id: me, liker_id, paid: false });
      if (error && error.code !== '23505') {
        res.status(500).json({ error: error.message });
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
  const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
  const monetized = env.monetization.enabled;

  // 받아둔 카드의 상대가 그사이 탈퇴·정지·차단됐으면 아무것도 기록·차감하지 않고 넘긴다.
  // 무료 카드도 쓰지 않고 매치도 만들지 않는다. 오류가 아니라 카드가 자연스럽게 지나간다.
  if (!isCampaignBot(swiped_id) && (await isUserUnavailable(req.userId!, swiped_id))) {
    // 별사탕으로 공개한 받은 좋아요 카드에 좋아요 — 매치를 기대하고 낸 별사탕을 돌려준다.
    // 패스는 사용자가 넘기기로 한 것이라 돌려주지 않는다.
    const refunded =
      monetized && req.body.source === 'likes' && direction === 'like'
        ? await refundLikeReveal(req.userId!, swiped_id)
        : 0;
    res.json({ direction, match: null, skipped: true, ...(refunded > 0 ? { refunded_stars: refunded } : {}) });
    return;
  }

  // 탐색의 대화 신청은 플레이리스트가 곧 카드 한도다 — 오늘 내 플레이리스트에 든
  // 상대인지 확인한다. 안 그러면 아무 후보에게나 보낼 수 있고, 자정이 지난 플레이리스트
  // (다음 조회 때 pass 처리될 카드)에도 보낼 수 있다.
  if (req.body.source === 'playlist') {
    const { localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);
    const today = await getTodayPlaylists(req.userId!, localDate);
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
    .select('id, reset_at')
    .eq('swiper_id', req.userId!)
    .eq('swiped_id', swiped_id)
    .maybeSingle();
  if (existingErr) {
    res.status(500).json({ error: existingErr.message });
    return;
  }
  if (existing && !existing.reset_at) {
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
  const { error: swipeError } = recycled
    ? await supabase
        .from('swipes')
        .update({ ...row, reset_at: null, created_at: new Date().toISOString() })
        .eq('id', existing!.id)
    : await supabase.from('swipes').insert({ swiper_id: req.userId!, swiped_id, ...row });

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

      // push-notifications sprint: 매치 성사 시 양쪽 사용자에게 푸시 발송.
      // 능동 like 한 사람도 "상대도 좋아함" 알림을 받는 표준 데이팅앱 UX.
      // unmatch 후 재match (소프트 삭제 후 23505 fallback) 케이스에도 발송 — 매치 부활도 알림 가치 있음.
      if (match) {
        // 양쪽 display_name 조회 — 양쪽 모두에게 상대 이름이 들어간 푸시 발송.
        const matchId = match.id;
        supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', [req.userId!, swiped_id])
          .then(({ data: profiles }) => {
            if (!profiles) return;
            const me = profiles.find((p: any) => p.id === req.userId!);
            const other = profiles.find((p: any) => p.id === swiped_id);
            const myName = (me?.display_name as string | null) ?? '';
            const otherName = (other?.display_name as string | null) ?? '';

            sendPushToUser(req.userId!, {
              type: 'match',
              match_id: matchId,
              matched_user_id: swiped_id,
              matched_name: otherName,
            }).catch((err) => console.error('[sendPushToUser match→swiper]', err));

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
  if (direction === 'like' && !reciprocal) {
    const likerId = req.userId!;
    isLikeVisibleToReceiver(likerId, swiped_id)
      .then((visible) =>
        visible ? sendPushToUser(swiped_id, { type: 'like', liker_id: likerId }) : undefined,
      )
      .catch((err) => console.error('[sendPushToUser like]', err));
  }

  res.json({ direction, match });
});

export default router;
