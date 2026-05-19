// message-moderation-v1 (PR2) — 신고 누적 자동 freeze 회귀.
//
// 흐름: N-1 신고 → freeze 미발생 / N 신고 → freeze 발생 + freeze_events INSERT /
// 이미 frozen 사용자에게 추가 신고 → freeze_events 중복 INSERT 차단 (.is('frozen_at',null)
// 가드의 idempotent 검증) / UNIQUE 제약으로 동일 reporter 중복 카운트 X.
//
// 통합 테스트 (실제 Supabase 호출). mig 021 (profiles.frozen_at + freeze_events) 미적용
// 환경에서는 silent skip — fire-and-forget 패턴이라 응답 자체는 정상 201.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { env } from '../src/config/env';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const REPORTED_EMAIL = 'apitest_freeze_reported@testmail.com';
const REPORTER_PREFIX = 'apitest_freeze_reporter';

let reportedUserId: string;
let reporterTokens: string[] = [];
let reporterIds: string[] = [];

// 본 테스트는 threshold=3 기준으로 동작. env 가 다른 값이면 가시화하고 skip.
const THRESHOLD = env.moderation.autoFreezeReportThreshold;

async function freezeEventsTableMissing(): Promise<boolean> {
  const probe = await supabase.from('freeze_events').select('id').limit(1);
  if (!probe.error) return false;
  return (
    probe.error.code === 'PGRST205' ||
    /not find the table/i.test(probe.error.message) ||
    /does not exist/i.test(probe.error.message)
  );
}

