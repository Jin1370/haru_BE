// audio-expiry sprint — POST /api/matches/:matchId/messages/:messageId/audio.
//
// gate 검증 단위 (403/404/409/410) + 200 happy-path (translated/original 두 케이스).
// 200 케이스는 ElevenLabs 합성 + Storage 업로드를 모듈 경계 mock 으로 우회.
// supabase 는 라이브 그대로 — 실제 DB UPDATE 가 일어났는지 SELECT 로 검증.
//
// mig 025 (audio_purged_at / audio_refreshed_at 컬럼) 미적용 환경은 silent skip.
//
// mock 충돌 방지 노트:
//   * tests/setup.ts 는 NODE_ENV=test 만 set 하고 전역 mock 없음 — vi.mock 안전.
//   * 본 파일의 gate 4 건은 synthesizeSpeech/uploadFile 경로에 진입하지 않음
//     (403/404/409/410 이 그 전에 응답 종료). vi.mock 이 파일 단위로 적용돼도
//     gate 회귀 영향 없음.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';
import { randomUUID } from 'crypto';

// 본 파일 한정 — ElevenLabs / Storage 모듈 경계 mock.
// 다른 export (createVoiceClone 등) 는 actual 유지해 라우트 외 경로 회귀 차단.
vi.mock('../src/services/elevenlabs', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elevenlabs')>(
    '../src/services/elevenlabs',
  );
  return {
    ...actual,
    synthesizeSpeech: vi.fn().mockResolvedValue(Buffer.from('fake-audio-bytes')),
  };
});
vi.mock('../src/services/storage', async () => {
  const actual = await vi.importActual<typeof import('../src/services/storage')>(
    '../src/services/storage',
  );
  return {
    ...actual,
    uploadFile: vi
      .fn()
      .mockImplementation(
        async (_bucket: string, path: string) =>
          `https://fake.test/storage/v1/object/public/voice-messages/${path}`,
      ),
  };
});

import { synthesizeSpeech } from '../src/services/elevenlabs';
import { uploadFile } from '../src/services/storage';

const EMAIL1 = 'apitest_audioregen1@testmail.com';
const EMAIL2 = 'apitest_audioregen2@testmail.com';
const EMAIL_OTHER = 'apitest_audioregen_other@testmail.com';

let token1: string;
let userId1: string;
let token2: string;
let userId2: string;
let tokenOther: string;
let userIdOther: string;
let matchId: string;
let skipReason: string | null = null;

async function audioExpiryColumnsMissing(): Promise<boolean> {
  const probe = await supabase
    .from('messages')
    .select('audio_purged_at, audio_refreshed_at')
    .limit(1);
  if (!probe.error) return false;
  return (
    /column.*audio_(purged|refreshed)_at.*does not exist/i.test(probe.error.message) ||
    probe.error.code === '42703'
  );
}

