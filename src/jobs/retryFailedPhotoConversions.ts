// photo-watercolor-pipeline sprint — retry sweep job.
//
// 차별점 4 의 가용성 보존: gpt-image-2 호출의 transient 실패 (네트워크/타임아웃/5xx)
// 시 status='failed' 또는 'pending' (백필 row) row 를 자동 재시도.
//
// eligibility (사용자 결정 #2 — 자동 백필 ON):
//   - status IN ('pending', 'failed') AND retry_count < MAX_RETRIES, OR
//   - status='processing' AND updated_at < now() - STALE_PROCESSING_MS (stuck recovery)
//
// 부팅 직후 1회 (90초 후 — audio-expiry 60초 / audit-cleanup 90초 와 어긋나지 않도록
// 120초 로 분산) + 이후 10 분 간격. setInterval + unref() 패턴 (audio-expiry / audit-
// cleanup sweep 정확히 재사용).
//
// NODE_ENV=test 환경에선 등록 자체를 스킵 — vitest idle handle 회귀 차단.
//
// race 차단 (multi-worker / hot-reload):
//   1. SELECT candidate id 목록
//   2. UPDATE WHERE id IN (...) AND status IN ('pending','failed','processing stale')
//      → atomically lock 잡은 row 만 RETURNING. 이중 호출 차단.
//   3. 잡힌 row 만 convertProfilePhoto 호출.
// convertProfilePhoto 안의 status='processing' UPDATE 도 그대로 둠 (POST /photos
// 동기 호출 경로 — sweep 외 경로 race 가드).

import { supabase } from '../config/supabase';
import { retryPendingOrFailedPhoto } from '../services/photoConversion';
import {
  PHOTO_CONVERSION_MAX_RETRIES,
  PHOTO_CONVERSION_RETRY_INTERVAL_MS,
  PHOTO_CONVERSION_SWEEP_BATCH_SIZE,
} from '../constants/photoConversion';

interface SweepCandidate {
  id: string;
  user_id: string;
  original_path: string | null;
  status: string;
  retry_count: number;
}

export interface PhotoConversionSweepResult {
  scanned: number;
  succeeded: number;
  failed: number;
  rejected: number;
  skipped: number;
}

