// audit cleanup sprint — sweepAuditTables() 365 일 cutoff 검증.
//
// 라이브 Supabase 로 4 audit 테이블 (moderation_blocks / freeze_events /
// reports / blocks) INSERT 후 sweep 결과 검증.
//   * moderation_blocks / freeze_events — message-moderation-v1 sprint (mig 020/021)
//   * reports / blocks — evidence-hold-on-delete sprint (mig 002)
// 미적용 환경은 silent skip (테이블 자체 부재).
//
// reports / blocks 는 (reporter_id != reported_id), (blocker_id != blocked_id)
// CHECK + UNIQUE 제약이 있어 두 user 가 필요. beforeAll 에 secondUserId 셋업.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabase } from '../src/config/supabase';
import { sweepAuditTables } from '../src/jobs/cleanupAuditTables';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL = 'apitest_auditcleanup@testmail.com';
const PARTNER_EMAIL = 'apitest_auditcleanup_partner@testmail.com';
let userId: string;
let secondUserId: string;
let skipReason: string | null = null;

async function tableMissing(
  table: 'moderation_blocks' | 'freeze_events' | 'reports' | 'blocks',
): Promise<boolean> {
  const probe = await supabase.from(table).select('id').limit(1);
  if (!probe.error) return false;
  return (
    probe.error.code === 'PGRST205' ||
    /not find the table/i.test(probe.error.message) ||
    /does not exist/i.test(probe.error.message)
  );
}