describe('POST /api/matches/:matchId/messages/:messageId/audio — gate', () => {
  beforeAll(async () => {
    if (await audioExpiryColumnsMissing()) {
      skipReason =
        '[audio-expiry] mig 025 not applied — skipping gate tests (audio_purged_at / audio_refreshed_at columns missing)';
      // eslint-disable-next-line no-console
      console.warn(skipReason);
      return;
    }

    const auth1 = await getAuthToken(EMAIL1);
    const auth2 = await getAuthToken(EMAIL2);
    const authOther = await getAuthToken(EMAIL_OTHER);
    token1 = auth1.token;
    userId1 = auth1.userId;
    token2 = auth2.token;
    userId2 = auth2.userId;
    tokenOther = authOther.token;
    userIdOther = authOther.userId;

    await cleanupUser(userId1);
    await cleanupUser(userId2);
    await cleanupUser(userIdOther);

    // sender (user1) 에는 elevenlabs_voice_id 강제 set — 정상 케이스 / 410 분기 구분용.
    await createTestProfile(token1, {
      display_name: 'AudioRegen Sender',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(token2, {
      display_name: 'AudioRegen Recipient',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });
    await createTestProfile(tokenOther, {
      display_name: 'AudioRegen Other',
      language: 'en',
      nationality: 'US',
    });

    await supabase
      .from('profiles')
      .update({ elevenlabs_voice_id: 'fake_voice_id_for_test' })
      .eq('id', userId1);

    // mutual like → match
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
    if (skipReason) return;
    await cleanupUser(userId1);
    await cleanupUser(userId2);
    await cleanupUser(userIdOther);
  });

  it('비참여자 호출 → 403', async () => {
    if (skipReason) return;
    // 정상 메시지 1건 INSERT (id 만 필요)
    const messageId = randomUUID();
    await supabase.from('messages').insert({
      id: messageId,
      match_id: matchId,
      sender_id: userId1,
      original_text: 'hi',
      original_language: 'ko',
      translated_language: 'ja',
      audio_status: 'ready',
      audio_url: 'https://example.test/voice-messages/x.mp3',
    });

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
      .set('Authorization', `Bearer ${tokenOther}`);
    expect(res.status).toBe(403);

    await supabase.from('messages').delete().eq('id', messageId);
  });

  it('메시지 없음 → 404', async () => {
    if (skipReason) return;
    const fakeMessageId = randomUUID();
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${fakeMessageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    expect(res.status).toBe(404);
  });

  it('정상 (purge 안 된) 메시지 → 409', async () => {
    if (skipReason) return;
    const messageId = randomUUID();
    await supabase.from('messages').insert({
      id: messageId,
      match_id: matchId,
      sender_id: userId1,
      original_text: 'hi',
      original_language: 'ko',
      translated_text: 'こんにちは',
      translated_language: 'ja',
      audio_status: 'ready',
      audio_url: 'https://example.test/voice-messages/x.mp3',
      // audio_purged_at: null (default)
    });

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    expect(res.status).toBe(409);

    await supabase.from('messages').delete().eq('id', messageId);
  });

  it('sender voice clone 없음 (NULL) → 410', async () => {
    if (skipReason) return;
    // 일시적으로 sender 의 voice_id 를 NULL 로 → 410 분기 트리거 → 복원
    await supabase
      .from('profiles')
      .update({ elevenlabs_voice_id: null })
      .eq('id', userId1);

    const messageId = randomUUID();
    await supabase.from('messages').insert({
      id: messageId,
      match_id: matchId,
      sender_id: userId1,
      original_text: 'hi',
      original_language: 'ko',
      translated_text: 'こんにちは',
      translated_language: 'ja',
      audio_status: 'ready',
      audio_url: null,
      audio_purged_at: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
      .set('Authorization', `Bearer ${token1}`);
    expect(res.status).toBe(410);

    await supabase.from('messages').delete().eq('id', messageId);
    await supabase
      .from('profiles')
      .update({ elevenlabs_voice_id: 'fake_voice_id_for_test' })
      .eq('id', userId1);
  });

  // ── 200 happy-path ───────────────────────────────────────────────────────
  //
  // ElevenLabs 합성 + Storage 업로드를 mock 으로 우회한 정상 재합성 경로.
  // 검증 사항 (CLAUDE.md audio-expiry 항목 + 라우트 contract):
  //   1) 응답 200 + body 가 갱신된 Message
  //   2) audio_url 이 versioned path 패턴 (`{messageId}_v{ts}.mp3`) 로 갱신
  //   3) audio_purged_at NULL 리셋
  //   4) audio_refreshed_at 새 timestamp set (호출 직후 ± 5초)
  //   5) synthesizeSpeech mock 이 (textToSynthesize, voiceId, emotion, gender, targetLang) 로 호출
  //   6) uploadFile mock 이 ('voice-messages', versioned path, Buffer, 'audio/mpeg') 로 호출
  //   7) translated_text 있음 vs 없음 — fallback to original 동작 회귀
  describe('200 happy-path', () => {
    // sender (user1) 의 gender 는 helpers 의 default 'male' — route persona 룰에
    // 따라 senderGender = 'male' 로 synth 에 전달됨 (female 만 null 로 치환).
    const EXPECTED_GENDER = 'male' as const;

    function insertPurgedMessage(opts: {
      messageId: string;
      translated_text: string | null;
      translated_language: string | null;
      original_text: string;
      original_language: string;
    }) {
      return supabase.from('messages').insert({
        id: opts.messageId,
        match_id: matchId,
        sender_id: userId1,
        original_text: opts.original_text,
        original_language: opts.original_language,
        translated_text: opts.translated_text,
        translated_language: opts.translated_language,
        audio_status: 'ready',
        audio_url: null,
        audio_purged_at: new Date().toISOString(),
        audio_refreshed_at: null,
      });
    }

    it('translated_text 있음 → translated 텍스트로 합성 + versioned path 업로드 + DB 갱신', async () => {
      if (skipReason) return;
      vi.mocked(synthesizeSpeech).mockClear();
      vi.mocked(uploadFile).mockClear();

      const messageId = randomUUID();
      await insertPurgedMessage({
        messageId,
        translated_text: 'こんにちは',
        translated_language: 'ja',
        original_text: '안녕',
        original_language: 'ko',
      });

      const beforeMs = Date.now();
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
        .set('Authorization', `Bearer ${token1}`);
      const afterMs = Date.now();

      // 1) 응답 200 + body shape
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: messageId,
        match_id: matchId,
        sender_id: userId1,
        audio_status: 'ready',
        audio_purged_at: null,
      });

      // 2) audio_url versioned path 패턴
      const versionedPathRe = new RegExp(`/voice-messages/${messageId}_v\\d+\\.mp3$`);
      expect(res.body.audio_url).toMatch(versionedPathRe);

      // 3) audio_refreshed_at 새 timestamp (호출 윈도우 안)
      expect(res.body.audio_refreshed_at).toBeTruthy();
      const refreshedMs = new Date(res.body.audio_refreshed_at).getTime();
      expect(refreshedMs).toBeGreaterThanOrEqual(beforeMs - 1000);
      expect(refreshedMs).toBeLessThanOrEqual(afterMs + 1000);

      // 4) DB 실측 — UPDATE 가 실제 발생했는지 SELECT 로 확인
      const { data: dbRow } = await supabase
        .from('messages')
        .select('audio_url, audio_purged_at, audio_refreshed_at, audio_status')
        .eq('id', messageId)
        .single();
      expect(dbRow?.audio_status).toBe('ready');
      expect(dbRow?.audio_url).toMatch(versionedPathRe);
      expect(dbRow?.audio_purged_at).toBeNull();
      expect(dbRow?.audio_refreshed_at).toBeTruthy();

      // 5) synthesizeSpeech mock — translated_text 가 우선 인자
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
      const synthArgs = vi.mocked(synthesizeSpeech).mock.calls[0];
      expect(synthArgs[0]).toBe('こんにちは'); // ensureSpeakableForTTS 가 letter 텍스트는 그대로 통과
      expect(synthArgs[1]).toBe('fake_voice_id_for_test');
      expect(synthArgs[2]).toBeNull(); // emotion (insert 시 미설정 → DB default null)
      expect(synthArgs[3]).toBe(EXPECTED_GENDER);
      expect(synthArgs[4]).toBe('ja'); // translated_language 우선

      // 6) uploadFile mock — bucket / versioned path / content-type
      expect(uploadFile).toHaveBeenCalledTimes(1);
      const uploadArgs = vi.mocked(uploadFile).mock.calls[0];
      expect(uploadArgs[0]).toBe('voice-messages');
      expect(uploadArgs[1]).toMatch(new RegExp(`^${messageId}_v\\d+\\.mp3$`));
      expect(Buffer.isBuffer(uploadArgs[2])).toBe(true);
      expect(uploadArgs[3]).toBe('audio/mpeg');

      await supabase.from('messages').delete().eq('id', messageId);
    });

    it('translated_text 없음 → original_text 로 합성 (fallback)', async () => {
      if (skipReason) return;
      vi.mocked(synthesizeSpeech).mockClear();
      vi.mocked(uploadFile).mockClear();

      const messageId = randomUUID();
      await insertPurgedMessage({
        messageId,
        translated_text: null,
        translated_language: null,
        original_text: 'hello world',
        original_language: 'en',
      });

      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${messageId}/audio`)
        .set('Authorization', `Bearer ${token1}`);

      expect(res.status).toBe(200);
      expect(res.body.audio_purged_at).toBeNull();
      expect(res.body.audio_refreshed_at).toBeTruthy();

      // synth 인자 — fallback to original
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
      const synthArgs = vi.mocked(synthesizeSpeech).mock.calls[0];
      expect(synthArgs[0]).toBe('hello world');
      expect(synthArgs[1]).toBe('fake_voice_id_for_test');
      expect(synthArgs[2]).toBeNull();
      expect(synthArgs[3]).toBe(EXPECTED_GENDER);
      expect(synthArgs[4]).toBe('en'); // translated_language=null → original_language fallback

      // upload 도 정상 호출
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe('voice-messages');

      await supabase.from('messages').delete().eq('id', messageId);
    });
  });
});
