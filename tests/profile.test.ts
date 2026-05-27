import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { supabase } from '../src/config/supabase';
import { getAuthToken, cleanupUser } from './helpers';

const TEST_EMAIL = 'apitest_profile@testmail.com';
let token: string;
let userId: string;

// photo-watercolor-pipeline sprint (mig 028) 미적용 환경 가드.
// mig 028 적용 후엔 profile_photos 가 존재 — 사진 테스트 정상 진입.
async function profilePhotosTableMissing(): Promise<boolean> {
  const probe = await supabase.from('profile_photos').select('id').limit(1);
  if (!probe.error) return false;
  return (
    probe.error.code === 'PGRST205' ||
    /not find the table/i.test(probe.error.message) ||
    /does not exist/i.test(probe.error.message)
  );
}

describe('Profile Routes', () => {
  beforeAll(async () => {
    const auth = await getAuthToken(TEST_EMAIL);
    token = auth.token;
    userId = auth.userId;
    await cleanupUser(userId);
    // 본 sprint 신규 테이블 cleanup — mig 028 적용 환경에서만.
    try {
      await supabase.from('profile_photos').delete().eq('user_id', userId);
    } catch {
      /* table missing — ignore */
    }
  });

  afterAll(async () => {
    try {
      await supabase.from('profile_photos').delete().eq('user_id', userId);
    } catch {
      /* table missing — ignore */
    }
    await cleanupUser(userId);
  });

  describe('GET /api/profile/me', () => {
    it('인증 없으면 401', async () => {
      const res = await request(app).get('/api/profile/me');
      expect(res.status).toBe(401);
    });

    it('프로필 없으면 404', async () => {
      const res = await request(app)
        .get('/api/profile/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/profile/me', () => {
    it('필수 필드 없으면 400', async () => {
      const res = await request(app)
        .put('/api/profile/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ display_name: 'Test' });
      expect(res.status).toBe(400);
    });

    it('프로필 생성 성공', async () => {
      const res = await request(app)
        .put('/api/profile/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          display_name: 'Profile Test',
          birth_date: '1995-06-15',
          gender: 'male',
          nationality: 'KR',
          language: 'ko',
          voice_intro: 'Hello world',
          interests: ['music', 'travel'],
        });

      expect(res.status).toBe(200);
      expect(res.body.display_name).toBe('Profile Test');
      expect(res.body.voice_intro).toBe('Hello world');
      expect(res.body.interests).toEqual(['music', 'travel']);
      // mig 011: voice intro 다국어 슬롯 컬럼이 응답에 노출되어야 함.
      // voice_clone 미보유 사용자라 파이프라인은 트리거되지 않지만,
      // PUT 의 upsertPayload 가 빈 객체로 리셋했으므로 응답에는 빈 객체.
      expect(res.body.voice_intro_translations).toEqual({});
      expect(res.body.voice_intro_audio_urls).toEqual({});
      expect(res.body.voice_intro_audio_status).toEqual({});
    });

    it('프로필 수정 성공', async () => {
      const res = await request(app)
        .put('/api/profile/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          display_name: 'Updated Name',
          birth_date: '1995-06-15',
          gender: 'male',
          nationality: 'KR',
          language: 'ko',
        });

      expect(res.status).toBe(200);
      expect(res.body.display_name).toBe('Updated Name');
    });
  });

  describe('GET /api/profile/me (after creation)', () => {
    it('프로필 조회 성공', async () => {
      const res = await request(app)
        .get('/api/profile/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(userId);
      expect(res.body.display_name).toBe('Updated Name');
    });
  });

  describe('POST /api/profile/photos', () => {
    it('파일 없으면 400', async () => {
      const res = await request(app)
        .post('/api/profile/photos')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No photo file provided');
    });

    it('허용되지 않는 MIME 타입이면 400', async () => {
      const res = await request(app)
        .post('/api/profile/photos')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.from('fake'), {
          filename: 'test.txt',
          contentType: 'text/plain',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Only JPEG, PNG, WebP images are allowed');
    });

    // photo-watercolor-pipeline sprint: 202 + status='processing' (비동기 변환).
    // mig 028 미적용 환경은 silent skip.
    it('사진 업로드 성공 (mig 028 적용 시 202 비동기)', async () => {
      if (await profilePhotosTableMissing()) {
        console.warn('[photo-watercolor-pipeline] mig 028 not applied — skipping upload test');
        return;
      }
      const res = await request(app)
        .post('/api/profile/photos')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', Buffer.from('fake-image-data'), {
          filename: 'test.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(202);
      expect(res.body.photo_id).toBeDefined();
      expect(res.body.status).toBe('processing');
      expect(res.body.position).toBe(0);
    });
  });

  describe('DELETE /api/profile/photos/:index', () => {
    it('유효하지 않은 인덱스면 400', async () => {
      if (await profilePhotosTableMissing()) {
        console.warn('[photo-watercolor-pipeline] mig 028 not applied — skipping delete-404 test');
        return;
      }
      const res = await request(app)
        .delete('/api/profile/photos/99')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid photo index');
    });

    it('사진 삭제 성공', async () => {
      if (await profilePhotosTableMissing()) {
        console.warn('[photo-watercolor-pipeline] mig 028 not applied — skipping delete-success test');
        return;
      }
      const res = await request(app)
        .delete('/api/profile/photos/0')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.photos).toBeInstanceOf(Array);
      expect(res.body.photo_statuses).toBeInstanceOf(Array);
    });
  });
});
