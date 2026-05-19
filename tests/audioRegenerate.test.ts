// audio-expiry sprint — regen 라우트 권한 / 상태 가드 회귀 검증.
//
// POST /api/matches/:matchId/messages/:messageId/audio 의 5가지 응답 분기 중
// 외부 의존성(ElevenLabs/Gemini) 없이 검증 가능한 4가지를 다룬다:
//   * 403 — 매치 비참여자
//   * 404 — 존재하지 않는 메시지
//   * 409 — audio_purged_at IS NULL 인 메시지 (재합성 불가 상태)
//   * 410 — 송신자 voice clone 미보유 (sender.elevenlabs_voice_id NULL)
//
// 200 happy-path 는 ElevenLabs/Gemini 라이브 호출이 필요해 본 sprint 범위 밖.
// 200 검증은 staging 수동 QA 또는 후속 모킹 보강 카드로 분리.
//
// voiceIntroModerationIntegration / messageModeration 의 silent-skip 패턴 적용 —
// mig 025 미적용 환경에서 audio_purged_at 컬럼 부재 시 column-dependent assertion
// 만 스킵 (라우트 자체는 SELECT 시 에러로 떨어져 500 으로 노출).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL1 = 'apitest_audioregen1@testmail.com';
const EMAIL2 = 'apitest_audioregen2@testmail.com';
const EMAIL3 = 'apitest_audioregen3@testmail.com';

let token1: string;
let userId1: string;
let token2: string;
let userId2: string;
let token3: string;
let userId3: string;
let matchId: string;

async function audioPurgedAtColumnMissing(): Promise<boolean> {
  const probe = await supabase.from('messages').select('audio_purged_at').limit(1);
  if (!probe.error) return false;
  return (
    /column.*audio_purged_at.*does not exist/i.test(probe.error.message) ||
    probe.error.code === '42703'
  );
}

describe('POST /api/matches/:matchId/messages/:messageId/audio — regen guards', () => {
  beforeAll(async () => {
    const a1 = await getAuthToken(EMAIL1);
    const a2 = await getAuthToken(EMAIL2);
    const a3 = await getAuthToken(EMAIL3);
    token1 = a1.token;
    userId1 = a1.userId;
    token2 = a2.token;
    userId2 = a2.userId;
    token3 = a3.token;
    userId3 = a3.userId;

    await cleanupUser(userId1);
    await cleanupUser(userId2);
    await cleanupUser(userId3);

    await createTestProfile(token1, {
      display_name: 'Regen User 1',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(token2, {
      display_name: 'Regen User 2',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });
    await createTestProfile(token3, {
      display_name: 'Regen User 3 (outsider)',
      language: 'en',
      nationality: 'US',
    });

    // 1 ↔ 2 매치 형성
    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token1}`)
      .send({ swiped_id: userId2, direction: 'like' });
    const swipeRes = await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token2}`)
      .send({ swiped_id: userId1, direction: 'like' });
    matchId = swipeRes.body.match?.id;
    expect(matchId).toBeDefined();
  });

  afterAll(async () => {
    await cleanupUser(userId1);
    await cleanupUser(userId2);
    await cleanupUser(userId3);
  });

  it('매치 비참여자 → 403', async () => {
    // 임의 UUID — 메시지 조회 단계 도달 전 매치 검증에서 차단
    const fakeMessageId = '00000000-0000-0000-0000-000000000001';
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${fakeMessageId}/audio`)
      .set('Authorization', `Bearer ${token3}`);
    expect(res.status).toBe(403);
  });

  it('존재하지 않는 messageId → 404', async () => {
    const fakeMessageId = '00000000-0000-0000-0000-000000000002';
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${fakeMessageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    expect(res.status).toBe(404);
  });

  it('audio_purged_at IS NULL 인 정상 메시지 → 409', async () => {
    // 일반 텍스트 메시지 전송 (voice clone 없는 발신자 → 동기 INSERT, audio_url=null,
    // audio_status='pending'). 본 sprint 의 정의상 regen 대상이 아니다.
    const sendRes = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: 'plain text without voice clone' });
    expect([201, 202]).toContain(sendRes.status);
    const messageId = sendRes.body.id as string;
    expect(messageId).toBeDefined();

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    // 정상 메시지는 audio_purged_at NULL → 409 (재합성 불가 상태)
    expect(res.status).toBe(409);
  });

  it('audio_purged_at SET 이지만 sender voice clone 없음 → 410', async () => {
    // mig 025 미적용 환경에선 audio_purged_at 컬럼이 없어 UPDATE 자체가 PGRST 에러로
    // 떨어진다 — 해당 환경에서는 본 케이스 skip (다른 케이스가 라우트 자체는 검증).
    if (await audioPurgedAtColumnMissing()) {
      console.warn('[audioRegenerate] mig 025 not applied — skipping 410 case');
      return;
    }

    // 메시지 생성 (token1 발신, voice clone 없음) 후 audio_purged_at 직접 set.
    const sendRes = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: 'message for 410 case' });
    expect([201, 202]).toContain(sendRes.status);
    const messageId = sendRes.body.id as string;

    // audio_status='ready' + audio_purged_at SET 으로 인위 조작 (sweep 이 폐기한 상태
    // 시뮬레이션). 본인 발신 메시지 visibility 정합성 확인 위해 listened_at 도 set.
    const { error: updErr } = await supabase
      .from('messages')
      .update({
        audio_status: 'ready',
        audio_url: null,
        audio_purged_at: new Date().toISOString(),
        listened_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('id', messageId);
    expect(updErr).toBeNull();

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    // sender (token1) 는 voice clone 없음 → elevenlabs_voice_id NULL → 410
    expect(res.status).toBe(410);
  });
});
