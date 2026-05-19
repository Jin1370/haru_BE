// voice-intro-moderation-unification sprint — 라이브 DB 통합 회귀.
//
// PUT /api/profile/me 의 voice_intro 분기에 사전 모더레이션 게이트 + OpenAI 2차 layer
// 가 정확히 적용되는지 supertest + 라이브 Supabase 로 검증. messageModeration.test.ts
// 와 동일 패턴 — mig 020 / 024 미적용 환경엔 audit row 검증을 silent skip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const EMAIL = 'apitest_voiceintromod@testmail.com';
let token: string;
let userId: string;

describe('PUT /api/profile/me — voice intro moderation integration', () => {
  beforeAll(async () => {
    const auth = await getAuthToken(EMAIL);
    token = auth.token;
    userId = auth.userId;
    await cleanupUser(userId);
  });

  afterAll(async () => {
    try {
      await supabase.from('moderation_blocks').delete().eq('sender_id', userId);
    } catch {
      // mig 020/024 not applied — ignore
    }
    await cleanupUser(userId);
  });

  // mig 020 미적용 환경 가드.
  async function moderationBlocksTableMissing(): Promise<boolean> {
    const probe = await supabase.from('moderation_blocks').select('id').limit(1);
    if (!probe.error) return false;
    return (
      probe.error.code === 'PGRST205' ||
      /not find the table/i.test(probe.error.message) ||
      /does not exist/i.test(probe.error.message)
    );
  }

  // mig 024 (surface 컬럼) 미적용 환경 가드.
  async function surfaceColumnMissing(): Promise<boolean> {
    if (await moderationBlocksTableMissing()) return true;
    const probe = await supabase.from('moderation_blocks').select('surface').limit(1);
    if (!probe.error) return false;
    return (
      /column.*surface.*does not exist/i.test(probe.error.message) ||
      probe.error.code === '42703'
    );
  }

  it('정상 voice_intro → 200 통과 (회귀)', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '안녕하세요 잘 부탁드려요',
      });
    expect(res.status).toBe(200);
    expect(res.body.voice_intro).toBe('안녕하세요 잘 부탁드려요');
  });

  it('voice_intro 차단 단어 (사전 layer) → 422 + code: message_blocked', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '필로폰 같이 할래요?',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('message_blocked');
    expect(res.body).not.toHaveProperty('category');
    expect(res.body).not.toHaveProperty('language');
    expect(res.body).not.toHaveProperty('matched_token');
  });

  it('띄어쓰기 우회 차단 ("필 로 폰") → 422 (normalize 회귀)', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '필 로 폰 같이',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('message_blocked');
  });

  it('1인칭 자해 통과 — "죽고 싶어" 는 차단 ❌ (위기 funnel 보존)', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '요즘 너무 힘들어서 죽고 싶어',
      });
    expect(res.status).toBe(200);
  });

  it('voice_intro 미변경 (다른 필드만 변경) → 모더레이션 우회 → 200', async () => {
    // 사전 세팅
    await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '안녕하세요',
      });

    // display_name 만 변경 — voiceIntroChanged === false → 모더레이션 게이트 미실행.
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Updated Name',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '안녕하세요',
      });
    expect(res.status).toBe(200);
  });

  it('voice_intro=null (미입력) → 모더레이션 우회 → 200', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
      });
    expect(res.status).toBe(200);
  });

  it('preset 경로 (voice_intro_phrase_id) → 모더레이션 우회', async () => {
    const { BIO_PHRASE_CATALOG } = await import('../src/constants/bioPhrasesCatalog');
    if (!BIO_PHRASE_CATALOG || BIO_PHRASE_CATALOG.length === 0) {
      console.warn('[voiceIntroModerationIntegration] catalog empty — skipping preset case');
      return;
    }
    const first = BIO_PHRASE_CATALOG[0];
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: first.text.ko,
        voice_intro_phrase_id: first.id,
      });
    expect(res.status).toBe(200);
    // server-authoritative override 가 카탈로그 ko 텍스트로 강제.
    expect(res.body.voice_intro).toBe(first.text.ko);
  });

  it('차단 후 moderation_blocks.surface = voice_intro (mig 024 적용 환경만 검증)', async () => {
    if (await surfaceColumnMissing()) {
      console.warn('[voiceIntroModerationIntegration] mig 024 not applied — skipping surface verification');
      return;
    }

    const before = await supabase
      .from('moderation_blocks')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId);
    const beforeCount = before.count ?? 0;

    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '히로뽕 어디서 사?',
      });
    expect(res.status).toBe(422);

    // fire-and-forget — 응답 후 INSERT 가 완료될 시간 짧게 대기.
    await new Promise((r) => setTimeout(r, 500));

    const after = await supabase
      .from('moderation_blocks')
      .select('category, language, sender_id, surface')
      .eq('sender_id', userId)
      .order('blocked_at', { ascending: false })
      .limit(1);

    expect(after.error).toBeNull();
    const totalAfter = await supabase
      .from('moderation_blocks')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId);
    expect((totalAfter.count ?? 0) - beforeCount).toBeGreaterThanOrEqual(1);

    const latest = after.data?.[0];
    expect(latest).toBeDefined();
    expect(latest?.surface).toBe('voice_intro');
    expect(latest?.category).toBe('drug');
    expect(latest?.language).toBe('ko');
    expect(latest?.sender_id).toBe(userId);
  });

  it('422 응답 body 에 category/matched_token/surface 미노출 (학습 회피)', async () => {
    const res = await request(app)
      .put('/api/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        display_name: 'Voice Intro Mod Test',
        birth_date: '1995-06-15',
        gender: 'male',
        nationality: 'KR',
        language: 'ko',
        voice_intro: '히로뽕 줘',
      });
    expect(res.status).toBe(422);
    expect(res.body).not.toHaveProperty('category');
    expect(res.body).not.toHaveProperty('language');
    expect(res.body).not.toHaveProperty('matched_token');
    expect(res.body).not.toHaveProperty('matchedToken');
    expect(res.body).not.toHaveProperty('surface');
  });
});