describe('sweepAuditTables — 365 일 cutoff', () => {
  beforeAll(async () => {
    if (
      (await tableMissing('moderation_blocks')) ||
      (await tableMissing('freeze_events')) ||
      (await tableMissing('reports')) ||
      (await tableMissing('blocks'))
    ) {
      skipReason =
        '[audit-cleanup] mig 020 / 021 / 002 (reports/blocks) not applied — skipping cleanup tests';
      // eslint-disable-next-line no-console
      console.warn(skipReason);
      return;
    }

    const auth = await getAuthToken(EMAIL);
    userId = auth.userId;
    await cleanupUser(userId);
    await createTestProfile(auth.token, {
      display_name: 'Audit Cleanup Test',
      language: 'ko',
      nationality: 'KR',
    });

    const partnerAuth = await getAuthToken(PARTNER_EMAIL);
    secondUserId = partnerAuth.userId;
    await cleanupUser(secondUserId);
    await createTestProfile(partnerAuth.token, {
      display_name: 'Audit Cleanup Partner',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });
  });

  afterAll(async () => {
    if (skipReason) return;
    // 본 테스트가 남긴 audit row 전부 정리 (cleanupUser 는 audit 테이블 일부만 정리)
    await supabase.from('moderation_blocks').delete().eq('sender_id', userId);
    await supabase.from('moderation_blocks').delete().eq('sender_id', secondUserId);
    await supabase.from('freeze_events').delete().eq('frozen_user_id', userId);
    await supabase.from('freeze_events').delete().eq('frozen_user_id', secondUserId);
    await supabase.from('reports').delete().eq('reporter_id', userId);
    await supabase.from('reports').delete().eq('reported_id', userId);
    await supabase.from('reports').delete().eq('reporter_id', secondUserId);
    await supabase.from('reports').delete().eq('reported_id', secondUserId);
    await supabase.from('blocks').delete().eq('blocker_id', userId);
    await supabase.from('blocks').delete().eq('blocked_id', userId);
    await supabase.from('blocks').delete().eq('blocker_id', secondUserId);
    await supabase.from('blocks').delete().eq('blocked_id', secondUserId);
    await cleanupUser(userId);
    await cleanupUser(secondUserId);
  });

  it('moderation_blocks: 365 일 이전 row DELETE, 이후 row 보존', async () => {
    if (skipReason) return;

    const longAgo = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const oldRow = await supabase
      .from('moderation_blocks')
      .insert({ sender_id: userId, category: 'sexual', language: 'ko', blocked_at: longAgo })
      .select('id')
      .single();
    const recentRow = await supabase
      .from('moderation_blocks')
      .insert({ sender_id: userId, category: 'drug', language: 'ko', blocked_at: recent })
      .select('id')
      .single();

    expect(oldRow.data?.id).toBeDefined();
    expect(recentRow.data?.id).toBeDefined();

    const result = await sweepAuditTables();
    expect(result.errors).toBe(0);
    expect(result.moderationDeleted).toBeGreaterThanOrEqual(1);

    const { data: remaining } = await supabase
      .from('moderation_blocks')
      .select('id')
      .in('id', [oldRow.data!.id, recentRow.data!.id]);

    const remainingIds = (remaining ?? []).map((r) => r.id);
    expect(remainingIds).not.toContain(oldRow.data!.id);
    expect(remainingIds).toContain(recentRow.data!.id);
  });

  it('freeze_events: 365 일 이전 row DELETE, 이후 row 보존', async () => {
    if (skipReason) return;

    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const oldRow = await supabase
      .from('freeze_events')
      .insert({
        frozen_user_id: userId,
        report_count_at_trigger: 3,
        reporter_ids: [],
        triggered_at: longAgo,
      })
      .select('id')
      .single();
    const recentRow = await supabase
      .from('freeze_events')
      .insert({
        frozen_user_id: userId,
        report_count_at_trigger: 5,
        reporter_ids: [],
        triggered_at: recent,
      })
      .select('id')
      .single();

    expect(oldRow.data?.id).toBeDefined();
    expect(recentRow.data?.id).toBeDefined();

    const result = await sweepAuditTables();
    expect(result.errors).toBe(0);
    expect(result.freezeDeleted).toBeGreaterThanOrEqual(1);

    const { data: remaining } = await supabase
      .from('freeze_events')
      .select('id')
      .in('id', [oldRow.data!.id, recentRow.data!.id]);

    const remainingIds = (remaining ?? []).map((r) => r.id);
    expect(remainingIds).not.toContain(oldRow.data!.id);
    expect(remainingIds).toContain(recentRow.data!.id);
  });

  it('reports: 365 일 이전 row DELETE, 이후 row 보존', async () => {
    if (skipReason) return;

    // reports UNIQUE (reporter_id, reported_id) 라 동시에 두 row 가 같은 쌍을
    // 못 가짐. old/recent 의 reporter-reported 방향을 뒤집어 두 row 셋업.
    //   old:    userId       → secondUserId
    //   recent: secondUserId → userId
    // 둘 다 cutoff 비교는 created_at 컬럼이라 방향 불문 sweep 동작 검증 충분.
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 격리 — 동일 (reporter, reported) 쌍의 stale row 가 있으면 INSERT 가 409.
    await supabase
      .from('reports')
      .delete()
      .eq('reporter_id', userId)
      .eq('reported_id', secondUserId);
    await supabase
      .from('reports')
      .delete()
      .eq('reporter_id', secondUserId)
      .eq('reported_id', userId);

    const oldRow = await supabase
      .from('reports')
      .insert({
        reporter_id: userId,
        reported_id: secondUserId,
        reason: 'spam',
        created_at: longAgo,
      })
      .select('id')
      .single();
    const recentRow = await supabase
      .from('reports')
      .insert({
        reporter_id: secondUserId,
        reported_id: userId,
        reason: 'inappropriate',
        created_at: recent,
      })
      .select('id')
      .single();

    expect(oldRow.data?.id).toBeDefined();
    expect(recentRow.data?.id).toBeDefined();

    const result = await sweepAuditTables();
    expect(result.errors).toBe(0);
    expect(result.reportsDeleted).toBeGreaterThanOrEqual(1);

    const { data: remaining } = await supabase
      .from('reports')
      .select('id')
      .in('id', [oldRow.data!.id, recentRow.data!.id]);

    const remainingIds = (remaining ?? []).map((r) => r.id);
    expect(remainingIds).not.toContain(oldRow.data!.id);
    expect(remainingIds).toContain(recentRow.data!.id);
  });

  it('blocks: 365 일 이전 row DELETE, 이후 row 보존', async () => {
    if (skipReason) return;

    // blocks UNIQUE (blocker_id, blocked_id) — reports 와 동일 패턴, 방향 분리.
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from('blocks')
      .delete()
      .eq('blocker_id', userId)
      .eq('blocked_id', secondUserId);
    await supabase
      .from('blocks')
      .delete()
      .eq('blocker_id', secondUserId)
      .eq('blocked_id', userId);

    const oldRow = await supabase
      .from('blocks')
      .insert({
        blocker_id: userId,
        blocked_id: secondUserId,
        created_at: longAgo,
      })
      .select('id')
      .single();
    const recentRow = await supabase
      .from('blocks')
      .insert({
        blocker_id: secondUserId,
        blocked_id: userId,
        created_at: recent,
      })
      .select('id')
      .single();

    expect(oldRow.data?.id).toBeDefined();
    expect(recentRow.data?.id).toBeDefined();

    const result = await sweepAuditTables();
    expect(result.errors).toBe(0);
    expect(result.blocksDeleted).toBeGreaterThanOrEqual(1);

    const { data: remaining } = await supabase
      .from('blocks')
      .select('id')
      .in('id', [oldRow.data!.id, recentRow.data!.id]);

    const remainingIds = (remaining ?? []).map((r) => r.id);
    expect(remainingIds).not.toContain(oldRow.data!.id);
    expect(remainingIds).toContain(recentRow.data!.id);
  });
});
