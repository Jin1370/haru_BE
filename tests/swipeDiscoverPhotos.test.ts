// photo-watercolor-pipeline sprint — 디스커버 응답에 profile_photos.converted_url 노출
// + status='ready' 아닌 후보 제외.
//
// mig 028 미적용 환경은 silent skip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const VIEWER_EMAIL = 'apitest_discphotos_viewer@testmail.com';
const READY_CANDIDATE_EMAIL = 'apitest_discphotos_ready@testmail.com';
const PROCESSING_CANDIDATE_EMAIL = 'apitest_discphotos_proc@testmail.com';

let viewerToken: string;
let viewerId: string;
let readyId: string;
let processingId: string;
let skipReason: string | null = null;

beforeAll(async () => {
  const probe = await supabase.from('profile_photos').select('id').limit(1);
  if (probe.error) {
    if (
      probe.error.code === 'PGRST205' ||
      /not find the table/i.test(probe.error.message) ||
      /does not exist/i.test(probe.error.message)
    ) {
      skipReason = '[photo-watercolor-pipeline] mig 028 not applied — skipping discover photos tests';
      return;
    }
  }

  const viewer = await getAuthToken(VIEWER_EMAIL);
  viewerToken = viewer.token;
  viewerId = viewer.userId;
  await cleanupUser(viewerId);
  await supabase.from('profile_photos').delete().eq('user_id', viewerId);
  await supabase.from('profiles').upsert({
    id: viewerId,
    display_name: 'Viewer',
    birth_date: '1995-01-01',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    is_active: true,
  });

  const readyAuth = await getAuthToken(READY_CANDIDATE_EMAIL);
  readyId = readyAuth.userId;
  await cleanupUser(readyId);
  await supabase.from('profile_photos').delete().eq('user_id', readyId);
  // 크로스언어 정책 — viewer 와 다른 언어 (ja).
  await supabase.from('profiles').upsert({
    id: readyId,
    display_name: 'Ready Candidate',
    birth_date: '1995-01-01',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    is_active: true,
  });
  await supabase.from('profile_photos').insert({
    user_id: readyId,
    position: 0,
    converted_url: 'https://fake.test/ready-converted.png',
    status: 'ready',
  });

  const procAuth = await getAuthToken(PROCESSING_CANDIDATE_EMAIL);
  processingId = procAuth.userId;
  await cleanupUser(processingId);
  await supabase.from('profile_photos').delete().eq('user_id', processingId);
  await supabase.from('profiles').upsert({
    id: processingId,
    display_name: 'Processing Candidate',
    birth_date: '1995-01-01',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    is_active: true,
  });
  await supabase.from('profile_photos').insert({
    user_id: processingId,
    position: 0,
    original_path: `${processingId}/originals/p0.jpg`,
    status: 'processing',
  });
});

afterAll(async () => {
  if (skipReason) return;
  for (const id of [viewerId, readyId, processingId]) {
    await supabase.from('profile_photos').delete().eq('user_id', id);
    await cleanupUser(id);
  }
});

describe('GET /api/discover — profile_photos 통합', () => {
  it('status=ready 후보만 노출 (status=processing 후보 제외)', async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const res = await request(app)
      .get('/api/discover?limit=20')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    const candidateIds = res.body.map((c: any) => c.id);
    // Ready 후보만 노출.
    expect(candidateIds).toContain(readyId);
    expect(candidateIds).not.toContain(processingId);
  });

  it('응답 photos[0] = converted_url (옛 photos 배열 미사용)', async () => {
    if (skipReason) return;
    const res = await request(app)
      .get('/api/discover?limit=20')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    const ready = res.body.find((c: any) => c.id === readyId);
    expect(ready?.photos).toEqual(['https://fake.test/ready-converted.png']);
  });

  it('photo_access 항상 false/false (디스커버 정책 유지)', async () => {
    if (skipReason) return;
    const res = await request(app)
      .get('/api/discover?limit=20')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    res.body.forEach((c: any) => {
      expect(c.photo_access.main_photo_unlocked).toBe(false);
      expect(c.photo_access.all_photos_unlocked).toBe(false);
    });
  });
});
