// message-moderation-v1 (PR2) — requireNotFrozen 미들웨어 회귀.
//
// 가드 적용 라우트 (architect plan Section 5 의 회귀 매트릭스):
//   * POST /api/discover/swipe
//   * POST /api/matches/:matchId/messages
//   * POST /api/matches/:matchId/hide
//   * PUT  /api/profile/me
//   * POST /api/profile/photos
//   * DELETE /api/profile/photos/:index
//   * POST /api/voice/clone
//
// freeze 상태는 직접 SQL UPDATE 로 frozen_at = now() / is_active = false set.
// (실제 freeze 트리거는 reportAutoFreeze.test.ts 에서 검증.)
//
// 가드 통과 시는 다음 핸들러로 넘어가는지 (200/201/202/400/404 등 라우트 고유 응답)
// 검증. 가드 차단 시는 403 + code: 'account_frozen' + 다음 핸들러 미실행.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const FROZEN_EMAIL = 'apitest_frozen_user@testmail.com';
const PARTNER_EMAIL = 'apitest_frozen_partner@testmail.com';

let frozenToken: string;
let frozenUserId: string;
let partnerToken: string;
let partnerUserId: string;
let matchId: string | undefined;

async function profilesFrozenAtColumnMissing(): Promise<boolean> {
  const probe = await supabase
    .from('profiles')
    .select('frozen_at')
    .limit(1);
  if (!probe.error) return false;
  return (
    /frozen_at/i.test(probe.error.message) &&
    /does not exist|undefined column/i.test(probe.error.message)
  );
}

async function setFrozen(userId: string, frozen: boolean): Promise<void> {
  await supabase
    .from('profiles')
    .update({
      is_active: !frozen,
      frozen_at: frozen ? new Date().toISOString() : null,
    })
    .eq('id', userId);
}

describe('requireNotFrozen middleware (PR2)', () => {
  beforeAll(async () => {
    const auth1 = await getAuthToken(FROZEN_EMAIL);
    const auth2 = await getAuthToken(PARTNER_EMAIL);
    frozenToken = auth1.token;
    frozenUserId = auth1.userId;
    partnerToken = auth2.token;
    partnerUserId = auth2.userId;

    await cleanupUser(frozenUserId);
    await cleanupUser(partnerUserId);

    await createTestProfile(frozenToken, {
      display_name: 'Frozen User',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(partnerToken, {
      display_name: 'Partner',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });

    // mutual like → 매치 생성 (freeze 전에).
    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${frozenToken}`)
      .send({ swiped_id: partnerUserId, direction: 'like' });
    const swipeRes = await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${partnerToken}`)
      .send({ swiped_id: frozenUserId, direction: 'like' });
    matchId = swipeRes.body.match?.id;
  });

  afterAll(async () => {
    // freeze 해제 후 정리.
    if (!(await profilesFrozenAtColumnMissing())) {
      await setFrozen(frozenUserId, false);
    }
    await cleanupUser(frozenUserId);
    await cleanupUser(partnerUserId);
  });

  beforeEach(async () => {
    if (await profilesFrozenAtColumnMissing()) return;
    await setFrozen(frozenUserId, true);
  });

  it('freeze 사용자 POST /api/discover/swipe → 403 account_frozen', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[freezeGuard.test] mig 021 not applied — skipping');
      return;
    }
    const res = await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${frozenToken}`)
      .send({ swiped_id: partnerUserId, direction: 'like' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_frozen');
  });

  it('freeze 사용자 POST /api/matches/:matchId/messages → 403 account_frozen (isBlocked 호출 전)', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[freezeGuard.test] mig 021 not applied — skipping');
      return;
    }
    if (!matchId) {
      console.warn('[freezeGuard.test] matchId not set (mutual swipe failed in beforeAll) — skipping');
      return;
    }
    // 메시지 본문에 차단 단어 포함 — 가드가 먼저 발화하므로 422 가 아닌 403.
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${frozenToken}`)
      .send({ text: '필로폰 어디서 사' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_frozen');
  });

  it('freeze 사용자 PUT /api/profile/me → 403 account_frozen', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[freezeGuard.test] mig 021 not applied — skipping');
      return;
    }
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${frozenToken}`)
      .send({
        display_name: 'Renamed',
        birth_date: '1995-01-01',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_frozen');
  });

  it('freeze 사용자 GET /api/profile/me 는 허용 (의도된 비스코프 면)', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[freezeGuard.test] mig 021 not applied — skipping');
      return;
    }
    // GET 라우트는 가드 미적용 — 본인 프로필 조회는 freeze 상태에서도 가능 (회귀 매트릭스 #9).
    const res = await request(app)
      .get('/api/profile/me')
      .set('Authorization', `Bearer ${frozenToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(frozenUserId);
  });

  it('freeze 해제 후 동일 라우트 정상 통과 (회귀)', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[freezeGuard.test] mig 021 not applied — skipping');
      return;
    }
    // 해제.
    await setFrozen(frozenUserId, false);

    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${frozenToken}`)
      .send({
        display_name: 'Unfrozen',
        birth_date: '1995-01-01',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
      });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Unfrozen');
  });
});
