// evidence-hold-on-delete sprint (2026-05-27) — deleteAccount 4 카테고리 정합 통합 테스트.
//
// 라이브 Supabase 로 (a) 두 user (A=탈퇴 대상, B=상대방) + 매치 + 메시지 1건 +
// 모든 user-linked audit row 풀셋업 (b) DELETE /api/auth/account 호출
// (c) 카테고리별 row 상태 검증.
//
// 카테고리:
//   🔴 sync DELETE  — device_tokens / match_mutes / profile_photos / swipes (양방향) / user_preferences
//   🟡 anonymize    — profiles PII 비움 + auth.users email anonymized
//   🟠 1년 보존     — moderation_blocks / freeze_events / reports / blocks
//   🟢 영구 보존    — messages / matches
//
// 미적용 환경 silent skip: mig 016/020/021/022/028 + reports/blocks (mig 002)
// 모두 적용된 환경에서만 실행. 통합 테스트는 라이브 DB 의존이라 PR 단위 회귀
// 검증보다는 출시 게이트 회귀 검증 성격이 강하다.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL_A = 'apitest_delete_classify_a@testmail.com';
const EMAIL_B = 'apitest_delete_classify_b@testmail.com';

let userIdA: string;
let userIdB: string;
let tokenA: string;
let matchId: string;
let skipReason: string | null = null;

async function probeTable(table: string, column: string = 'id'): Promise<boolean> {
  const probe = await supabase.from(table).select(column).limit(1);
  if (!probe.error) return false;
  return (
    probe.error.code === 'PGRST205' ||
    /not find the table/i.test(probe.error.message) ||
    /does not exist/i.test(probe.error.message)
  );
}

async function migrationsMissing(): Promise<string | null> {
  // 필수 마이그 probe — 하나라도 부재면 skip.
  //   * moderation_blocks / freeze_events (mig 020/021)
  //   * match_mutes (mig 022)
  //   * profile_photos (mig 028)
  //   * device_tokens (mig 016)
  //   * user_preferences (mig 002 + push-notifications 컬럼 확장)
  if (await probeTable('moderation_blocks')) return 'mig 020 (moderation_blocks) not applied';
  if (await probeTable('freeze_events')) return 'mig 021 (freeze_events) not applied';
  if (await probeTable('match_mutes', 'match_id')) return 'mig 022 (match_mutes) not applied';
  if (await probeTable('profile_photos')) return 'mig 028 (profile_photos) not applied';
  if (await probeTable('device_tokens')) return 'mig 016 (device_tokens) not applied';
  if (await probeTable('user_preferences', 'user_id')) return 'mig 002 (user_preferences) not applied';
  return null;
}

