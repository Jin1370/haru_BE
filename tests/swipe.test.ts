import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';
import {
  computeTier,
  computeIntraScore,
  matchesLanguage,
  matchesNationality,
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

    it('합산 상한이 65 이내 (티어 경계 보호)', () => {
      // intra 점수 어떤 가산도 65를 넘으면 안 됨 — 그 경우 다른 티어 후보보다
      // 상위로 올라가는 정렬 버그가 발생한다.
      // 최대 케이스: 관심사 3개+ 겹침(30) + 사진 3장+(10) + 신규 7일(10) + jitter max(<15) = <65
      const score = computeIntraScore(
        { ...baseCand, interests: ['music', 'travel', 'food'] },
        viewer,
      );
      expect(score).toBeLessThan(65);
      expect(score).toBeGreaterThanOrEqual(50); // 30 + 10 + 10 + jitter≥0
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
