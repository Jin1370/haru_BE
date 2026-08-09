import { describe, it, expect } from 'vitest';
import { beginProcessing, endProcessing, inFlightCount } from '../src/routes/message';

// index.ts 의 드레인 루프와 동일한 형태를 재현해, "진행 중이면 기다리고 / 비면
// 즉시 끝나고 / 상한을 넘기면 포기한다" 세 성질을 잠근다.
async function drain(timeoutMs: number, pollMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (inFlightCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return inFlightCount();
}

describe('graceful drain', () => {
  it('진행 중인 파이프라인이 끝날 때까지 기다린다', async () => {
    beginProcessing('a');
    setTimeout(() => endProcessing('a'), 200);
    const t0 = Date.now();
    const left = await drain(3000);
    expect(left).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  it('진행 중인 게 없으면 즉시 끝난다', async () => {
    const t0 = Date.now();
    expect(await drain(3000)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('상한을 넘기면 포기하고 남은 수를 보고한다 (배포가 영영 안 끝나는 것 방지)', async () => {
    beginProcessing('stuck');
    const left = await drain(150);
    expect(left).toBe(1);
    endProcessing('stuck');
  });
});
