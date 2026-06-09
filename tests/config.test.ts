import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';

describe('GET /api/config (강제 업데이트 게이트)', () => {
  it('인증 없이 200 + min_version + 스토어 URL shape', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.min_version).toBe('string');
    expect(res.body.min_version.length).toBeGreaterThan(0);
    expect(typeof res.body.ios_store_url).toBe('string');
    expect(typeof res.body.android_store_url).toBe('string');
  });
});
