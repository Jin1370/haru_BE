// photo-reorder-no-reconvert sprint — PATCH /api/profile/photos/order 회귀.
//
// 재변환 없이 profile_photos.position 만 원자적으로 재배치하는 RPC + 라우트 검증.
// 안전 제약(position 0 = ready 강제) + 소유권/완전성/UNIQUE swap 원자성.
//
// mig 028(profile_photos) 또는 mig 030(reorder_profile_photos RPC) 미적용 환경은 silent skip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const EMAIL = 'apitest_photoreorder@testmail.com';
const OTHER_EMAIL = 'apitest_photoreorder_other@testmail.com';
let token: string;
let userId: string;
let otherUserId: string;
let skipReason: string | null = null;

// position 0~N 의 row 를 채워넣고 id 목록을 position 순으로 반환.
type SeedRow = { position: number; status: string; url?: string };
async function seedPhotos(uid: string, rows: SeedRow[]): Promise<string[]> {
  await supabase.from('profile_photos').delete().eq('user_id', uid);
  const ids: string[] = [];
  for (const r of rows) {
    const { data } = await supabase
      .from('profile_photos')
      .insert({
        user_id: uid,
        position: r.position,
        status: r.status,
        converted_url: r.status === 'ready' ? (r.url ?? `https://fake.test/p${r.position}.png`) : null,
        original_path: r.status === 'ready' ? null : `${uid}/originals/p${r.position}.jpg`,
      })
      .select('id')
      .single();
    ids.push(data!.id);
  }
  return ids;
}

async function positionsById(uid: string): Promise<Record<string, number>> {
  const { data } = await supabase
    .from('profile_photos')
    .select('id, position')
    .eq('user_id', uid);
  const map: Record<string, number> = {};
  (data ?? []).forEach((r: { id: string; position: number }) => {
    map[r.id] = r.position;
  });
  return map;
}

beforeAll(async () => {
  const tableProbe = await supabase.from('profile_photos').select('id').limit(1);
  if (
    tableProbe.error &&
    (tableProbe.error.code === 'PGRST205' ||
      /not find the table/i.test(tableProbe.error.message) ||
      /does not exist/i.test(tableProbe.error.message))
  ) {
    skipReason = '[photo-reorder-no-reconvert] mig 028 (profile_photos) not applied — skipping';
    return;
  }

  // RPC probe — mig 030 미적용 시 함수 not found. 무해한 호출 (존재하지 않는 user +
  // 빈 order) 의 error 가 함수 미존재인지 검사.
  const rpcProbe = await supabase.rpc('reorder_profile_photos', {
    p_user_id: '00000000-0000-0000-0000-000000000000',
    p_order: [],
  });
  if (
    rpcProbe.error &&
    (rpcProbe.error.code === 'PGRST202' ||
      /could not find the function/i.test(rpcProbe.error.message) ||
      /does not exist/i.test(rpcProbe.error.message))
  ) {
    skipReason = '[photo-reorder-no-reconvert] mig 030 (reorder_profile_photos RPC) not applied — skipping';
    return;
  }

  const auth = await getAuthToken(EMAIL);
  token = auth.token;
  userId = auth.userId;
  const otherAuth = await getAuthToken(OTHER_EMAIL);
  otherUserId = otherAuth.userId;

  await supabase.from('profiles').upsert({
    id: userId,
    display_name: 'Reorder Test',
    birth_date: '1995-01-01',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
  });
  await supabase.from('profiles').upsert({
    id: otherUserId,
    display_name: 'Reorder Other',
    birth_date: '1995-01-01',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
  });
  await supabase.from('profile_photos').delete().eq('user_id', userId);
  await supabase.from('profile_photos').delete().eq('user_id', otherUserId);
});

afterAll(async () => {
  if (skipReason) return;
  await supabase.from('profile_photos').delete().eq('user_id', userId);
  await supabase.from('profile_photos').delete().eq('user_id', otherUserId);
  await cleanupUser(userId);
  await cleanupUser(otherUserId);
});

