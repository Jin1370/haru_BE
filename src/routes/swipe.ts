import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { swipeBodySchema, discoverQuerySchema, quotaQuerySchema } from '../schemas/swipe';
import { AuthRequest, type VoiceIntroSlotLanguage } from '../types';
import { sendPushToUser } from '../services/pushNotifications';
import { requireNotFrozen } from '../utils/freezeGuard';

// 시청자 언어 → 보이스 인트로 슬롯 매핑 (mig 011).
// ko/ja/en 활성. th/hi/그 외/null 은 'en' 폴백 (FE 의 영문 강제 정책과 일관).
export function pickViewerSlot(viewerLanguage: string | null | undefined): VoiceIntroSlotLanguage {
  if (viewerLanguage === 'ko' || viewerLanguage === 'ja' || viewerLanguage === 'en') {
    return viewerLanguage;
  }
  return 'en';
}

const router = Router();

// 디스커버 일일 카드 한도. FE 의 utils/discoverDaily.MAX_PER_DAY 와 동일 값.
// 기기 간 동기화를 위해 BE 의 swipes 테이블을 source of truth 로 한다.
export const DISCOVER_MAX_PER_DAY = 50;

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
  preferred_languages: string[];
  preferred_nationalities: string[];
};

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

// 차원별 선호 부합 판정. 각 차원의 선호가 비어있으면 그 차원은 무조건 부합(=제약 없음).
export function matchesLanguage(candidate: Candidate, prefs: ViewerPrefs): boolean {
  return prefs.preferred_languages.length === 0
    || (candidate.language !== '' && prefs.preferred_languages.includes(candidate.language));
}

export function matchesNationality(candidate: Candidate, prefs: ViewerPrefs): boolean {
  return prefs.preferred_nationalities.length === 0
    || prefs.preferred_nationalities.includes(candidate.nationality);
}

// 4-단계 티어. 작을수록 상위 노출. 국가 부합을 언어 부합보다 우선.
//   1: 선호 국가 + 선호 언어 둘 다 부합
//   2: 선호 국가만 부합
//   3: 선호 언어만 부합
//   4: 둘 다 미부합
// 각 차원 선호가 비어있을 땐 해당 차원이 항상 부합으로 처리되므로
// 결과적으로 비어있는 차원은 티어 분기에서 무력화된다.
export function computeTier(candidate: Candidate, prefs: ViewerPrefs): number {
  const langOk = matchesLanguage(candidate, prefs);
  const natOk = matchesNationality(candidate, prefs);
  if (langOk && natOk) return 1;
  if (natOk) return 2;
  if (langOk) return 3;
  return 4;
}

// 동일 티어 안에서의 2차 정렬 점수.
// - 기본 신호(관심사·사진·신규·jitter) 합산 상한은 65.
// - reciprocity boost(+50): 후보가 이미 viewer 를 like 한 경우 가산. 같은 티어
//   안에서 다른 모든 신호(최대 65) 를 압도해 매칭 확률을 끌어올리는 신호.
// 티어 경계 보호는 정렬 키 우선순위 (tier ASC > intra DESC) 가 담당 —
// reciprocity 가 +50 가산되어 합산이 65 를 넘어도 다른 티어 후보 위로 못 올라간다.
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
    score += 10;
  }

  // 신규 유저 부스트 (7일 이내)
  const daysSinceCreated = (Date.now() - new Date(candidate.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreated <= 7) {
    score += 10;
  }

  // 결정적 jitter (다양성 확보, 페이지네이션 안정성)
  score += hashJitter(candidate.id, viewer.id, 15);

  // reciprocity boost: 후보가 이미 viewer 를 like 한 경우.
  // 같은 티어 안에서 다른 신호 합 (≤65) 을 압도하지만, 정렬 1차 키가 tier 라
  // 티어 경계는 넘지 않는다. "내가 만나고 싶은 사람 중 나를 좋아하는 사람" 이
  // 같은 티어 안에서 1순위로 노출되어 매칭 funnel 양방향 마주칠 확률을 끌어올린다.
  if (reciprocalLikerIds.has(candidate.id)) {
    score += 50;
  }

  return score;
}

