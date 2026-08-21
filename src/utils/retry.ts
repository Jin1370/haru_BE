// 외부 API 호출의 일시적 실패 1회 재시도.
//
// 배경 (2026-08-21): Fly 머신이 호스트 레벨로 죽었다 재시작한 직후 Supabase 로
// 나가는 fetch 가 몇 초간 통째로 실패했다 (`TypeError: fetch failed`). 하루 한 번
// 도는 audit sweep 은 다음날 다시 돌면 그만이지만, 메시지 파이프라인(번역 → TTS)
// 은 그 자리에서 audio_status='failed' 로 확정되고 그 메시지는 수신자에게 영영
// 안 보인다. 몇 초짜리 딸꾹질이 메시지 유실이 되는 셈.
//
// 정책:
//   * 딱 1 회. 무한 재시도는 장애를 증폭시킨다.
//   * 첫 실패는 console.warn — Sentry 는 'error' 만 이벤트로 승격하므로(instrument.ts)
//     "재시도로 살아난" 건은 알림이 되지 않는다. 두 번째도 실패하면 throw 되어
//     호출처의 기존 에러 처리(Sentry.captureException 등)가 그대로 발화한다.
//   * 성공하는 호출에는 아무 영향 없음 — 재시도는 실패했을 때만 돈다.
//
// 재시도 안전성: 첫 호출이 실제로는 서버에 도달했는데 응답만 유실된 경우 두 번
// 과금될 수 있다 (ElevenLabs). 메시지 유실보다 낫다는 판단이며, 빈도 자체가
// 매우 낮다.
const DEFAULT_DELAY_MS = 3000;

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export async function retryOnce<T>(
  fn: () => Promise<T>,
  label: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<T> {
  try {
    return await fn();
  } catch (first) {
    console.warn(`[retryOnce] ${label} 1차 실패 — ${delayMs}ms 후 1회 재시도:`, describe(first));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await fn();
  }
}