describe('PATCH /api/profile/photos/order', () => {
  it('1) 정상 reorder — 3장 ready, order=[id3,id1,id2]', async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    const [id1, id2, id3] = await seedPhotos(userId, [
      { position: 0, status: 'ready', url: 'https://fake.test/a.png' },
      { position: 1, status: 'ready', url: 'https://fake.test/b.png' },
      { position: 2, status: 'ready', url: 'https://fake.test/c.png' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [id3, id1, id2] });

    expect(res.status).toBe(200);
    const pos = await positionsById(userId);
    expect(pos[id3]).toBe(0);
    expect(pos[id1]).toBe(1);
    expect(pos[id2]).toBe(2);
    // 응답 photos 순서 = position ASC = c, a, b.
    expect(res.body.photos).toEqual([
      'https://fake.test/c.png',
      'https://fake.test/a.png',
      'https://fake.test/b.png',
    ]);
  });

  it('2) 메인설정 — 비메인 ready 사진을 맨 앞으로', async () => {
    if (skipReason) return;
    const [id1, id2] = await seedPhotos(userId, [
      { position: 0, status: 'ready' },
      { position: 1, status: 'ready' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [id2, id1] });

    expect(res.status).toBe(200);
    const pos = await positionsById(userId);
    expect(pos[id2]).toBe(0);
    expect(pos[id1]).toBe(1);
  });

  it('3) position 0 비-ready 거부 → 422 main_photo_not_ready', async () => {
    if (skipReason) return;
    const [idReady, idProc] = await seedPhotos(userId, [
      { position: 0, status: 'ready' },
      { position: 1, status: 'processing' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [idProc, idReady] }); // processing 을 메인으로

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('main_photo_not_ready');
    // position 변경 없음 (롤백).
    const pos = await positionsById(userId);
    expect(pos[idReady]).toBe(0);
    expect(pos[idProc]).toBe(1);
  });

  it('4) 타인 id 포함 → 404', async () => {
    if (skipReason) return;
    const [id1] = await seedPhotos(userId, [{ position: 0, status: 'ready' }]);
    const [otherId] = await seedPhotos(otherUserId, [{ position: 0, status: 'ready' }]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [id1, otherId] });

    // 개수는 2지만 내 row 는 1개 → order_count_mismatch 또는 photo_not_owned.
    // 둘 다 거부 status (404/400). 명세상 타인 id 핵심은 거부.
    expect([400, 404]).toContain(res.status);
  });

  it('5) 개수 불일치 (일부 row 누락) → 400', async () => {
    if (skipReason) return;
    const [id1] = await seedPhotos(userId, [
      { position: 0, status: 'ready' },
      { position: 1, status: 'ready' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [id1] }); // 2장인데 1개만

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/every photo/);
  });

  it('6) UNIQUE swap 원자성 — 2장 0↔1 swap 이 23505 없이 성공', async () => {
    if (skipReason) return;
    const [id1, id2] = await seedPhotos(userId, [
      { position: 0, status: 'ready' },
      { position: 1, status: 'ready' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [id2, id1] });

    expect(res.status).toBe(200);
    const pos = await positionsById(userId);
    expect(pos[id2]).toBe(0);
    expect(pos[id1]).toBe(1);
  });

  it('7) 비-ready 1~4 슬롯 허용 — order[0]=ready, order[1]=processing → 200', async () => {
    if (skipReason) return;
    const [idReady, idProc] = await seedPhotos(userId, [
      { position: 0, status: 'ready', url: 'https://fake.test/ready.png' },
      { position: 1, status: 'processing' },
    ]);

    const res = await request(app)
      .patch('/api/profile/photos/order')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: [idReady, idProc] });

    expect(res.status).toBe(200);
    const pos = await positionsById(userId);
    expect(pos[idReady]).toBe(0);
    expect(pos[idProc]).toBe(1);
    // processing 사진은 ready 아니라 photos 배열엔 미포함.
    expect(res.body.photos).toEqual(['https://fake.test/ready.png']);
    expect(res.body.photo_statuses.length).toBe(2);
  });
});
