import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';
import {
  computeTier,
  computeIntraScore,
  matchesLanguage,
  matchesNationality,
  pickViewerSlot,
} from '../src/routes/swipe';

const EMAIL1 = 'apitest_swipe1@testmail.com';
const EMAIL2 = 'apitest_swipe2@testmail.com';
let token1: string;
let userId1: string;
let token2: string;
let userId2: string;

describe('Swipe Routes', () => {
  beforeAll(async () => {
    const auth1 = await getAuthToken(EMAIL1);
    const auth2 = await getAuthToken(EMAIL2);
    token1 = auth1.token;
    userId1 = auth1.userId;
    token2 = auth2.token;
    userId2 = auth2.userId;

    await cleanupUser(userId1);
    await cleanupUser(userId2);

    await createTestProfile(token1, {
      display_name: 'Swipe User 1',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(token2, {
      display_name: 'Swipe User 2',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });
  });

  afterAll(async () => {
    await cleanupUser(userId1);
    await cleanupUser(userId2);
  });

  describe('GET /api/discover', () => {
    it('인증 없으면 401', async () => {
      const res = await request(app).get('/api/discover');
      expect(res.status).toBe(401);
    });

    it('후보 목록 조회 성공', async () => {
      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${token1}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      // PhotoAccess: discover 는 잠금 해제 대상이 아님 → 항상 false/false,
      // 서버는 photos 를 메인 1장으로 필터링 (길이 0 또는 1).
      if (res.body.length > 0) {
        const candidate = res.body[0];
        expect(candidate).toHaveProperty('photo_access');
        expect(candidate.photo_access).toEqual({
          main_photo_unlocked: false,
          all_photos_unlocked: false,
        });
        expect(Array.isArray(candidate.photos)).toBe(true);
        expect(candidate.photos.length).toBeLessThanOrEqual(1);
      }
    });
  });

  // 4-단계 티어 단위 회귀. 변경 전엔 2-단계(부합/미부합)였음 — 본 묶음은
  // 국가/언어 차원의 상호작용·빈 선호의 무력화·정렬 키 안정성을 일반화된 형태로
  // 고정해, 향후 누군가 차원 우선순위를 뒤집거나 빈 차원 처리를 바꿀 때 즉시
  // 실패하도록 한다. swipe 라우트의 통합 테스트만으로는 후보 모집단을
  // 통제하기 어려워 정렬 정합성 회귀를 잡지 못한다.
  describe('computeTier (4-tier ranking)', () => {
    const C = (over: Partial<{ language: string; nationality: string }> = {}) => ({
      id: 'cand',
      language: 'ja',
      nationality: 'JP',
      interests: [] as string[],
      photos: [] as string[],
      created_at: new Date().toISOString(),
      ...over,
    });

    it('T1: 국가+언어 둘 다 부합', () => {
      expect(computeTier(C(), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      })).toBe(1);
    });

    it('T2: 국가만 부합 (언어 미부합)', () => {
      expect(computeTier(C({ language: 'en' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      })).toBe(2);
    });

    it('T3: 언어만 부합 (국가 미부합)', () => {
      expect(computeTier(C({ nationality: 'US' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      })).toBe(3);
    });

    it('T4: 둘 다 미부합', () => {
      expect(computeTier(C({ language: 'en', nationality: 'US' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      })).toBe(4);
    });

    it('국가 부합이 언어 부합보다 우선 (T2 < T3)', () => {
      // 정책: 같은 국적이 같은 언어보다 더 높은 매칭 시그널.
      const onlyNat = computeTier(C({ language: 'en' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      });
      const onlyLang = computeTier(C({ nationality: 'US' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: ['JP'],
      });
      expect(onlyNat).toBeLessThan(onlyLang);
    });

    it('preferred_languages 비어있으면 T1 (nat 부합) 또는 T3 (nat 미부합) 으로 분기', () => {
      // 현재 구현 동작 회귀 가드. 빈 lang 선호 시 langOk 가 항상 true 이므로
      // T2(natOk ∧ ¬langOk) 분기는 도달 불가능 — 결과는 T1/T3 로 갈린다.
      // !!경계면 비대칭 알림!! CLAUDE.md(haru_BE) "비어있는 차원은 티어 분기에서
      // 사실상 무력화 (예: 언어 선호만 비어있으면 모두 T1/T2 로 수렴)" 문구는
      // 코드 동작과 다르다 (T1/T3 가 맞음). 문서/사양 정합성은 architect 결정 대상.
      // 본 테스트는 코드 현재 동작을 잠그는 회귀 가드로, 동작을 바꾸려면 본 테스트도
      // 함께 갱신 필요.
      const sample = [
        C({ language: 'en', nationality: 'JP' }),
        C({ language: 'ja', nationality: 'JP' }),
        C({ language: 'th', nationality: 'JP' }),
        C({ language: 'hi', nationality: 'US' }),
        C({ language: 'en', nationality: 'KR' }),
      ];
      const tiers = sample.map((c) => computeTier(c, {
        preferred_languages: [],
        preferred_nationalities: ['JP'],
      }));
      expect(tiers.every((t) => t === 1 || t === 3)).toBe(true);
      // T2/T4 는 도달 불가 (빈 lang 선호 → langOk 항상 true).
      expect(tiers).not.toContain(2);
      expect(tiers).not.toContain(4);
      expect(tiers).toEqual([1, 1, 1, 3, 3]);
    });

    it('preferred_nationalities 비어있으면 T1 (lang 부합) 또는 T2 (lang 미부합) 으로 분기', () => {
      // 빈 nat 선호 → natOk 항상 true → T3/T4 분기 도달 불가능, T1/T2 만.
      // (lang 빈 선호 케이스와 비대칭 — "국가 우선" 정책의 부산물).
      const sample = [
        C({ language: 'ja', nationality: 'JP' }),
        C({ language: 'ja', nationality: 'US' }),
        C({ language: 'en', nationality: 'JP' }),
        C({ language: 'en', nationality: 'US' }),
      ];
      const tiers = sample.map((c) => computeTier(c, {
        preferred_languages: ['ja'],
        preferred_nationalities: [],
      }));
      expect(tiers.every((t) => t === 1 || t === 2)).toBe(true);
      expect(tiers).toEqual([1, 1, 2, 2]);
      expect(tiers).not.toContain(3);
      expect(tiers).not.toContain(4);
    });

    it('두 선호 모두 비어있으면 모든 후보가 T1', () => {
      const sample = [
        C({ language: 'ja', nationality: 'JP' }),
        C({ language: 'en', nationality: 'US' }),
        C({ language: 'th', nationality: 'TH' }),
        C({ language: '', nationality: 'KR' }), // 언어 빈 값(보통은 SQL 단계에서 걸러짐)
      ];
      const tiers = sample.map((c) => computeTier(c, {
        preferred_languages: [],
        preferred_nationalities: [],
      }));
      expect(tiers).toEqual([1, 1, 1, 1]);
    });

    it('후보 language 가 빈 문자열이면, 비어있지 않은 preferred_languages 기준 T3/T4 로 분류', () => {
      // 정책 회귀 가드: SQL 필터에서 NULL/empty language 행은 visible 단계에서
      // 제거되지만, 여기 매칭 함수가 직접 호출됐을 때 빈 language 가 실수로
      // langOk=true 로 분류되면(예: includes('') 성립) 티어 신호가 망가진다.
      const langOk = matchesLanguage(C({ language: '' }), {
        preferred_languages: ['ja'],
        preferred_nationalities: [],
      });
      expect(langOk).toBe(false);
    });

    it('matchesNationality: 빈 선호 → 모든 후보 부합', () => {
      expect(matchesNationality(C({ nationality: 'KR' }), {
        preferred_languages: [],
        preferred_nationalities: [],
      })).toBe(true);
    });
  });

  describe('computeIntraScore (intra-tier secondary sort)', () => {
    const baseCand = {
      id: 'cand',
      language: 'ja',
      nationality: 'JP',
      interests: ['music', 'travel'] as string[],
      photos: ['p1', 'p2', 'p3'] as string[],
      created_at: new Date().toISOString(),
    };
    const viewer = { id: 'viewer', interests: ['music', 'travel', 'food'] };

    it('기본 신호 합산 상한이 65 (reciprocity 없을 때)', () => {
      // 기본 신호: 관심사 3개+ 겹침(30) + 사진 3장+(10) + 신규 7일(10) + jitter max(<15) = <65.
      // 티어 경계 보호는 합산 상한이 아니라 정렬 키 우선순위(tier ASC > intra DESC)가
      // 담당 — reciprocity boost 가 추가되면서 본 상한은 "기본 신호 한정" 의미로 좁아짐.
      const score = computeIntraScore(
        { ...baseCand, interests: ['music', 'travel', 'food'] },
        viewer,
      );
      expect(score).toBeLessThan(65);
      expect(score).toBeGreaterThanOrEqual(50); // 30 + 10 + 10 + jitter≥0
    });

    it('reciprocity 신호 있으면 +50 가산 (같은 티어 내 다른 신호 압도)', () => {
      // 후보가 이미 viewer 를 like 한 경우, 동일 후보·viewer 쌍에 대한 점수가
      // 정확히 +50 만큼 증가. jitter 가 결정적이라 차분 비교가 정확함.
      const withoutBoost = computeIntraScore(baseCand, viewer);
      const withBoost = computeIntraScore(baseCand, viewer, new Set([baseCand.id]));
      // jitter 의 /100 나눗셈으로 부동소수점 차분 정밀도가 잠재적으로 깨질 수 있어
      // toBeCloseTo(2 dp) 로 비교. 의미상 정확히 +50.
      expect(withBoost - withoutBoost).toBeCloseTo(50, 2);
    });

    it('reciprocity 신호는 해당 후보에만 적용 (다른 후보 점수 불변)', () => {
      // 풀에 'cand' 만 있고 'other' 는 없으면, 'other' 점수는 기본 신호 그대로.
      const reciprocal = new Set([baseCand.id]);
      const other = { ...baseCand, id: 'other' };
      const otherWithout = computeIntraScore(other, viewer);
      const otherWith = computeIntraScore(other, viewer, reciprocal);
      expect(otherWith).toBeCloseTo(otherWithout, 6);
    });

    it('reciprocity 가 커도 티어 경계는 넘지 않음 (정렬 키 우선순위)', () => {
      // 정렬 비교 함수 (tier ASC, intra DESC). 1차 키가 tier 라 intra 가 아무리
      // 커져도 더 낮은(=더 우선) 티어 후보 위로 못 올라간다. reciprocity +50 이
      // 65 → 115 로 합산을 끌어올려도 본 회귀로 보호됨.
      type Scored = { _tier: number; _intra: number; id: string };
      const cmp = (a: Scored, b: Scored) =>
        a._tier !== b._tier ? a._tier - b._tier : b._intra - a._intra;
      const list: Scored[] = [
        { id: 'reciprocal_t2', _tier: 2, _intra: 115 }, // reciprocity 만점 T2
        { id: 'plain_t1', _tier: 1, _intra: 0 },        // 기본 T1
      ];
      list.sort(cmp);
      expect(list.map((x) => x.id)).toEqual(['plain_t1', 'reciprocal_t2']);
    });

    it('관심사 0 겹침이면 0 (사진/신규 가산 빼고)', () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const score = computeIntraScore(
        { ...baseCand, interests: ['gaming'], photos: ['p1'], created_at: oldDate },
        { id: 'viewer', interests: ['music'] },
      );
      // 관심사 0, 사진 < 3, 30일 → jitter 만 남음.
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(15);
    });

    it('jitter 는 동일 viewer-candidate 쌍에 대해 결정적', () => {
      // 페이지네이션 안정성 보장. 두 번 호출이 같은 값이어야 함.
      const a = computeIntraScore(baseCand, viewer);
      const b = computeIntraScore(baseCand, viewer);
      expect(a).toBe(b);
    });

    it('jitter 는 viewer-candidate 쌍이 다르면 다른 분포', () => {
      // 다양성 확보 보장 — 모든 후보가 같은 jitter 받으면 그 자체가 sort 키로
      // 무력해진다. 표본 수가 적어 통계 검정은 못 하지만 최소한 동일하지는 않아야.
      const c1 = computeIntraScore({ ...baseCand, id: 'a' }, viewer);
      const c2 = computeIntraScore({ ...baseCand, id: 'b' }, viewer);
      const c3 = computeIntraScore({ ...baseCand, id: 'c' }, viewer);
      const set = new Set([c1, c2, c3]);
      expect(set.size).toBeGreaterThan(1);
    });
  });

  describe('Sort key (tier ASC, intra DESC)', () => {
    // 라우트 내부 정렬 로직을 직접 검증할 수 없으므로, 동일 비교 함수를 여기 재현해
    // 4-단계 티어가 정렬에 정상 반영됨을 회귀로 고정한다. 라우트 정렬 비교가
    // 바뀌면 이 테스트는 그대로지만, 정렬 비교 자체에 대한 회귀 가드는
    // 본 테스트가 사양 문서 역할을 한다.
    type Scored = { _tier: number; _intra: number; id: string };
    const cmp = (a: Scored, b: Scored) =>
      a._tier !== b._tier ? a._tier - b._tier : b._intra - a._intra;

    it('티어가 다르면 intra 점수에 관계없이 낮은 티어가 앞', () => {
      const list: Scored[] = [
        { id: 'a', _tier: 4, _intra: 60 },
        { id: 'b', _tier: 1, _intra: 0 },
        { id: 'c', _tier: 3, _intra: 50 },
        { id: 'd', _tier: 2, _intra: 5 },
      ];
      list.sort(cmp);
      expect(list.map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
    });

    it('동일 티어 내에서는 intra 점수 내림차순', () => {
      const list: Scored[] = [
        { id: 'a', _tier: 2, _intra: 10 },
        { id: 'b', _tier: 2, _intra: 50 },
        { id: 'c', _tier: 2, _intra: 30 },
      ];
      list.sort(cmp);
      expect(list.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    });
  });

  // mig 011: voice intro 다국어 슬롯 분기 단위 테스트.
  // 디스커버 hot path 의 시청자 언어 → ko/ja/en 슬롯 매핑 + 폴백 정책을 잠근다.
  describe('pickViewerSlot (voice intro multi-lang viewer mapping)', () => {
    it('viewer language ko → ko slot', () => {
      expect(pickViewerSlot('ko')).toBe('ko');
    });
    it('viewer language ja → ja slot', () => {
      expect(pickViewerSlot('ja')).toBe('ja');
    });
    it('viewer language en → en slot', () => {
      expect(pickViewerSlot('en')).toBe('en');
    });
    it('viewer language th → en (영문 폴백)', () => {
      expect(pickViewerSlot('th')).toBe('en');
    });
    it('viewer language hi → en (영문 폴백)', () => {
      expect(pickViewerSlot('hi')).toBe('en');
    });
    it('viewer language null → en (안전 폴백)', () => {
      expect(pickViewerSlot(null)).toBe('en');
    });
    it('viewer language undefined → en (안전 폴백)', () => {
      expect(pickViewerSlot(undefined)).toBe('en');
    });
  });

  describe('GET /api/discover/likes-received', () => {
    it('인증 없으면 401', async () => {
      const res = await request(app).get('/api/discover/likes-received');
      expect(res.status).toBe(401);
    });

    it('받은 좋아요 풀이 비어있으면 빈 배열', async () => {
      // 본 테스트에서는 user1 이 user2 를 'pass' 만 한 상태 (앞 POST swipe 테스트).
      // user1 에게 들어온 like 는 없으므로 받은 좋아요 목록은 비어 있어야.
      const res = await request(app)
        .get('/api/discover/likes-received')
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    it('응답 shape 이 디스커버 카드와 동일 (사진 1장, photo_access 잠금)', async () => {
      // 사용자 풀에 본 테스트가 단독으로 like 후보를 주입하지 못해, 비어있을 수도 있음.
      // 비어있지 않다면 shape 회귀만 검증.
      const res = await request(app)
        .get('/api/discover/likes-received')
        .set('Authorization', `Bearer ${token2}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        const card = res.body[0];
        expect(card).toHaveProperty('id');
        expect(card).toHaveProperty('photo_access');
        expect(card.photo_access).toEqual({
          main_photo_unlocked: false,
          all_photos_unlocked: false,
        });
        expect(Array.isArray(card.photos)).toBe(true);
        expect(card.photos.length).toBeLessThanOrEqual(1);
        expect(card).toHaveProperty('voice_intro_audio_url');
      }
    });

    // 정렬 키 회귀 가드 — 라우트 내부 정렬 비교 함수를 직접 검증할 수 없으므로
    // 동일 비교 함수를 재현. 디스커버는 (tier ASC, intra DESC) 였고 받은 좋아요는
    // (tier ASC, like 시각 DESC) — 2차 키만 다름. like 시각 DESC 는 BE 에서
    // `eligibleIds` 인덱스 ASC 와 동치 (1단계 시간 역순 조회).
    describe('Sort key (tier ASC, like 시각 DESC)', () => {
      type Scored = { _tier: number; _likeIndex: number; id: string };
      const cmp = (a: Scored, b: Scored) =>
        a._tier !== b._tier ? a._tier - b._tier : a._likeIndex - b._likeIndex;

      it('티어가 다르면 like 시각에 관계없이 낮은 티어가 앞', () => {
        // T1 이지만 가장 오래된 like 가, T2 의 가장 최근 like 보다 앞.
        const list: Scored[] = [
          { id: 't2_recent', _tier: 2, _likeIndex: 0 },
          { id: 't1_old', _tier: 1, _likeIndex: 100 },
        ];
        list.sort(cmp);
        expect(list.map((x) => x.id)).toEqual(['t1_old', 't2_recent']);
      });

      it('동일 티어 안에선 like 시각 DESC (인덱스 ASC = 시각 DESC)', () => {
        // eligibleIds 가 시간 역순으로 정렬되어 있으므로 인덱스 0 = 가장 최근.
        const list: Scored[] = [
          { id: 'oldest', _tier: 1, _likeIndex: 5 },
          { id: 'newest', _tier: 1, _likeIndex: 0 },
          { id: 'middle', _tier: 1, _likeIndex: 2 },
        ];
        list.sort(cmp);
        expect(list.map((x) => x.id)).toEqual(['newest', 'middle', 'oldest']);
      });

      it('티어 경계 + 같은 티어 내 시간순 종합', () => {
        const list: Scored[] = [
          { id: 't4_newest', _tier: 4, _likeIndex: 0 },
          { id: 't1_old', _tier: 1, _likeIndex: 10 },
          { id: 't2_recent', _tier: 2, _likeIndex: 1 },
          { id: 't1_recent', _tier: 1, _likeIndex: 2 },
          { id: 't2_old', _tier: 2, _likeIndex: 8 },
        ];
        list.sort(cmp);
        expect(list.map((x) => x.id)).toEqual([
          't1_recent', // T1 최근
          't1_old',    // T1 오래
          't2_recent', // T2 최근
          't2_old',    // T2 오래
          't4_newest', // T4 (시각 무관 후순위)
        ]);
      });
    });
  });

  describe('POST /api/discover/swipe', () => {
    it('필수 필드 없으면 400', async () => {
      const res = await request(app)
        .post('/api/discover/swipe')
        .set('Authorization', `Bearer ${token1}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('pass 스와이프 성공', async () => {
      const res = await request(app)
        .post('/api/discover/swipe')
        .set('Authorization', `Bearer ${token1}`)
        .send({ swiped_id: userId2, direction: 'pass' });

      expect(res.status).toBe(200);
      expect(res.body.direction).toBe('pass');
    });

    it('중복 스와이프면 409', async () => {
      const res = await request(app)
        .post('/api/discover/swipe')
        .set('Authorization', `Bearer ${token1}`)
        .send({ swiped_id: userId2, direction: 'pass' });

      expect(res.status).toBe(409);
    });
  });
});
