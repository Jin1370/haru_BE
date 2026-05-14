import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// voice-first-message-gate sprint: beforeAll 은 inner describe 에서도 사용.
import request from 'supertest';
import { app } from '../src/index';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';

const EMAIL1 = 'apitest_msg1@testmail.com';
const EMAIL2 = 'apitest_msg2@testmail.com';
let token1: string;
let userId1: string;
let token2: string;
let userId2: string;
let matchId: string;

describe('Message Routes', () => {
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
      display_name: 'Msg User 1',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(token2, {
      display_name: 'Msg User 2',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });

    // mutual like to create match
    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token1}`)
      .send({ swiped_id: userId2, direction: 'like' });

    const swipeRes = await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token2}`)
      .send({ swiped_id: userId1, direction: 'like' });

    matchId = swipeRes.body.match?.id;
  });

  afterAll(async () => {
    await cleanupUser(userId1);
    await cleanupUser(userId2);
  });

  describe('POST /api/matches/:matchId/messages', () => {
    it('text 없으면 400', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('매치 비참여자면 403', async () => {
      const other = await getAuthToken('apitest_msg_other@testmail.com');
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ text: 'Hello' });
      expect(res.status).toBe(403);
    });

    it('메시지 전송 성공', async () => {
      expect(matchId).toBeDefined();

      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ text: 'Hello!' });

      expect(res.status).toBe(201);
      expect(res.body.original_text).toBe('Hello!');
      expect(res.body.sender_id).toBe(userId1);
      expect(res.body.emotion).toBeNull();
    });

    it('emotion 포함 전송 성공', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ text: '왜 이제야 연락해?', emotion: 'angry' });

      expect(res.status).toBe(201);
      expect(res.body.emotion).toBe('angry');
    });

    it('emotion=neutral은 null로 저장', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ text: 'hi', emotion: 'neutral' });

      expect(res.status).toBe(201);
      expect(res.body.emotion).toBeNull();
    });

    it('잘못된 emotion 값이면 400', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ text: 'hi', emotion: 'sleepy' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/matches/:matchId/messages', () => {
    it('메시지 목록 조회 성공', async () => {
      const res = await request(app)
        .get(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('매치 비참여자면 403', async () => {
      const other = await getAuthToken('apitest_msg_other@testmail.com');
      const res = await request(app)
        .get(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${other.token}`);
      expect(res.status).toBe(403);
    });

    // voice-first-message-gate sprint follow-up
    it('voice-clone 없는 발신자의 pending 메시지는 수신자 GET 에서 제외', async () => {
      // beforeAll 에서 user1 (voice-clone 없음) 이 user2 에게 보낸 메시지들은
      // audio_status='pending' 으로 영구 저장됨. 수신자 user2 의 GET 응답에는
      // 한 건도 포함되지 않아야 한다.
      const res = await request(app)
        .get(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token2}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const recipientVisible = res.body.filter(
        (m: { sender_id: string; audio_status: string }) =>
          m.sender_id !== userId2 && m.audio_status !== 'ready',
      );
      expect(recipientVisible).toHaveLength(0);
    });

    it('본인 발신 pending 메시지는 본인 GET 에 포함', async () => {
      // 같은 메시지들이 송신자 user1 GET 에는 그대로 노출 — 재전송 등 대응 가능.
      const res = await request(app)
        .get(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(200);
      const senderPending = res.body.filter(
        (m: { sender_id: string; audio_status: string }) =>
          m.sender_id === userId1 && m.audio_status !== 'ready',
      );
      expect(senderPending.length).toBeGreaterThanOrEqual(1);
    });
  });

  // read-at-removal-list-mask sprint: PATCH /api/matches/:matchId/messages/read
  // 라우트가 제거되어 본 describe 블록도 삭제. "읽음" 의 의미는 listened_at 으로
  // 일원화되었고, 메시지별 마킹은 아래 listened POST 가 담당.

  // voice-first-message-gate sprint
  describe('POST /api/matches/:matchId/messages/:messageId/listened', () => {
    let targetMessageId: string;

    beforeAll(async () => {
      // user1 → user2 로 메시지 1건 송신. user2 가 수신자 입장으로 listened 호출.
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ text: 'listened-test message' });
      // voice-clone 없는 발신자는 201 동기 INSERT 경로.
      expect([201, 202]).toContain(res.status);
      targetMessageId = res.body.id;
      expect(targetMessageId).toBeDefined();
    });

    it('수신자 호출 성공 → listened_at 가 ISO timestamp 로 set', async () => {
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${targetMessageId}/listened`)
        .set('Authorization', `Bearer ${token2}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(targetMessageId);
      expect(res.body.listened_at).toBeTruthy();
      // ISO-8601 timestamp 확인
      expect(new Date(res.body.listened_at).toString()).not.toBe('Invalid Date');
    });

    it('idempotent — 같은 메시지로 두 번째 호출 시 listened_at 변경 없음', async () => {
      const first = await request(app)
        .post(`/api/matches/${matchId}/messages/${targetMessageId}/listened`)
        .set('Authorization', `Bearer ${token2}`);
      const firstAt = first.body.listened_at;
      expect(firstAt).toBeTruthy();

      const second = await request(app)
        .post(`/api/matches/${matchId}/messages/${targetMessageId}/listened`)
        .set('Authorization', `Bearer ${token2}`);

      expect(second.status).toBe(200);
      expect(second.body.listened_at).toBe(firstAt);
    });

    it('송신자 본인이 자기 메시지로 호출 시 403', async () => {
      // user1 이 자기가 보낸 메시지에 listened 호출 — 403 (게이팅 대상 아님).
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${targetMessageId}/listened`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(403);
    });

    it('매치 비참여자가 호출 시 403', async () => {
      const other = await getAuthToken('apitest_msg_other@testmail.com');
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${targetMessageId}/listened`)
        .set('Authorization', `Bearer ${other.token}`);
      expect(res.status).toBe(403);
    });

    it('존재하지 않는 messageId 시 404', async () => {
      const fakeMessageId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .post(`/api/matches/${matchId}/messages/${fakeMessageId}/listened`)
        .set('Authorization', `Bearer ${token2}`);
      expect(res.status).toBe(404);
    });
  });
});