describe('DELETE /api/auth/account — evidence-hold-on-delete 4 카테고리 정합', () => {
  beforeAll(async () => {
    const missing = await migrationsMissing();
    if (missing) {
      skipReason = `[deleteAccountClassification] ${missing} — skipping`;
      // eslint-disable-next-line no-console
      console.warn(skipReason);
      return;
    }

    const authA = await getAuthToken(EMAIL_A);
    userIdA = authA.userId;
    tokenA = authA.token;
    await cleanupUser(userIdA);
    await createTestProfile(authA.token, {
      display_name: 'Delete Target',
      language: 'ko',
      nationality: 'KR',
    });

    const authB = await getAuthToken(EMAIL_B);
    userIdB = authB.userId;
    await cleanupUser(userIdB);
    await createTestProfile(authB.token, {
      display_name: 'Partner',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });

    // 사전 정리 — 이전 테스트 잔존 row.
    await supabase.from('moderation_blocks').delete().eq('sender_id', userIdA);
    await supabase.from('freeze_events').delete().eq('frozen_user_id', userIdA);
    await supabase.from('device_tokens').delete().eq('user_id', userIdA);
    await supabase.from('profile_photos').delete().eq('user_id', userIdA);

    // ---- 매치 셋업 (user1_id < user2_id CHECK) ----
    const [u1, u2] = userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
    const matchInsert = await supabase
      .from('matches')
      .insert({ user1_id: u1, user2_id: u2 })
      .select('id')
      .single();
    if (matchInsert.error) {
      throw new Error(`match insert failed: ${matchInsert.error.message}`);
    }
    matchId = matchInsert.data!.id as string;

    // ---- 메시지 1건 (sender=A) ----
    const msgInsert = await supabase
      .from('messages')
      .insert({
        match_id: matchId,
        sender_id: userIdA,
        original_text: 'classification test',
        original_language: 'ko',
        audio_status: 'pending',
      });
    if (msgInsert.error) {
      throw new Error(`message insert failed: ${msgInsert.error.message}`);
    }

    // ---- 🔴 sync DELETE 카테고리 셋업 ----
    // device_tokens
    await supabase
      .from('device_tokens')
      .insert({
        user_id: userIdA,
        expo_push_token: `ExponentPushToken[evidence-hold-test-${Date.now()}]`,
        platform: 'ios',
      });

    // match_mutes (user_id=A on the match)
    await supabase
      .from('match_mutes')
      .insert({ match_id: matchId, user_id: userIdA });

    // profile_photos (user_id=A, position=0)
    await supabase
      .from('profile_photos')
      .insert({
        user_id: userIdA,
        position: 0,
        status: 'pending',
      });

    // swipes 양방향 (A→B, B→A)
    await supabase
      .from('swipes')
      .insert({ swiper_id: userIdA, swiped_id: userIdB, direction: 'like' });
    await supabase
      .from('swipes')
      .insert({ swiper_id: userIdB, swiped_id: userIdA, direction: 'like' });

    // user_preferences (createTestProfile 가 row 를 만들지 않으므로 명시 INSERT)
    await supabase
      .from('user_preferences')
      .upsert({ user_id: userIdA, min_age: 18, max_age: 99 });

    // ---- 🟠 1년 보존 카테고리 셋업 ----
    // moderation_blocks (sender=A)
    await supabase
      .from('moderation_blocks')
      .insert({
        sender_id: userIdA,
        category: 'sexual',
        language: 'ko',
      });

    // freeze_events (frozen_user=A)
    await supabase
      .from('freeze_events')
      .insert({
        frozen_user_id: userIdA,
        report_count_at_trigger: 3,
        reporter_ids: [userIdB],
      });

    // reports 양방향 (A→B, B→A) — 두 row 가 다른 (reporter,reported) 쌍이라 UNIQUE OK
    await supabase
      .from('reports')
      .insert({ reporter_id: userIdA, reported_id: userIdB, reason: 'spam' });
    await supabase
      .from('reports')
      .insert({ reporter_id: userIdB, reported_id: userIdA, reason: 'spam' });

    // blocks 양방향 (A→B, B→A)
    await supabase
      .from('blocks')
      .insert({ blocker_id: userIdA, blocked_id: userIdB });
    await supabase
      .from('blocks')
      .insert({ blocker_id: userIdB, blocked_id: userIdA });

    // ---- DELETE 호출 (단일 위치, 모든 it 가 같은 post-delete 상태 검증) ----
    const deleteRes = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(deleteRes.status).toBe(204);
  });

  afterAll(async () => {
    if (skipReason) return;
    // 영구 보존 카테고리 (matches/messages) 는 cleanupUser 가 처리.
    // 1년 보존 카테고리 잔존 row 정리.
    await supabase.from('moderation_blocks').delete().eq('sender_id', userIdA);
    await supabase.from('freeze_events').delete().eq('frozen_user_id', userIdA);
    await supabase.from('reports').delete().eq('reporter_id', userIdA);
    await supabase.from('reports').delete().eq('reported_id', userIdA);
    await supabase.from('reports').delete().eq('reporter_id', userIdB);
    await supabase.from('reports').delete().eq('reported_id', userIdB);
    await supabase.from('blocks').delete().eq('blocker_id', userIdA);
    await supabase.from('blocks').delete().eq('blocked_id', userIdA);
    await supabase.from('blocks').delete().eq('blocker_id', userIdB);
    await supabase.from('blocks').delete().eq('blocked_id', userIdB);
    await supabase.from('device_tokens').delete().eq('user_id', userIdA);
    await supabase.from('device_tokens').delete().eq('user_id', userIdB);
    await supabase.from('profile_photos').delete().eq('user_id', userIdA);
    await supabase.from('profile_photos').delete().eq('user_id', userIdB);
    await supabase.from('match_mutes').delete().eq('user_id', userIdA);
    await supabase.from('match_mutes').delete().eq('user_id', userIdB);
    await cleanupUser(userIdA);
    await cleanupUser(userIdB);
  });

  it('🔴 sync DELETE — device_tokens / match_mutes / profile_photos / swipes (양방향) / user_preferences row 0건', async () => {
    if (skipReason) return;

    const { count: deviceCount } = await supabase
      .from('device_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userIdA);
    expect(deviceCount ?? 0).toBe(0);

    const { count: muteCount } = await supabase
      .from('match_mutes')
      .select('match_id', { count: 'exact', head: true })
      .eq('user_id', userIdA);
    expect(muteCount ?? 0).toBe(0);

    const { count: photoCount } = await supabase
      .from('profile_photos')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userIdA);
    expect(photoCount ?? 0).toBe(0);

    const { count: swipeOutCount } = await supabase
      .from('swipes')
      .select('id', { count: 'exact', head: true })
      .eq('swiper_id', userIdA);
    expect(swipeOutCount ?? 0).toBe(0);

    const { count: swipeInCount } = await supabase
      .from('swipes')
      .select('id', { count: 'exact', head: true })
      .eq('swiped_id', userIdA);
    expect(swipeInCount ?? 0).toBe(0);

    const { count: prefsCount } = await supabase
      .from('user_preferences')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', userIdA);
    expect(prefsCount ?? 0).toBe(0);
  });

  it('🟡 anonymize — profiles PII 비움 + auth.users email anonymized', async () => {
    if (skipReason) return;

    const { data: profile } = await supabase
      .from('profiles')
      .select(
        'display_name, photos, interests, voice_intro, elevenlabs_voice_id, is_active, deleted_at',
      )
      .eq('id', userIdA)
      .maybeSingle();
    expect(profile).toBeTruthy();
    expect(profile?.display_name).toBe('');
    expect(profile?.photos).toEqual([]);
    expect(profile?.interests).toEqual([]);
    expect(profile?.voice_intro).toBeNull();
    expect(profile?.elevenlabs_voice_id).toBeNull();
    expect(profile?.is_active).toBe(false);
    expect(profile?.deleted_at).toBeTruthy();

    const { data: authUser } = await supabase.auth.admin.getUserById(userIdA);
    expect(authUser.user?.email).toMatch(/^deleted-/);
    expect(authUser.user?.email).toMatch(/@deleted\.local$/);
    expect(authUser.user?.user_metadata?.deleted).toBe(true);
  });

  it('🟠 1년 보존 — moderation_blocks / freeze_events / reports / blocks row 잔존', async () => {
    if (skipReason) return;

    const { count: modCount } = await supabase
      .from('moderation_blocks')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userIdA);
    expect(modCount ?? 0).toBeGreaterThanOrEqual(1);

    const { count: freezeCount } = await supabase
      .from('freeze_events')
      .select('id', { count: 'exact', head: true })
      .eq('frozen_user_id', userIdA);
    expect(freezeCount ?? 0).toBeGreaterThanOrEqual(1);

    // reports 양방향 — A 가 reporter 인 row 와 A 가 reported 인 row 모두 잔존
    const { count: reportsReporter } = await supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_id', userIdA);
    expect(reportsReporter ?? 0).toBeGreaterThanOrEqual(1);
    const { count: reportsReported } = await supabase
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_id', userIdA);
    expect(reportsReported ?? 0).toBeGreaterThanOrEqual(1);

    // blocks 양방향 — A 가 blocker 인 row 와 A 가 blocked 인 row 모두 잔존
    const { count: blocksBlocker } = await supabase
      .from('blocks')
      .select('id', { count: 'exact', head: true })
      .eq('blocker_id', userIdA);
    expect(blocksBlocker ?? 0).toBeGreaterThanOrEqual(1);
    const { count: blocksBlocked } = await supabase
      .from('blocks')
      .select('id', { count: 'exact', head: true })
      .eq('blocked_id', userIdA);
    expect(blocksBlocked ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('🟢 영구 보존 — messages / matches row 잔존 (anonymize 만, CASCADE 미발화)', async () => {
    if (skipReason) return;

    const { count: matchCount } = await supabase
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('id', matchId);
    expect(matchCount ?? 0).toBe(1);

    const { count: msgCount } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userIdA);
    expect(msgCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('재가입 시나리오 — 같은 email 로 재가입 가능, user_preferences 미상속', async () => {
    if (skipReason) return;

    // anonEmail='deleted-{userIdA}@deleted.local' 로 치환됐으므로 원래 email 은 freed.
    // signup 라우트가 부재할 수 있어 getAuthToken (admin createUser 경로) 활용.
    const reAuth = await getAuthToken(EMAIL_A);
    expect(reAuth.userId).toBeDefined();
    // 재가입 user.id 가 옛 userIdA 와 다른지 (auth.users 가 새로 발급되는지) 확인.
    // 단, Supabase auth.admin.createUser 가 옛 email 재사용 시 신규 ID 발급 정합.
    expect(reAuth.userId).not.toBe(userIdA);

    // user_preferences 미상속 — 신규 가입은 row 없는 상태에서 시작.
    const { count: newPrefsCount } = await supabase
      .from('user_preferences')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', reAuth.userId);
    expect(newPrefsCount ?? 0).toBe(0);

    // cleanup — 재가입 user 정리 (afterAll 의 cleanupUser(userIdA) 는 옛 anonymized
    // profile row 만 가리키므로 신규 userId 도 명시 정리).
    await cleanupUser(reAuth.userId);
  });
});
