// 사진 변환 제공자 폴백 — 회사 Azure 실패 시 개인 OpenAI 직접으로 재시도.
// 안전 필터 거부는 폴백하지 않는다 (다른 제공자로 필터 우회 금지).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { editByKey } = vi.hoisted(() => ({ editByKey: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    images: { edit: (...a: unknown[]) => unknown };
    constructor(opts: { apiKey: string }) {
      this.images = { edit: (...a) => editByKey[opts.apiKey](...a) };
    }
  },
  toFile: vi.fn(async () => ({})),
}));
vi.mock('../src/config/env', () => ({
  env: {
    image: { azureBaseUrl: 'https://azure.example/deployments/x', azureApiKey: 'azure-key', azureApiVersion: 'v' },
    openai: { moderationApiKey: 'openai-key' },
  },
}));
vi.mock('../src/config/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['update', 'eq', 'select', 'delete']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: { retry_count: 0 } });
  chain.then = (r: (v: unknown) => unknown) => r({ error: null });
  return { supabase: { from: () => chain } };
});
vi.mock('../src/services/storage', () => ({
  uploadFile: vi.fn(async () => 'https://storage/converted.jpg'),
  deleteFile: vi.fn(async () => undefined),
  extractPath: vi.fn(() => 'p'),
}));
vi.mock('../src/utils/moderationAudit', () => ({ logModerationBlock: vi.fn() }));

import { convertProfilePhoto } from '../src/services/photoConversion';

const input = { userId: 'u', photoRowId: 'r', originalBuffer: Buffer.from('x'), mimeType: 'image/jpeg' };
const ok = { data: [{ b64_json: Buffer.from('img').toString('base64') }] };

describe('convertProfilePhoto 제공자 폴백', () => {
  beforeEach(() => {
    editByKey['azure-key'] = vi.fn();
    editByKey['openai-key'] = vi.fn();
  });

  it('Azure 성공이면 OpenAI 는 호출 안 함', async () => {
    editByKey['azure-key'].mockResolvedValue(ok);
    expect((await convertProfilePhoto(input)).status).toBe('ready');
    expect(editByKey['openai-key']).not.toHaveBeenCalled();
  });

  it('Azure 가 키 정지(401)면 OpenAI 직접으로 변환', async () => {
    editByKey['azure-key'].mockRejectedValue(Object.assign(new Error('Access denied'), { status: 401 }));
    editByKey['openai-key'].mockResolvedValue(ok);
    expect((await convertProfilePhoto(input)).status).toBe('ready');
    expect(editByKey['openai-key']).toHaveBeenCalledTimes(1);
  });

  it('Azure 안전 필터 거부는 폴백 없이 rejected', async () => {
    editByKey['azure-key'].mockRejectedValue(
      Object.assign(new Error('rejected by content management policy'), { status: 400, code: 'content_filter' }),
    );
    expect((await convertProfilePhoto(input)).status).toBe('rejected');
    expect(editByKey['openai-key']).not.toHaveBeenCalled();
  });
});
