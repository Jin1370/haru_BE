import { describe, it, expect, vi, afterEach } from 'vitest';
import { postToExpo, buildGroupKey } from '../src/services/pushNotifications';
import { buildPushBody } from '../src/constants/pushMessages';

const res = (status: number) => new Response('{}', { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('postToExpo', () => {
  it('2xx 면 재시도 안 함', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(200));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4xx 는 우리 페이로드 문제라 재시도 안 함', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(400));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 는 1회만 재시도하고 두 번째 결과를 반환', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx 가 두 번 나면 포기 (무한 재시도 없음)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(res(503));
    const r = await postToExpo([{ to: 'x' }]);
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('네트워크 에러는 중복 푸시 위험이라 재시도 안 하고 throw', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNRESET'));
    await expect(postToExpo([{ to: 'x' }])).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('buildGroupKey', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const other = '99999999-8888-7777-6666-555555555555';

  it('메시지는 채팅방(match_id)당 하나의 키 — 같은 방 알림은 트레이에서 병합', () => {
    const a = buildGroupKey(
      { type: 'message', match_id: uuid, sender_id: other, sender_name: 'A' },
      other,
    );
    const b = buildGroupKey(
      { type: 'message', match_id: uuid, sender_id: other, sender_name: 'A' },
      other,
    );
    expect(a).toBe(b);
  });

  it('다른 채팅방은 다른 키 — 서로 덮어쓰지 않는다', () => {
    const a = buildGroupKey(
      { type: 'message', match_id: uuid, sender_id: other, sender_name: 'A' },
      other,
    );
    const b = buildGroupKey(
      { type: 'message', match_id: other, sender_id: uuid, sender_name: 'B' },
      other,
    );
    expect(a).not.toBe(b);
  });

  it('메시지와 매치는 같은 match_id 라도 분리된다', () => {
    const msg = buildGroupKey(
      { type: 'message', match_id: uuid, sender_id: other, sender_name: 'A' },
      other,
    );
    const match = buildGroupKey(
      { type: 'match', match_id: uuid, matched_user_id: other, matched_name: 'A' },
      other,
    );
    expect(msg).not.toBe(match);
  });

  it('모든 타입의 키가 apns-collapse-id 상한 64 바이트 이내', () => {
    const keys = [
      buildGroupKey({ type: 'message', match_id: uuid, sender_id: other, sender_name: 'A' }, other),
      buildGroupKey({ type: 'match', match_id: uuid, matched_user_id: other, matched_name: 'A' }, other),
      buildGroupKey({ type: 'like', liker_id: other }, uuid),
      buildGroupKey({ type: 'voice_reminder' }, uuid),
    ];
    for (const k of keys) {
      expect(Buffer.byteLength(k, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('buildPushBody 개수 표시', () => {
  it('1건이면 개수를 붙이지 않는다', () => {
    expect(buildPushBody('message', 'ko', '콘', 1)).toBe('콘님의 새 음성 메시지');
  });

  it('count 미지정(집계 실패 폴백)이면 단수 문구', () => {
    expect(buildPushBody('message', 'ko', '콘')).toBe('콘님의 새 음성 메시지');
  });

  it('2건 이상이면 개수 문구 — ko/ja/en', () => {
    expect(buildPushBody('message', 'ko', '콘', 3)).toBe('콘님의 새 음성 메시지 3개');
    expect(buildPushBody('message', 'ja', 'コン', 3)).toBe('コンさんから新しいボイスメッセージ3件');
    expect(buildPushBody('message', 'en', 'Kon', 3)).toBe('3 new voice messages from Kon');
  });

  it('메시지 외 타입은 count 를 무시한다', () => {
    expect(buildPushBody('like', 'ko', '', 5)).toBe('새로운 좋아요가 도착했어요');
    expect(buildPushBody('match', 'ko', '콘', 5)).toBe('콘님과 매칭되었어요!');
  });
});