// 매칭 후보 목록 (추천 알고리즘 적용)
router.get('/', validateQuery(discoverQuerySchema), async (req: AuthRequest, res: Response) => {
  const limit = req.query.limit as unknown as number;

  // 조회자 프로필 — mig 009 이후 단일 scalar `language` 컬럼이 source of truth.
  const { data: viewerProfile } = await supabase
    .from('profiles')
    .select('language, interests')
    .eq('id', req.userId!)
    .single();

  if (!viewerProfile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  const viewerLanguage = (viewerProfile.language as string | null) ?? '';
  const viewer: Viewer = {
    id: req.userId!,
    interests: (viewerProfile.interests as string[] | null) ?? [],
  };

  // 스와이프/차단/선호도/reciprocity 풀을 병렬 조회.
  // reciprocity 풀 = 나를 like 한(direction='like') 사람들. idx_swipes_swiped 가
  // swiped_id 인덱스를 제공하므로 swiped_id=viewer 필터는 인덱스 사용.
  const [swipedResult, blockedResult, prefsResult, reciprocalResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id').eq('swiper_id', req.userId!),
    supabase.from('blocks').select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId!},blocked_id.eq.${req.userId!}`),
    supabase.from('user_preferences').select('*').eq('user_id', req.userId!).single(),
    supabase
      .from('swipes')
      .select('swiper_id')
      .eq('swiped_id', req.userId!)
      .eq('direction', 'like'),
  ]);

  const reciprocalLikerIds = new Set<string>(
    (reciprocalResult.data ?? []).map((s: any) => s.swiper_id as string),
  );

  const blockedIds = (blockedResult.data || []).map((b: any) =>
    b.blocker_id === req.userId! ? b.blocked_id : b.blocker_id
  );

  const excludeIds = [
    req.userId!,
    ...(swipedResult.data?.map((s: any) => s.swiped_id) || []),
    ...blockedIds,
  ];
  const uniqueExcludeIds = [...new Set(excludeIds)];

  const prefs = prefsResult.data;

  // 점수 계산을 위해 넉넉히 가져옴 (limit의 5배, 최대 200)
  const fetchLimit = Math.min(limit * 5, 200);

  // mig 011: voice_intro_audio_urls (jsonb) 가 시청자 언어 슬롯의 source. 단일
  // voice_intro_audio_url 은 응답에 미러로 출력하기 위해 슬롯에서 추출.
  // photo-watercolor-pipeline sprint: profiles.photos 는 호환 유지 동안만 select.
  // 응답 photos 배열은 profile_photos 의 status='ready' converted_url 만 사용.
  let query = supabase
    .from('profiles')
    .select('id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests, photos, created_at')
    .eq('is_active', true);

  if (uniqueExcludeIds.length > 0) {
    query = query.not('id', 'in', `(${uniqueExcludeIds.join(',')})`);
  }

  // 본인 언어 동일 후보 하드 제외 — 크로스언어 매칭이 본 앱 핵심 정책.
  // 본인 언어가 비어있으면(=세팅 미완료) 필터 적용 안 함.
  if (viewerLanguage) {
    query = query.not('language', 'eq', viewerLanguage);
  }

  query = query.limit(fetchLimit);

  // 사전 필터: 성별/연령만. 언어 선호는 티어 정렬 신호로 사용되므로
  // 여기서 IN 필터로 후보를 제거하지 않는다(미부합 후보는 T2 로 밀려남).
  if (prefs) {
    if (prefs.preferred_genders && prefs.preferred_genders.length > 0) {
      query = query.in('gender', prefs.preferred_genders);
    }
    const now = new Date();
    if (prefs.min_age) {
      const maxBirthDate = new Date(now.getFullYear() - prefs.min_age, now.getMonth(), now.getDate())
        .toISOString().split('T')[0];
      query = query.lte('birth_date', maxBirthDate);
    }
    if (prefs.max_age) {
      const minBirthDate = new Date(now.getFullYear() - prefs.max_age - 1, now.getMonth(), now.getDate())
        .toISOString().split('T')[0];
      query = query.gte('birth_date', minBirthDate);
    }
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const viewerPrefs: ViewerPrefs = {
    preferred_languages: (prefs?.preferred_languages as string[] | null) ?? [],
    preferred_nationalities: (prefs?.preferred_nationalities as string[] | null) ?? [],
  };

  // photo-watercolor-pipeline sprint: profile_photos 일괄 조회 — status='ready'
  // 변환본 main 사진 (position=0) 만 노출. position=0 row 가 없거나 status≠'ready'
  // 인 사용자는 visible 단계에서 제외 (회원가입 직후 변환 대기 + 백필 변환 대기 케이스).
  const candidateIds = (data ?? []).map((row: any) => row.id as string);
  const readyPhotosByUser = new Map<string, string>();
  if (candidateIds.length > 0) {
    const { data: photoRows, error: photoErr } = await supabase
      .from('profile_photos')
      .select('user_id, position, converted_url, status')
      .in('user_id', candidateIds)
      .eq('status', 'ready')
      .eq('position', 0);
    if (photoErr) {
      console.error('[discover.profile_photos_select_failed]', photoErr.message);
    } else {
      ((photoRows ?? []) as Array<{ user_id: string; converted_url: string | null }>).forEach((r) => {
        if (r.converted_url) readyPhotosByUser.set(r.user_id, r.converted_url);
      });
    }
  }

  // 사진이 한 장도 없는 미완성 프로필 (또는 변환 미완료 사용자) 는 후보에서 제외.
  // 본인 언어 일치 후보는 SQL 단에서 이미 제거됐지만, 마이그레이션 직후 NULL 인 행이
  // 일치 비교에서 빠지지 않도록 JS 단에서 빈 language 행도 함께 차단한다.
  //
  // 호환성 폴백: profile_photos 에서 ready 사진이 없고 옛 profiles.photos 배열에는
  // 있는 환경 (mig 028 미적용 또는 백필 sweep 미완) — 옛 photos[0] 사용.
  const visible = (data ?? []).filter((row: any) => {
    if (!row.language) return false;
    if (viewerLanguage && row.language === viewerLanguage) return false;
    const hasConverted = readyPhotosByUser.has(row.id);
    const legacyPhotos = (row.photos as string[] | null) ?? [];
    if (!hasConverted && legacyPhotos.length === 0) return false;
    return true;
  });

  // 티어 + 동일 티어 내 2차 점수 계산 → (tier ASC, intra DESC) 정렬.
  const scored = visible.map((row: any) => {
    const candidate: Candidate = {
      id: row.id,
      language: row.language ?? '',
      nationality: row.nationality,
      interests: row.interests ?? [],
      photos: row.photos ?? [],
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

  // 프론트에 반환할 때 내부 정렬 키와 created_at 을 제외.
  // 보안 경계: discover 는 잠금 해제 대상이 아니므로 서버에서 photos 배열을 메인 1장으로 잘라
  //            본인 프로필 외 추가 사진 URL 노출을 원천 차단한다.
  //            photo_access 는 정책상 항상 false/false 고정.
  // photo-watercolor-pipeline sprint: photos[0] 은 profile_photos.converted_url
  //   (변환본). 변환 미완료 사용자는 위 visible 단계에서 이미 제거됨.
  // mig 011: voice_intro_audio_urls 에서 시청자 언어 슬롯만 추출해 단일 URL 미러.
  const slot = pickViewerSlot(viewerLanguage);
  const results = scored.slice(0, limit).map(({ _tier, _intra, created_at, photos, voice_intro_audio_urls, ...rest }) => {
    const slotUrls = (voice_intro_audio_urls ?? {}) as Partial<Record<VoiceIntroSlotLanguage, string | null>>;
    const convertedUrl = readyPhotosByUser.get(rest.id as string);
    const legacyPhotos = (photos as string[] | null) ?? [];
    const photoUrls: string[] = convertedUrl
      ? [convertedUrl]
      : legacyPhotos.slice(0, 1);
    return {
      ...rest,
      voice_intro_audio_url: (slotUrls[slot] as string | null | undefined) ?? null,
      photos: photoUrls,
      photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
    };
  });

  res.json(results);
});

// 받은 좋아요 목록 — 나를 like 한 사용자 중, 내가 아직 응답 스와이프 하지 않았고
// 차단 양방향에 걸리지 않은 active 후보. 응답 shape 은 디스커버 카드와 동일하게
// 사진 1장 / photo_access 잠금 / voice_intro 시청자 언어 슬롯 미러 — FE 의 SwipeCard
// 컴포넌트를 그대로 재사용할 수 있게 한다.
//
// 사전 필터: 성별/연령 (user_preferences) + viewer 본인 언어 동일 후보 제외 (cross-language
// 정책) — 디스커버와 동일하게 적용. 언어/국가 선호는 SQL 단계에서 거르지 않고 티어
// 정렬 신호로만 사용 (디스커버 동일 패턴).
//
// 정렬: (tier ASC, like 시각 DESC). 같은 티어 안에선 최근 받은 좋아요 우선.
// reciprocity boost (+50) 는 모든 후보에 동일 적용되어 무력화되므로 intra score
// 계산을 생략. 디스커버의 (tier ASC, intra DESC) 와 다른 점은 2차 키만.
//
// 일일 50장 한도와는 무관하게 GET 은 무료(조회는 카운트 안 함). 실제 스와이프
// 행위(POST /swipe)는 디스커버 swipe 와 동일 엔드포인트를 공유하므로 quota 도 함께 적용됨.
router.get('/likes-received', async (req: AuthRequest, res: Response) => {
  // 1) 나를 like 한 사람들 (시간 역순)
  const { data: likes, error: likesError } = await supabase
    .from('swipes')
    .select('swiper_id, created_at')
    .eq('swiped_id', req.userId!)
    .eq('direction', 'like')
    .order('created_at', { ascending: false });

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
  const [viewerSwipesResult, blocksResult, viewerProfileResult, prefsResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id').eq('swiper_id', req.userId!),
    supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId!},blocked_id.eq.${req.userId!}`),
    supabase.from('profiles').select('language').eq('id', req.userId!).single(),
    supabase.from('user_preferences').select('*').eq('user_id', req.userId!).single(),
  ]);

  const swipedSet = new Set<string>(
    (viewerSwipesResult.data ?? []).map((s: any) => s.swiped_id as string),
  );
  const blockedSet = new Set<string>(
    (blocksResult.data ?? []).map((b: any) =>
      b.blocker_id === req.userId! ? (b.blocked_id as string) : (b.blocker_id as string),
    ),
  );
  const viewerLanguage = (viewerProfileResult.data?.language as string | null) ?? '';
  const prefs = prefsResult.data;

  const eligibleIds = likerIds.filter((id) => !swipedSet.has(id) && !blockedSet.has(id));
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
      'id, display_name, birth_date, gender, nationality, language, voice_intro, voice_intro_audio_urls, interests, photos, created_at',
    )
    .in('id', eligibleIds)
    .eq('is_active', true);

  if (prefs) {
    if (prefs.preferred_genders && prefs.preferred_genders.length > 0) {
      query = query.in('gender', prefs.preferred_genders);
    }
    const now = new Date();
    if (prefs.min_age) {
      const maxBirthDate = new Date(now.getFullYear() - prefs.min_age, now.getMonth(), now.getDate())
        .toISOString().split('T')[0];
      query = query.lte('birth_date', maxBirthDate);
    }
    if (prefs.max_age) {
      const minBirthDate = new Date(now.getFullYear() - prefs.max_age - 1, now.getMonth(), now.getDate())
        .toISOString().split('T')[0];
      query = query.gte('birth_date', minBirthDate);
    }
  }

  const { data: profiles, error: profilesError } = await query;

  if (profilesError) {
    res.status(500).json({ error: profilesError.message });
    return;
  }

  // photo-watercolor-pipeline sprint: profile_photos 일괄 조회 (디스커버와 동일 패턴).
  const candidateIds = (profiles ?? []).map((row: any) => row.id as string);
  const readyPhotosByUser = new Map<string, string>();
  if (candidateIds.length > 0) {
    const { data: photoRows, error: photoErr } = await supabase
      .from('profile_photos')
      .select('user_id, position, converted_url, status')
      .in('user_id', candidateIds)
      .eq('status', 'ready')
      .eq('position', 0);
    if (photoErr) {
      console.error('[likes-received.profile_photos_select_failed]', photoErr.message);
    } else {
      ((photoRows ?? []) as Array<{ user_id: string; converted_url: string | null }>).forEach((r) => {
        if (r.converted_url) readyPhotosByUser.set(r.user_id, r.converted_url);
      });
    }
  }

  // 4) 가시 후보 필터 — 사진 0장 / 언어 미설정 / viewer 와 같은 언어 후보 제외.
  //    cross-language 정책은 디스커버와 동일하게 적용 (받은 좋아요 풀에 같은 언어가
  //    있다면 그건 viewer 언어 설정 이전에 받은 좋아요. 현재 정책상 노출 차단).
  //    호환성 폴백: profile_photos 없으면 옛 photos 배열.
  const visible = (profiles ?? []).filter((row: any) => {
    if (!row.language) return false;
    if (viewerLanguage && row.language === viewerLanguage) return false;
    const hasConverted = readyPhotosByUser.has(row.id);
    const legacyPhotos = (row.photos as string[] | null) ?? [];
    if (!hasConverted && legacyPhotos.length === 0) return false;
    return true;
  });

  // 5) 티어 계산 + 정렬: (tier ASC, like 시각 DESC).
  //    like 시각 DESC 는 `eligibleIds` 인덱스 ASC 와 동치 (1단계에서 시간 역순으로
  //    정렬됐으므로). reciprocity boost 는 모든 후보 동일 적용이라 무력화 → intra
  //    score 미산정.
  const viewerPrefs: ViewerPrefs = {
    preferred_languages: (prefs?.preferred_languages as string[] | null) ?? [],
    preferred_nationalities: (prefs?.preferred_nationalities as string[] | null) ?? [],
  };

  const orderIndex = new Map<string, number>();
  eligibleIds.forEach((id, idx) => orderIndex.set(id, idx));

  const scored = visible.map((row: any) => {
    const candidate: Candidate = {
      id: row.id,
      language: row.language ?? '',
      nationality: row.nationality,
      interests: row.interests ?? [],
      photos: row.photos ?? [],
      created_at: row.created_at,
    };
    return {
      ...row,
      _tier: computeTier(candidate, viewerPrefs),
      _likeIndex: orderIndex.get(row.id) ?? 0,
    };
  });

  scored.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    return a._likeIndex - b._likeIndex;
  });

  // 6) 응답 가공 — discover 와 동일하게 사진 1장 / photo_access 잠금 / voice intro
  //    시청자 언어 슬롯 미러. FE SwipeCard 재사용을 보장하기 위해 shape 일치.
  // photo-watercolor-pipeline sprint: photos[0] 은 profile_photos.converted_url
  //   (변환본). 폴백은 옛 photos[0].
  const slot = pickViewerSlot(viewerLanguage);
  const results = scored.map(({ _tier, _likeIndex, photos, voice_intro_audio_urls, created_at, ...rest }) => {
    const slotUrls = (voice_intro_audio_urls ?? {}) as Partial<
      Record<VoiceIntroSlotLanguage, string | null>
    >;
    const convertedUrl = readyPhotosByUser.get(rest.id as string);
    const legacyPhotos = (photos as string[] | null) ?? [];
    const photoUrls: string[] = convertedUrl
      ? [convertedUrl]
      : legacyPhotos.slice(0, 1);
    return {
      ...rest,
      voice_intro_audio_url: (slotUrls[slot] as string | null | undefined) ?? null,
      photos: photoUrls,
      photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
    };
  });

  res.json(results);
});

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