// 'processing' 잔존이 STALE_PROCESSING_MS 이상이면 stuck 으로 간주하고 복구.
// 변환 호출은 OpenAI 응답 + Storage 업로드 합쳐 평균 5~15초. 5분이면 충분히 stuck.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export async function sweepPendingPhotoConversions(): Promise<PhotoConversionSweepResult> {
  // (1) candidate SELECT — 두 분기를 별도 호출로 분리 (.or() 안 isoString escape 회피).
  //     (a) pending/failed + retry 가능
  //     (b) stale processing — STALE_PROCESSING_MS 초과 잔존
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();

  const { data: pendingFailed, error: errA } = await supabase
    .from('profile_photos')
    .select('id, user_id, original_path, status, retry_count')
    .in('status', ['pending', 'failed'])
    .lt('retry_count', PHOTO_CONVERSION_MAX_RETRIES)
    .limit(PHOTO_CONVERSION_SWEEP_BATCH_SIZE);

  if (errA) {
    console.error('[retryFailedPhotoConversions.select_pending_failed]', errA.message);
    return { scanned: 0, succeeded: 0, failed: 0, rejected: 0, skipped: 0 };
  }

  const { data: staleProcessing, error: errB } = await supabase
    .from('profile_photos')
    .select('id, user_id, original_path, status, retry_count')
    .eq('status', 'processing')
    .lt('updated_at', staleCutoff)
    .lt('retry_count', PHOTO_CONVERSION_MAX_RETRIES)
    .limit(PHOTO_CONVERSION_SWEEP_BATCH_SIZE);

  if (errB) {
    console.error('[retryFailedPhotoConversions.select_stale_processing]', errB.message);
  }

  const rawCandidates = [
    ...((pendingFailed ?? []) as SweepCandidate[]),
    ...((staleProcessing ?? []) as SweepCandidate[]),
  ].slice(0, PHOTO_CONVERSION_SWEEP_BATCH_SIZE);

  if (rawCandidates.length === 0) {
    return { scanned: 0, succeeded: 0, failed: 0, rejected: 0, skipped: 0 };
  }

  // (2) Atomic lock — UPDATE id IN (...) + status guard. 다른 워커가 먼저 잡은 row 는
  //     status='processing' + updated_at 갱신으로 이미 가드 미적중 → 자연 배제.
  //     processing stale 분기는 updated_at < staleCutoff 가드 유지로 동시 잡힘 방지.
  const candidateIds = rawCandidates.map((r) => r.id);
  const candidatePrevStatus = new Map(rawCandidates.map((r) => [r.id, r.status] as const));

  // 두 분기 atomic lock 도 분리.
  const { data: lockedA, error: lockErrA } = await supabase
    .from('profile_photos')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .in('id', candidateIds)
    .in('status', ['pending', 'failed'])
    .lt('retry_count', PHOTO_CONVERSION_MAX_RETRIES)
    .select('id, user_id, original_path, retry_count');

  if (lockErrA) {
    console.error('[retryFailedPhotoConversions.lock_pending_failed]', lockErrA.message);
  }

  const { data: lockedB, error: lockErrB } = await supabase
    .from('profile_photos')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .in('id', candidateIds)
    .eq('status', 'processing')
    .lt('updated_at', staleCutoff)
    .lt('retry_count', PHOTO_CONVERSION_MAX_RETRIES)
    .select('id, user_id, original_path, retry_count');

  if (lockErrB) {
    console.error('[retryFailedPhotoConversions.lock_stale]', lockErrB.message);
  }

  const candidates = [
    ...((lockedA ?? []) as Omit<SweepCandidate, 'status'>[]),
    ...((lockedB ?? []) as Omit<SweepCandidate, 'status'>[]),
  ].map((r) => ({
    ...r,
    status: candidatePrevStatus.get(r.id) ?? 'pending',
  })) as SweepCandidate[];
  let succeeded = 0;
  let failed = 0;
  let rejected = 0;
  let skipped = 0;

  // gpt-image-2 응답 40~60초 + 5 IPM 한도 → concurrency 4 가 안전 fit.
  // chunk(CONCURRENCY) + Promise.all 패턴 — 한 chunk 가 가장 느린 row 만큼 대기하지만
  // 평균 처리 시간 차이 작아 낭비 미세. 의존성 추가 회피 위해 p-limit 미사용.
  const CONCURRENCY = 4;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (row) => {
        if (!row.original_path) {
          // 원본 경로 부재 — inconsistent state (race 잔재). silent skip + 로그.
          console.warn('[retryFailedPhotoConversions.skip_no_original]', {
            photo_row_id: row.id,
            user_id: row.user_id,
            status: row.status,
          });
          return { kind: 'skipped' as const, row };
        }
        try {
          const r = await retryPendingOrFailedPhoto(row.user_id, row.id, row.original_path);
          return { kind: r.status, row } as const;
        } catch (e) {
          console.error('[retryFailedPhotoConversions.unexpected_error]', {
            photo_row_id: row.id,
            user_id: row.user_id,
            error: (e as Error).message,
          });
          return { kind: 'failed' as const, row };
        }
      }),
    );

    for (const r of results) {
      if (r.kind === 'ready') succeeded += 1;
      else if (r.kind === 'rejected') rejected += 1;
      else if (r.kind === 'skipped') skipped += 1;
      else failed += 1;
    }
  }

  if (candidates.length > 0) {
    console.log('[retryFailedPhotoConversions.sweep]', {
      scanned: candidates.length,
      succeeded,
      failed,
      rejected,
      skipped,
    });
  }

  return { scanned: candidates.length, succeeded, failed, rejected, skipped };
}

let scheduler: NodeJS.Timeout | null = null;

export function startPhotoConversionRetryScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduler) return;

  // audio-expiry (60s) / audit-cleanup (90s) 와 어긋나게 120s 로 분산.
  const BOOT_DELAY_MS = 120 * 1000;

  const bootTimer = setTimeout(() => {
    sweepPendingPhotoConversions().catch((e) => {
      console.error('[retryFailedPhotoConversions.boot_error]', e);
    });
  }, BOOT_DELAY_MS);
  bootTimer.unref();

  scheduler = setInterval(() => {
    sweepPendingPhotoConversions().catch((e) => {
      console.error('[retryFailedPhotoConversions.tick_error]', e);
    });
  }, PHOTO_CONVERSION_RETRY_INTERVAL_MS);
  scheduler.unref();
}
