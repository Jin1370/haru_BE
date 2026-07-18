import { supabase } from '../config/supabase';

// audit 테이블 365 일 cleanup sweep.
//
// 대상:
//   * moderation_blocks (mig 020) — 콘텐츠 차단 audit. blocked_at 기준.
//   * freeze_events     (mig 021) — 자동 freeze audit. triggered_at 기준.
//   * reports           (mig 002) — 사용자 신고 audit. created_at 기준.
//     evidence-hold-on-delete sprint (2026-05-27) 에서 365 일 sweep 추가.
//     분쟁·수사 협조 보존 근거 (PIPA §21(1) 단서 + §21(3) 분리 저장 +
//     정통망법 §44조의10 명예훼손 분쟁조정부 + 전기통신사업법 §83 수사기관
//     통신자료 제공 요청).
//   * blocks            (mig 002) — 사용자 차단 audit. created_at 기준.
//     동일 sprint, 동일 근거. 가해자 차단 패턴 추적용 audit 성격으로 분류.
//
// 정책:
//   사용자 결정 (2026-05-24) — 90 일 → 1 년 보관. 운영 관점 (재범자 식별,
//   신고 패턴 분석) 가치 확보 + PIPA §3 / GDPR Art.5(1)(e) storage limitation
//   정합. 무기한 보관은 PIPA §21 위배라 cleanup 자체는 필수.
//
//   evidence-hold-on-delete (2026-05-27) — deleteAccount 가 moderation_blocks /
//   freeze_events 를 동기 DELETE 하던 회귀를 폐기하고 본 sweep 에 일임. reports /
//   blocks 도 발생 시점 기준 365 일 보존 후 자동 폐기로 통일.
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

type AuditTable = {
  table: 'moderation_blocks' | 'freeze_events' | 'reports' | 'blocks';
  timeColumn: 'blocked_at' | 'triggered_at' | 'created_at';
  key: 'moderation' | 'freeze' | 'reports' | 'blocks';
};

const AUDIT_TABLES: AuditTable[] = [
  { table: 'moderation_blocks', timeColumn: 'blocked_at',   key: 'moderation' },
  { table: 'freeze_events',     timeColumn: 'triggered_at', key: 'freeze'     },
  { table: 'reports',           timeColumn: 'created_at',   key: 'reports'    },
  { table: 'blocks',            timeColumn: 'created_at',   key: 'blocks'     },
];

async function sweepAuditTable(
  table: AuditTable['table'],
  timeColumn: string,
  cutoff: string,
): Promise<{ deleted: number; error: boolean }> {
  // silent-success 룰 (CLAUDE.md): 외부 의존성 호출 결과의 error 를
  // destructure 후 console.error 로 가시화. PGRST205 같은 테이블 부재
  // 에러도 동일 경로 — silent skip 금지.
  const result = await supabase
    .from(table)
    .delete({ count: 'exact' })
    .lt(timeColumn, cutoff);
  if (result.error) {
    console.error(`[audit-cleanup] ${table} delete failed`, result.error.message);
    return { deleted: 0, error: true };
  }
  return { deleted: result.count ?? 0, error: false };
}

export async function sweepAuditTables(): Promise<{
  moderationDeleted: number;
  freezeDeleted: number;
  reportsDeleted: number;
  blocksDeleted: number;
  errors: number;
}> {
  const cutoff = cutoffIso(RETENTION_DAYS);
  const results = await Promise.all(
    AUDIT_TABLES.map((t) => sweepAuditTable(t.table, t.timeColumn, cutoff)),
  );
  const lookup = Object.fromEntries(
    AUDIT_TABLES.map((t, i) => [t.key, results[i]]),
  ) as Record<AuditTable['key'], { deleted: number; error: boolean }>;
  return {
    moderationDeleted: lookup.moderation.deleted,
    freezeDeleted:     lookup.freeze.deleted,
    reportsDeleted:    lookup.reports.deleted,
    blocksDeleted:     lookup.blocks.deleted,
    errors: results.filter((r) => r.error).length,
  };
}

let scheduler: NodeJS.Timeout | null = null;

// 0 건이면 silent (출시 직후 매 부팅마다 빈 sweep 로그 노이즈 회피).
function runSweep(label: string): void {
  sweepAuditTables()
    .then((r) => {
      if (
        r.moderationDeleted > 0 ||
        r.freezeDeleted > 0 ||
        r.reportsDeleted > 0 ||
        r.blocksDeleted > 0
      ) {
        console.log(`[audit-cleanup.sweep] ${label}`, r);
      }
    })
    .catch((err) => console.error(`[audit-cleanup.sweep] ${label} error`, err));
}

export function startAuditCleanupScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduler) return; // 중복 등록 가드

  // 부팅 직후 1 회. 다중 인스턴스 배포 시 동시 DELETE 도 멱등 (cutoff 이전 row 가
  // 0 개면 no-op). audio-expiry sweep 보다 30 초 늦게 시작해 동시 부담 분산.
  const bootTimer = setTimeout(() => runSweep('boot'), BOOT_DELAY_MS);
  bootTimer.unref();

  scheduler = setInterval(() => runSweep('tick'), SWEEP_INTERVAL_MS);
  scheduler.unref();
}