// 디스커버 일일 카드 카운트 (오늘 사용한 스와이프 수). 기기 간 동기화를 위한 endpoint.
// FE 마운트 시 호출 → in-memory 카운트 기준으로 사용. 스와이프마다 다음 마운트에 동기화.
router.get('/quota', validateQuery(quotaQuerySchema), async (req: AuthRequest, res: Response) => {
  const tzOffsetMinutes = req.query.tz_offset_minutes as unknown as number;
  const { fromIso, toIso, localDate } = computeLocalDayRangeUtc(Date.now(), tzOffsetMinutes);

  const { count, error } = await supabase
    .from('swipes')
    .select('id', { count: 'exact', head: true })
    .eq('swiper_id', req.userId!)
    .gte('created_at', fromIso)
    .lt('created_at', toIso);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const used = count ?? 0;
  res.json({
    count: used,
    limit: DISCOVER_MAX_PER_DAY,
    remaining: Math.max(0, DISCOVER_MAX_PER_DAY - used),
    date: localDate,
  });
});

// 스와이프
//
// message-moderation-v1 (PR2): freeze 사용자의 like 시도를 차단.
// GET /api/discover 와 GET /likes-received 는 이미 SQL 단계에서 `.eq('is_active', true)`
// 필터로 freeze 사용자를 다른 viewer 의 노출 풀에서 제거한다 (회귀 매트릭스 #1, #2).
// 본 POST 만 가드 — 본인의 능동 swipe 행위를 막아 reciprocal like 매치 생성 경로
// 자체를 차단.
router.post('/swipe', requireNotFrozen, validateBody(swipeBodySchema), async (req: AuthRequest, res: Response) => {
  const { swiped_id, direction } = req.body;

  const { error: swipeError } = await supabase.from('swipes').insert({
    swiper_id: req.userId!,
    swiped_id,
    direction,
  });

  if (swipeError) {
    if (swipeError.code === '23505') {
      res.status(409).json({ error: 'Already swiped this user' });
      return;
    }
    res.status(500).json({ error: swipeError.message });
    return;
  }

  let match: { id: string; user1_id: string; user2_id: string } | null = null;
  if (direction === 'like') {
    // silent-success 룰 (CLAUDE.md): PGRST116 (no rows) 는 정상 케이스 (상대가
    // 아직 like 안 함) 이지만 그 외 error 는 가시화. silent 통과 시 reciprocal
    // 매치 trigger 가 안 일어나는 회귀 가능.
    const { data: reciprocal, error: reciprocalErr } = await supabase
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
  }

  res.json({ direction, match });
});

export default router;
