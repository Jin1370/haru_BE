// audit cleanup sprint — sweepAuditTables() 365 일 cutoff 검증.
//
// 라이브 Supabase 로 moderation_blocks / freeze_events INSERT 후 sweep 결과
// 검증. mig 020 / 021 미적용 환경은 silent skip (테이블 자체 부재).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabase } from '../src/config/supabase';
import { sweepAuditTables } from '../src/jobs/cleanupAuditTables';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL = 'apitest_auditcleanup@testmail.com';
let userId: string;
let skipReason: string | null = null;

async function tableMissing(table: 'moderation_blocks' | 'freeze_events'): Promise<boolean> {
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
    if ((await tableMissing('moderation_blocks')) || (await tableMissing('freeze_events'))) {
      skipReason =
        '[audit-cleanup] mig 020 / 021 not applied — skipping cleanup tests';
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
  });

  afterAll(async () => {
    if (skipReason) return;
    // 본 테스트가 남긴 audit row 전부 정리 (cleanupUser 는 audit 테이블 정리 X)
    await supabase.from('moderation_blocks').delete().eq('sender_id', userId);
    await supabase.from('freeze_events').delete().eq('frozen_user_id', userId);
    await cleanupUser(userId);
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
});
