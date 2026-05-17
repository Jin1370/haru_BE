// message-moderation-v1 (PR1) — 사전 키워드 차단 회귀.
//
// 두 종류 테스트:
//   1) 순수 단위 — `isBlocked` / `normalize` 동작 보장.
//      카테고리 응답 정확, 1인칭 자해 통과, 정상 텍스트 통과, 우회 패턴 차단.
//   2) 통합 (supertest) — POST /api/matches/:matchId/messages 가 422 응답 +
//      `code: 'message_blocked'` + 응답 body 에 category 미노출 + moderation_blocks
//      audit row 1건 추가 (실제 Supabase 호출).
//
// 본 sprint 의 4 카테고리 (sexual / drug / minor / self_harm) × 3 언어 (ko/ja/en)
// 구조 회귀도 함께 검사.
//
// 자모 결합 / TWO_CONSONANT_SHORTCUTS 는 OpenAI Moderation 도입과 함께 제거 (B 안,
// 2026-05-18 사용자 결정). 자모 분리 / leet / 한자 / 이모지 우회는 OpenAI 가 담당.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, createTestProfile, cleanupUser } from './helpers';
import {
  isBlocked,
  normalize,
  MODERATION_DICTIONARY,
  type ModerationCategory,
  type ModerationLanguage,
} from '../src/constants/moderationDictionary';

// ─── 1) Unit: dictionary structure + normalize + isBlocked ─────────────────

describe('moderationDictionary — structure', () => {
  it('4 카테고리 × 3 언어 = 12 슬롯 모두 존재 (구조 회귀)', () => {
    const expected: Array<[ModerationCategory, ModerationLanguage]> = [];
    for (const c of ['sexual', 'drug', 'minor', 'self_harm'] as const) {
      for (const l of ['ko', 'ja', 'en'] as const) {
        expected.push([c, l]);
      }
    }
    const have = MODERATION_DICTIONARY.map((e) => [e.category, e.language] as const);
    for (const [c, l] of expected) {
      const match = have.find(([hc, hl]) => hc === c && hl === l);
      expect(match, `missing entry for ${c}/${l}`).toBeTruthy();
    }
    expect(MODERATION_DICTIONARY).toHaveLength(12);
  });

  it('각 entry 의 tokens 는 모두 normalize 된 상태 (저장 시점 normalize 룰)', () => {
    for (const entry of MODERATION_DICTIONARY) {
      for (const tok of entry.tokens) {
        expect(normalize(tok), `token "${tok}" 가 normalize idempotent 위반`).toBe(tok);
      }
    }
  });
});

describe('normalize — 사전 차단 layer 우회 패턴', () => {
  it('NFKC + lowercase + 구두점 제거', () => {
    expect(normalize('ＳＥＸ')).toBe('sex');
    expect(normalize('S.E.X')).toBe('sex');
    expect(normalize('S e x')).toBe('sex');
  });

  it('가타카나 → 히라가나 변환', () => {
    expect(normalize('シャブ')).toBe(normalize('しゃぶ'));
  });

  it('한글 자모 결합 미수행 — 자모 분리는 사전 매칭 안 됨 (OpenAI 담당)', () => {
    // 자모 결합 제거 (B 안, 2026-05-18). NFKC 가 호환 자모를 초성 자모로
    // 분해하지만 사전 토큰은 완성형 음절이라 매칭 X — 사전 layer 통과.
    // 자모 분리 우회 차단은 OpenAI Moderation layer 담당.
    expect(isBlocked('ㅁㅏㅇㅑㄱ 어디서').blocked).toBe(false);
    expect(isBlocked('ㅅㅂ 진짜').blocked).toBe(false);
  });

  it('단일 자모 연속 ("ㅋㅋㅋ", "ㄱㄱ") 정상 통과 — 슬랭 false positive 0', () => {
    expect(isBlocked('ㅋㅋㅋ').blocked).toBe(false);
    expect(isBlocked('ㄱㄱ').blocked).toBe(false);
    expect(isBlocked('ㅎㅎ').blocked).toBe(false);
  });
});

describe('isBlocked — 카테고리별 정상 차단', () => {
  it('ko sexual 토큰 차단', () => {
    const result = isBlocked('나는 보지가 좋아');
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('sexual');
    expect(result.language).toBe('ko');
  });

  it('ko drug 토큰 차단', () => {
    const result = isBlocked('필로폰 어디서 구함?');
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('drug');
  });

  it('ko minor 토큰 차단 (원조교제)', () => {
    const result = isBlocked('원조교제 가능?');
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('minor');
  });

  it('ko self_harm — 타인 대상 명령형 차단', () => {
    expect(isBlocked('죽어라 진짜').blocked).toBe(true);
    expect(isBlocked('너 자살해라').blocked).toBe(true);
    expect(isBlocked('죽여버려').blocked).toBe(true);
  });

  it('en sexual/drug/minor 차단', () => {
    expect(isBlocked('hey fuck off').blocked).toBe(true);
    expect(isBlocked('cocaine dealer').blocked).toBe(true);
    expect(isBlocked('underage stuff').blocked).toBe(true);
  });

  it('en self_harm — 타인 대상 명령형 차단', () => {
    expect(isBlocked('just kys').blocked).toBe(true);
    expect(isBlocked('kill yourself').blocked).toBe(true);
  });
});

