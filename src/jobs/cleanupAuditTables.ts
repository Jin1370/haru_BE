import { supabase } from '../config/supabase';

// audit 테이블 365 일 cleanup sweep.
//
// 대상:
//   * moderation_blocks (mig 020) — 차단 audit. blocked_at 기준.
//   * freeze_events (mig 021)     — 자동 freeze audit. triggered_at 기준.
//
// 정책:
//   사용자 결정 (2026-05-24) — 90 일 → 1 년 보관으로 변경. 운영 관점 (재범자 식별,
//   신고 패턴 분석) 가치 확보 + PIPA §3 (data minimization) / GDPR Art.5(1)(e)
//   storage limitation 정합. 무기한 보관은 PIPA §21 (목적 달성 시 지체 없이 파기)
//   위배라 cleanup 자체는 필수.
//
// 실패 정책:
//   sweep 실패는 console.error 후 다음 tick. 다른 sweep 과 직교 (한 테이블 실패
//   가 다른 테이블 cleanup 막지 않음). NODE_ENV=test 는 스케줄러 등록 자체 skip
//   — sweepAuditTables() 함수는 export 되어 단위 테스트가 직접 호출 가능.

const RETENTION_DAYS = 365;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 시간
const BOOT_DELAY_MS = 90 * 1000; // 부팅 후 90 초 — audio-expiry sweep (60 초) 과 어긋나게 배치

function cutoffIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

export async function sweepAuditTables(): Promise<{
  moderationDeleted: number;
  freezeDeleted: number;
  errors: number;
}> {
  const cutoff = cutoffIso(RETENTION_DAYS);
  let errors = 0;

  // moderation_blocks
  const moderationResult = await supabase
    .from('moderation_blocks')
    .delete({ count: 'exact' })
    .lt('blocked_at', cutoff);

  let moderationDeleted = 0;
  if (moderationResult.error) {
    console.error('[audit-cleanup] moderation_blocks delete failed', moderationResult.error.message);
    errors += 1;
  } else {
    moderationDeleted = moderationResult.count ?? 0;
  }

  // freeze_events
  const freezeResult = await supabase
    .from('freeze_events')
    .delete({ count: 'exact' })
    .lt('triggered_at', cutoff);

  let freezeDeleted = 0;
  if (freezeResult.error) {
    console.error('[audit-cleanup] freeze_events delete failed', freezeResult.error.message);
    errors += 1;
  } else {
    freezeDeleted = freezeResult.count ?? 0;
  }

  return { moderationDeleted, freezeDeleted, errors };
}

let scheduler: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export function startAuditCleanupScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduler) return; // 중복 등록 가드

  // 부팅 직후 1 회. 다중 인스턴스 배포 시 동시 DELETE 도 멱등 (cutoff 이전 row 가
  // 0 개면 no-op). audio-expiry sweep 보다 30 초 늦게 시작해 동시 부담 분산.
  // 0 건이면 silent — tick 과 동일 패턴 (출시 직후 매 부팅마다 빈 sweep 로그 노이즈 회피).
  bootTimer = setTimeout(() => {
    bootTimer = null;
    sweepAuditTables()
      .then((r) => {
        if (r.moderationDeleted > 0 || r.freezeDeleted > 0) {
          console.log('[audit-cleanup.sweep] boot', r);
        }
      })
      .catch((err) => console.error('[audit-cleanup.sweep] boot error', err));
  }, BOOT_DELAY_MS);
  bootTimer.unref();

  scheduler = setInterval(() => {
    sweepAuditTables()
      .then((r) => {
        if (r.moderationDeleted > 0 || r.freezeDeleted > 0) {
          console.log('[audit-cleanup.sweep] tick', r);
        }
      })
      .catch((err) => console.error('[audit-cleanup.sweep] tick error', err));
  }, SWEEP_INTERVAL_MS);
  scheduler.unref();
}

export function stopAuditCleanupScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