async function profilesFrozenAtColumnMissing(): Promise<boolean> {
  // frozen_at 컬럼 미적용이면 select 자체가 에러
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

async function resetReportedUserFreezeState(userId: string): Promise<void> {
  await supabase
    .from('profiles')
    .update({ is_active: true, frozen_at: null })
    .eq('id', userId);
  await supabase.from('freeze_events').delete().eq('frozen_user_id', userId);
  // reports 도 초기화 — 다음 시나리오의 누적 카운트 격리.
  await supabase.from('reports').delete().eq('reported_id', userId);
  await supabase.from('blocks').delete().eq('blocked_id', userId);
}

describe('POST /api/report — auto-freeze (PR2)', () => {
  beforeAll(async () => {
    // reported user 1명 + reporter THRESHOLD+1 명 준비.
    const reportedAuth = await getAuthToken(REPORTED_EMAIL);
    reportedUserId = reportedAuth.userId;
    await cleanupUser(reportedUserId);
    await createTestProfile(reportedAuth.token, {
      display_name: 'Reported User',
      language: 'ko',
      nationality: 'KR',
    });

    // 임계치 + 1 명까지 준비 (idempotency 회귀 검증용)
    reporterTokens = [];
    reporterIds = [];
    for (let i = 0; i < THRESHOLD + 1; i++) {
      const email = `${REPORTER_PREFIX}${i}@testmail.com`;
      const auth = await getAuthToken(email);
      await cleanupUser(auth.userId);
      await createTestProfile(auth.token, {
        display_name: `Reporter ${i}`,
        language: 'ja',
        nationality: 'JP',
        gender: 'female',
      });
      reporterTokens.push(auth.token);
      reporterIds.push(auth.userId);
    }
  });

  afterAll(async () => {
    // freeze_events / reports / profile 일괄 정리
    if (!(await freezeEventsTableMissing())) {
      await supabase.from('freeze_events').delete().eq('frozen_user_id', reportedUserId);
    }
    await cleanupUser(reportedUserId);
    for (const id of reporterIds) {
      await cleanupUser(id);
    }
  });

  beforeEach(async () => {
    if (await profilesFrozenAtColumnMissing()) return;
    await resetReportedUserFreezeState(reportedUserId);
  });

  it('임계치 미달 (THRESHOLD-1 건 신고) → freeze 발생 X', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[reportAutoFreeze.test] mig 021 not applied — skipping');
      return;
    }

    // THRESHOLD-1 명의 reporter 가 신고.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const res = await request(app)
        .post('/api/report')
        .set('Authorization', `Bearer ${reporterTokens[i]}`)
        .send({ reported_id: reportedUserId, reason: 'spam' });
      expect([201, 409]).toContain(res.status);
    }

    // freeze 발생 안 했는지 확인.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_active, frozen_at')
      .eq('id', reportedUserId)
      .single();
    expect(profile?.is_active).toBe(true);
    expect(profile?.frozen_at).toBeNull();

    // freeze_events 도 비어있어야 함.
    if (!(await freezeEventsTableMissing())) {
      const { count } = await supabase
        .from('freeze_events')
        .select('id', { count: 'exact', head: true })
        .eq('frozen_user_id', reportedUserId);
      expect(count ?? 0).toBe(0);
    }
  });

  it('임계치 도달 (THRESHOLD 건 신고) → freeze + freeze_events INSERT', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[reportAutoFreeze.test] mig 021 not applied — skipping');
      return;
    }

    // THRESHOLD 명의 distinct reporter 신고.
    for (let i = 0; i < THRESHOLD; i++) {
      const res = await request(app)
        .post('/api/report')
        .set('Authorization', `Bearer ${reporterTokens[i]}`)
        .send({ reported_id: reportedUserId, reason: 'inappropriate' });
      expect([201, 409]).toContain(res.status);
    }

    // 짧게 대기 — evaluateAutoFreeze 는 await 으로 동기 호출되지만 보수적으로 대기.
    await new Promise((r) => setTimeout(r, 200));

    // freeze 적용 확인.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_active, frozen_at')
      .eq('id', reportedUserId)
      .single();
    expect(profile?.is_active).toBe(false);
    expect(profile?.frozen_at).toBeTruthy();

    // freeze_events 1건 INSERT 확인.
    if (await freezeEventsTableMissing()) {
      console.warn('[reportAutoFreeze.test] freeze_events table missing — skipping audit verification');
      return;
    }
    const { data: events, count } = await supabase
      .from('freeze_events')
      .select('frozen_user_id, report_count_at_trigger, reporter_ids', { count: 'exact' })
      .eq('frozen_user_id', reportedUserId);
    expect(count).toBe(1);
    expect(events?.[0].report_count_at_trigger).toBeGreaterThanOrEqual(THRESHOLD);
    expect(events?.[0].reporter_ids?.length).toBeGreaterThanOrEqual(THRESHOLD);
    // distinct reporter 확인 — UNIQUE 제약상 자동이지만 가시화.
    const unique = new Set(events?.[0].reporter_ids as string[]);
    expect(unique.size).toBe(events?.[0].reporter_ids?.length);
  });

  it('이미 freeze 된 사용자 추가 신고 → freeze_events 중복 INSERT X (idempotent)', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[reportAutoFreeze.test] mig 021 not applied — skipping');
      return;
    }
    if (await freezeEventsTableMissing()) return;

    // 격리: 신고 3건 시뮬레이션 + read-after-write race 회피 위해
    // 직접 frozen + freeze_events 1건 INSERT 로 setup (라이브 DB 통합 테스트의
    // beforeEach reset 직후 stale read 회귀를 피한다).
    await supabase
      .from('profiles')
      .update({ is_active: false, frozen_at: new Date().toISOString() })
      .eq('id', reportedUserId);
    await supabase.from('reports').insert(
      Array.from({ length: THRESHOLD }, (_, i) => ({
        reporter_id: reporterIds[i],
        reported_id: reportedUserId,
        reason: 'first wave',
      })),
    );
    await supabase.from('freeze_events').insert({
      frozen_user_id: reportedUserId,
      report_count_at_trigger: THRESHOLD,
      reporter_ids: reporterIds.slice(0, THRESHOLD),
    });

    const before = await supabase
      .from('freeze_events')
      .select('id', { count: 'exact', head: true })
      .eq('frozen_user_id', reportedUserId);
    expect(before.count).toBe(1);

    // 추가 reporter 가 신고 (THRESHOLD+1 번째).
    await request(app)
      .post('/api/report')
      .set('Authorization', `Bearer ${reporterTokens[THRESHOLD]}`)
      .send({ reported_id: reportedUserId, reason: 'after freeze' });
    await new Promise((r) => setTimeout(r, 200));

    // freeze_events 여전히 1건 (.is('frozen_at', null) 가드로 두 번째 UPDATE 0 rows
    // → updated.length===0 → audit INSERT skip).
    const after = await supabase
      .from('freeze_events')
      .select('id', { count: 'exact', head: true })
      .eq('frozen_user_id', reportedUserId);
    expect(after.count).toBe(1);
  });

  it('동일 reporter 중복 신고 → reports UNIQUE 제약으로 카운트 증가 X', async () => {
    if (await profilesFrozenAtColumnMissing()) {
      console.warn('[reportAutoFreeze.test] mig 021 not applied — skipping');
      return;
    }

    // 1번 reporter 가 THRESHOLD 번 신고 시도 (1번째만 성공, 나머지는 409).
    const responses: number[] = [];
    for (let i = 0; i < THRESHOLD; i++) {
      const res = await request(app)
        .post('/api/report')
        .set('Authorization', `Bearer ${reporterTokens[0]}`)
        .send({ reported_id: reportedUserId, reason: 'spam' });
      responses.push(res.status);
    }
    // 첫 번째는 201 (혹은 신고 직후 차단 자동 등록 409 가능)
    expect([201, 409]).toContain(responses[0]);
    // 나머지는 409 (Already reported)
    for (let i = 1; i < responses.length; i++) {
      expect(responses[i]).toBe(409);
    }

    // freeze 미발생 — 누적 count 가 1건.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_active, frozen_at')
      .eq('id', reportedUserId)
      .single();
    expect(profile?.is_active).toBe(true);
    expect(profile?.frozen_at).toBeNull();
  });
});