describe('isBlocked — 사전 차단 layer 우회 패턴', () => {
  // 사전 차단은 명백 키워드 + 띄어쓰기 / 가타카나-히라가나 / 전각 / 대소문자만.
  // 자모 분리 / leet / 이모지 / 한자 변환 / 그루밍 / 스캠은 OpenAI Moderation layer 담당.
  it('띄어쓰기 우회 차단 ("필 로 폰" → "필로폰")', () => {
    const result = isBlocked('필 로 폰 어디서');
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('drug');
  });

  it('대소문자 + 구두점 우회 차단', () => {
    expect(isBlocked('F.U.C.K').blocked).toBe(true);
    expect(isBlocked('FUCK YOU').blocked).toBe(true);
  });

  it('자모 분리 ("ㅁㅏㅇㅑㄱ") 는 사전 layer 통과 — OpenAI layer 담당', () => {
    // 자모 결합 제거 (B 안). 본 layer 에선 통과. OpenAI Moderation 이 차단.
    expect(isBlocked('ㅁㅏㅇㅑㄱ 어디서').blocked).toBe(false);
  });
});

describe('isBlocked — 1인칭 자해 통과 (위기 funnel 보존)', () => {
  it('"죽고 싶어" 는 통과 (1인칭 위기 신호)', () => {
    expect(isBlocked('나 진짜 죽고 싶어').blocked).toBe(false);
  });

  it('"사라지고 싶다" / "힘들다" 는 통과', () => {
    expect(isBlocked('사라지고 싶다').blocked).toBe(false);
    expect(isBlocked('너무 힘들다').blocked).toBe(false);
  });

  it('en "i want to die" / "i wanna disappear" 는 통과', () => {
    expect(isBlocked('i want to die').blocked).toBe(false);
    expect(isBlocked('i wanna disappear').blocked).toBe(false);
    expect(isBlocked("i'm so tired of life").blocked).toBe(false);
  });
});

describe('isBlocked — 정상 텍스트 통과 (false positive 회귀)', () => {
  const SAFE_MESSAGES = [
    // 평범한 데이팅 대화
    '안녕하세요! 반가워요',
    '오늘 날씨 좋네요',
    'こんにちは。今度会いませんか',
    'Hi! What do you do for fun?',
    '주말에 뭐 하세요?',
    '제 취미는 등산이에요',
    'I love hiking and music',
    '학교 다녀요',
    '대학생이에요',
    '커피 한잔 할래요?',
    'ㅋㅋㅋ 그러게요',
    'ㅎㅎ 좋네요',
    'lol that was funny',
    '오늘 점심 뭐 먹었어요?',
    '음악 좋아하세요?',
  ];
  for (const msg of SAFE_MESSAGES) {
    it(`통과: "${msg}"`, () => {
      const r = isBlocked(msg);
      expect(r.blocked, `false positive 회귀: "${msg}" → ${r.category}/${r.matchedToken}`).toBe(false);
    });
  }
});

// ─── 2) Integration: POST /api/matches/:matchId/messages 회귀 ─────────────

const EMAIL1 = 'apitest_mod1@testmail.com';
const EMAIL2 = 'apitest_mod2@testmail.com';
let token1: string;
let userId1: string;
let userId2: string;
let matchId: string;

