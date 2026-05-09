import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL1 = 'apitest_match1@testmail.com';
const EMAIL2 = 'apitest_match2@testmail.com';
let token1: string;
let userId1: string;
let token2: string;
let userId2: string;

describe('Match Routes', () => {
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
      display_name: 'Match User 1',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(token2, {
      display_name: 'Match User 2',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });

    // mutual like to create match
    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token1}`)
      .send({ swiped_id: userId2, direction: 'like' });

    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token2}`)
      .send({ swiped_id: userId1, direction: 'like' });
  });

  afterAll(async () => {
    await cleanupUser(userId1);
    await cleanupUser(userId2);
  });

  describe('GET /api/matches', () => {
    it('인증 없으면 401', async () => {
      const res = await request(app).get('/api/matches');
      expect(res.status).toBe(401);
    });

    it('매치 목록 조회 성공', async () => {
      const res = await request(app)
        .get('/api/matches')
        .set('Authorization', `Bearer ${token1}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0]).toHaveProperty('match_id');
      expect(res.body[0]).toHaveProperty('partner');

      // PhotoAccess: 매치 직후 메시지 0개 → round_trip_count=0 → 둘 다 false
      expect(res.body[0]).toHaveProperty('photo_access');
      expect(res.body[0].photo_access).toEqual({
        main_photo_unlocked: false,
        all_photos_unlocked: false,
      });

      // 보안 경계: all_photos_unlocked=false 이므로 서버가 photos 를 메인 1장 이하로 잘라낸다.
      if (res.body[0].partner) {
        expect(Array.isArray(res.body[0].partner.photos)).toBe(true);
        expect(res.body[0].partner.photos.length).toBeLessThanOrEqual(1);
      }
    });

    it('잘못된 limit이면 400', async () => {
      const res = await request(app)
        .get('/api/matches?limit=999')
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(400);
    });
  });

  // mig 013: tombstone 매치도 목록에 노출되고, 본인이 hide 하면 본인
  // 시야에서만 사라진다. 활성 매치 hide 는 거부.
  describe('Tombstone visibility + POST /:matchId/hide', () => {
    let matchId: string;

    beforeAll(async () => {
      // 직전 describe 의 mutual-like 매치 행 id 를 가져온다.
      const { data } = await supabase
        .from('matches')
        .select('id')
        .or(`user1_id.eq.${userId1},user2_id.eq.${userId1}`)
        .limit(1)
        .single();
      matchId = data!.id;
    });

    it('활성 매치 hide 시도는 400 MATCH_ACTIVE', async () => {
      // hidden_by 가 비어 있고 unmatched_at 도 NULL — 활성 상태.
      const res = await request(app)
        .post(`/api/matches/${matchId}/hide`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MATCH_ACTIVE');
    });

    it('언매치된 매치도 양쪽 목록에 노출됨 (tombstone)', async () => {
      // 직접 unmatched_at 을 채워 tombstone 상태로 전환.
      await supabase
        .from('matches')
        .update({ unmatched_at: new Date().toISOString(), unmatched_by: userId1 })
        .eq('id', matchId);

      const res1 = await request(app)
        .get('/api/matches')
        .set('Authorization', `Bearer ${token1}`);
      expect(res1.status).toBe(200);
      const found1 = res1.body.find((m: any) => m.match_id === matchId);
      expect(found1).toBeDefined();
      expect(found1.unmatched_at).not.toBeNull();

      const res2 = await request(app)
        .get('/api/matches')
        .set('Authorization', `Bearer ${token2}`);
      const found2 = res2.body.find((m: any) => m.match_id === matchId);
      expect(found2).toBeDefined();
    });

    it('tombstone 매치 hide 성공 → 본인 목록에서만 사라짐', async () => {
      const hideRes = await request(app)
        .post(`/api/matches/${matchId}/hide`)
        .set('Authorization', `Bearer ${token1}`);
      expect(hideRes.status).toBe(204);

      const res1 = await request(app)
        .get('/api/matches')
        .set('Authorization', `Bearer ${token1}`);
      const found1 = res1.body.find((m: any) => m.match_id === matchId);
      expect(found1).toBeUndefined();

      // 상대방은 자기 hidden_by 에 들어 있지 않으므로 그대로 보유.
      const res2 = await request(app)
        .get('/api/matches')
        .set('Authorization', `Bearer ${token2}`);
      const found2 = res2.body.find((m: any) => m.match_id === matchId);
      expect(found2).toBeDefined();
    });

    it('이미 hide 된 매치를 다시 hide 해도 204 (멱등)', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/hide`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(204);
    });

    it('존재하지 않는 매치 hide 는 404', async () => {
      const res = await request(app)
        .post('/api/matches/00000000-0000-0000-0000-000000000000/hide')
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(404);
    });
  });
});
