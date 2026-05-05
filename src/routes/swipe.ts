import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { swipeBodySchema, discoverQuerySchema, quotaQuerySchema } from '../schemas/swipe';
import { AuthRequest } from '../types';

const router = Router();

// 디스커버 일일 카드 한도. FE 의 utils/discoverDaily.MAX_PER_DAY 와 동일 값.
// 기기 간 동기화를 위해 BE 의 swipes 테이블을 source of truth 로 한다.
export const DISCOVER_MAX_PER_DAY = 50;

router.use(authMiddleware);

type LanguageProficiency = { code: string; level: number };

type Candidate = {
  id: string;
  languages: LanguageProficiency[];
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
  preferred_languages_detail: LanguageProficiency[];
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

// 후보가 viewer 의 선호(언어 + 국가)에 모두 부합하는지 판정.
// 각 차원의 선호가 비어있으면 그 차원은 무조건 부합 처리(=제약 없음).
function matchesPreference(candidate: Candidate, prefs: ViewerPrefs): boolean {
  // 1) 언어: 채팅은 후보의 주 언어(`languages[0]`)로 진행되고 번역 파이프라인의
  //    source/target 도 primary 기준이므로, 선호 언어는 후보의 primary 와만 비교한다.
  //    secondary 언어는 채팅 경험에 영향이 없으므로 부합 판정에서 제외.
  //    빈 선호는 항상 부합. 후보 primary 미존재(스키마상 있을 수 없음)면 미부합.
  const candidatePrimary = candidate.languages[0];
  const langOk = prefs.preferred_languages_detail.length === 0
    || (candidatePrimary != null
      && prefs.preferred_languages_detail.some((req) =>
        candidatePrimary.code === req.code && candidatePrimary.level >= req.level,
      ));
  if (!langOk) return false;

  // 2) 국가: 후보의 nationality 가 선호 목록에 포함되면 부합. 빈 선호는 항상 부합.
  const natOk = prefs.preferred_nationalities.length === 0
    || prefs.preferred_nationalities.includes(candidate.nationality);
  return natOk;
}

// 2-단계 티어. 작을수록 상위 노출.
// 주 언어 동일 후보는 사전 필터에서 이미 제거되므로 언어 차원은 티어 분기에서 제외.
//   1: 선호 부합
//   2: 선호 미부합
function computeTier(candidate: Candidate, prefs: ViewerPrefs): number {
  return matchesPreference(candidate, prefs) ? 1 : 2;
}

// 동일 티어 안에서의 2차 정렬 점수. 합산 최대치는 65 로 묶여 있어
// 어떤 가산도 티어 경계를 넘지 않는다.
function computeIntraScore(candidate: Candidate, viewer: Viewer): number {
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

  return score;
}

// 매칭 후보 목록 (추천 알고리즘 적용)
router.get('/', validateQuery(discoverQuerySchema), async (req: AuthRequest, res: Response) => {
  const limit = req.query.limit as unknown as number;

  // 조회자 프로필 — primary language 는 languages[0].code 로 derive
  const { data: viewerProfile } = await supabase
    .from('profiles')
    .select('languages, interests')
    .eq('id', req.userId!)
    .single();

  if (!viewerProfile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  const viewerLangs = (viewerProfile.languages as LanguageProficiency[] | null) ?? [];
  const viewerPrimaryLang = viewerLangs[0]?.code ?? '';
  const viewer: Viewer = {
    id: req.userId!,
    interests: (viewerProfile.interests as string[] | null) ?? [],
  };

  // 스와이프/차단/선호도를 병렬 조회
  const [swipedResult, blockedResult, prefsResult] = await Promise.all([
    supabase.from('swipes').select('swiped_id').eq('swiper_id', req.userId!),
    supabase.from('blocks').select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${req.userId!},blocked_id.eq.${req.userId!}`),
    supabase.from('user_preferences').select('*').eq('user_id', req.userId!).single(),
  ]);

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

  let query = supabase
    .from('profiles')
    .select('id, display_name, birth_date, gender, nationality, languages, voice_intro, voice_intro_audio_url, interests, photos, created_at')
    .eq('is_active', true);

  if (uniqueExcludeIds.length > 0) {
    query = query.not('id', 'in', `(${uniqueExcludeIds.join(',')})`);
  }

  // 주 언어 일치 하드 제외: 본인 primary language(`languages[0].code`)와 같은 후보는 후보 풀에서 제거.
  // 본인 primary 언어가 비어있으면(=세팅 미완료) 필터 적용 안 함.
  if (viewerPrimaryLang) {
    query = query.not('languages->0->>code', 'eq', viewerPrimaryLang);
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
    preferred_languages_detail: (prefs?.preferred_languages_detail as LanguageProficiency[] | null) ?? [],
    preferred_nationalities: (prefs?.preferred_nationalities as string[] | null) ?? [],
  };

  // 사진이 한 장도 없는 미완성 프로필은 후보에서 제외.
  // step1 placeholder upsert 직후 사진/보이스 등록 전 일시 상태가 다른 사용자 디스커버에 노출되지 않게 한다.
  // 또한 본인 primary 언어와 동일한 후보를 한 번 더 거른다 — SQL 단의 `languages->0->>code` 필터는
  // PostgREST 가 배열 인덱스 `0` 을 text key 로 해석하는 케이스에서 무력화될 수 있어, JS 단에서
  // 명시적으로 한 번 더 검증한다 (cross-language 매칭이 본 앱의 핵심 정책).
  const visible = (data ?? []).filter((row: any) => {
    if (!Array.isArray(row.photos) || row.photos.length === 0) return false;
    if (viewerPrimaryLang) {
      const langs = (row.languages as LanguageProficiency[] | null) ?? [];
      const candidatePrimary = langs[0]?.code;
      if (candidatePrimary === viewerPrimaryLang) return false;
    }
    return true;
  });

  // 티어 + 동일 티어 내 2차 점수 계산 → (tier ASC, intra DESC) 정렬.
  const scored = visible.map((row: any) => {
    const langs = (row.languages as LanguageProficiency[] | null) ?? [];
    const candidate: Candidate = {
      id: row.id,
      languages: langs,
      nationality: row.nationality,
      interests: row.interests ?? [],
      photos: row.photos ?? [],
      created_at: row.created_at,
    };
    return {
      ...row,
      // FE 호환: 응답에 단일 language 필드를 채워 보낸다 (DB 컬럼은 mig 008 에서 삭제됨).
      // primary 는 languages[0].code.
      language: langs[0]?.code ?? '',
      _tier: computeTier(candidate, viewerPrefs),
      _intra: computeIntraScore(candidate, viewer),
    };
  });

  scored.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    return b._intra - a._intra;
  });

  // 프론트에 반환할 때 내부 정렬 키와 created_at, languages 를 제외.
  // 보안 경계: discover 는 잠금 해제 대상이 아니므로 서버에서 photos 배열을 메인 1장으로 잘라
  //            본인 프로필 외 추가 사진 URL 노출을 원천 차단한다.
  //            photo_access 는 정책상 항상 false/false 고정 (FE 는 forceBlur 정책을 적용).
  const results = scored.slice(0, limit).map(({ _tier, _intra, created_at, languages, photos, ...rest }) => ({
    ...rest,
    photos: (photos ?? []).slice(0, 1),
    photo_access: { main_photo_unlocked: false, all_photos_unlocked: false },
  }));

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
router.post('/swipe', validateBody(swipeBodySchema), async (req: AuthRequest, res: Response) => {
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

  let match = null;
  if (direction === 'like') {
    const { data: reciprocal } = await supabase
      .from('swipes')
      .select('id')
      .eq('swiper_id', swiped_id)
      .eq('swiped_id', req.userId!)
      .eq('direction', 'like')
      .single();

    if (reciprocal) {
      const [user1, user2] = [req.userId!, swiped_id].sort();
      const { data: newMatch, error: matchError } = await supabase
        .from('matches')
        .insert({ user1_id: user1, user2_id: user2 })
        .select()
        .single();

      if (matchError?.code === '23505') {
        // 동시 like로 인한 중복 — 기존 매치 조회
        const { data: existing } = await supabase
          .from('matches')
          .select()
          .eq('user1_id', user1)
          .eq('user2_id', user2)
          .single();
        match = existing;
      } else if (!matchError) {
        match = newMatch;
      }
    }
  }

  res.json({ direction, match });
});

export default router;