describe('POST /api/matches/:matchId/messages — moderation integration', () => {
  beforeAll(async () => {
    const auth1 = await getAuthToken(EMAIL1);
    const auth2 = await getAuthToken(EMAIL2);
    token1 = auth1.token;
    userId1 = auth1.userId;
    userId2 = auth2.userId;

    await cleanupUser(userId1);
    await cleanupUser(userId2);

    await createTestProfile(token1, {
      display_name: 'Mod User 1',
      language: 'ko',
      nationality: 'KR',
    });
    await createTestProfile(auth2.token, {
      display_name: 'Mod User 2',
      language: 'ja',
      nationality: 'JP',
      gender: 'female',
    });

    await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${token1}`)
      .send({ swiped_id: userId2, direction: 'like' });
    const swipeRes = await request(app)
      .post('/api/discover/swipe')
      .set('Authorization', `Bearer ${auth2.token}`)
      .send({ swiped_id: userId1, direction: 'like' });
    matchId = swipeRes.body.match?.id;
    expect(matchId).toBeDefined();
  });

  afterAll(async () => {
    // moderation_blocks 정리 — 본 테스트가 INSERT 한 audit row 삭제.
    // 테이블 미적용 환경 (mig 020 dashboard 적용 전) 도 무시.
    try {
      await supabase.from('moderation_blocks').delete().eq('sender_id', userId1);
    } catch {
      // table not yet applied — ignore
    }
    await cleanupUser(userId1);
    await cleanupUser(userId2);
  });

  it('정상 메시지 → 201 또는 202 통과 (회귀)', async () => {
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '안녕하세요! 반가워요' });
    expect([201, 202]).toContain(res.status);
    expect(res.body.original_text).toBe('안녕하세요! 반가워요');
  });

  it('차단 단어 메시지 → 422 + code: message_blocked', async () => {
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '필로폰 어디서 사?' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('message_blocked');
    expect(res.body.error).toBeTruthy();
  });

  it('422 응답 body 에 category 미노출 (학습 회피)', async () => {
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '필로폰 줘' });
    expect(res.status).toBe(422);
    expect(res.body).not.toHaveProperty('category');
    expect(res.body).not.toHaveProperty('language');
    expect(res.body).not.toHaveProperty('matched_token');
    expect(res.body).not.toHaveProperty('matchedToken');
  });

  it('띄어쓰기 우회 차단 ("필 로 폰") → 422', async () => {
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '필 로 폰 어디서' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('message_blocked');
  });

  // 자모 결합 제거 (B 안, 2026-05-18) — 자모 분리 우회는 OpenAI Moderation
  // layer 가 담당. 사전 차단 layer 의 integration 회귀에선 미검증.

  it('1인칭 자해 통과 — "죽고 싶어" 는 차단 ❌', async () => {
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '나 너무 힘들어서 죽고 싶어' });
    expect([201, 202]).toContain(res.status);
  });

  // mig 020 미적용 환경 가드. dashboard SQL editor 적용 전이면 본 helper 가 true.
  async function moderationBlocksTableMissing(): Promise<boolean> {
    const probe = await supabase.from('moderation_blocks').select('id').limit(1);
    if (!probe.error) return false;
    return (
      probe.error.code === 'PGRST205' ||
      /not find the table/i.test(probe.error.message) ||
      /does not exist/i.test(probe.error.message)
    );
  }

  it('차단 후 moderation_blocks 에 audit row INSERT (fire-and-forget)', async () => {
    // mig 020 적용 가드 — 테이블 없으면 silent skip (BE 는 fire-and-forget 이라
    // 응답은 정상 422). 사용자가 Dashboard 에서 020 적용 후 본 테스트 자동 통과.
    if (await moderationBlocksTableMissing()) {
      console.warn('[messageModeration.test] mig 020 not applied — skipping audit row verification');
      return;
    }

    // 한 번 더 차단 발생 → audit 누적
    const before = await supabase
      .from('moderation_blocks')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId1);
    const beforeCount = before.count ?? 0;

    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ text: '히로뽕 줘봐' });
    expect(res.status).toBe(422);

    // fire-and-forget — 응답 후 INSERT 가 완료될 시간 짧게 대기.
    await new Promise((r) => setTimeout(r, 500));

    const after = await supabase
      .from('moderation_blocks')
      .select('category, language, sender_id')
      .eq('sender_id', userId1)
      .order('blocked_at', { ascending: false })
      .limit(1);

    expect(after.error).toBeNull();
    const totalAfter = await supabase
      .from('moderation_blocks')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId1);
    expect((totalAfter.count ?? 0) - beforeCount).toBeGreaterThanOrEqual(1);

    const latest = after.data?.[0];
    expect(latest).toBeDefined();
    expect(latest?.category).toBe('drug');
    expect(latest?.language).toBe('ko');
    expect(latest?.sender_id).toBe(userId1);
  });

  it('matched_token / 메시지 원문은 DB 에 저장 ❌ (PR1 스키마 회귀)', async () => {
    if (await moderationBlocksTableMissing()) {
      console.warn('[messageModeration.test] mig 020 not applied — skipping schema verification');
      return;
    }

    // moderation_blocks 컬럼 4종만 존재해야 함: id / sender_id / category / language / blocked_at
    const { data } = await supabase
      .from('moderation_blocks')
      .select('*')
      .eq('sender_id', userId1)
      .limit(1)
      .single();
    if (data) {
      // 메시지 원문이 보존되는 컬럼이 없어야 함.
      expect(data).not.toHaveProperty('original_text');
      expect(data).not.toHaveProperty('text');
      expect(data).not.toHaveProperty('matched_token');
      expect(data).not.toHaveProperty('message_id');
    }
  });
});
