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
//   * deletion_stats    (mig 043) — 탈퇴 시점 활동 요약 스냅샷. deleted_at 기준.
//     카운트/boolean 만 담는 익명화-인접 통계라 raw PII 없음 — 이탈 분석용.
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
const RETRY_DELAY_MS = 3000; // 일시적 네트워크 실패 재시도 간격
const BOOT_DELAY_MS = 90 * 1000; // 부팅 후 90 초 — audio-expiry sweep (60 초) 과 어긋나게 배치

function cutoffIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

type AuditTable = {
  table: 'moderation_blocks' | 'freeze_events' | 'reports' | 'blocks' | 'deletion_stats' | 'daily_active_users';
  timeColumn: 'blocked_at' | 'triggered_at' | 'created_at' | 'deleted_at' | 'day';
  key: 'moderation' | 'freeze' | 'reports' | 'blocks' | 'deletionStats' | 'dau';
};

const AUDIT_TABLES: AuditTable[] = [
  { table: 'moderation_blocks', timeColumn: 'blocked_at',   key: 'moderation'    },
  { table: 'freeze_events',     timeColumn: 'triggered_at', key: 'freeze'        },
  { table: 'reports',           timeColumn: 'created_at',   key: 'reports'       },
  { table: 'blocks',            timeColumn: 'created_at',   key: 'blocks'        },
  { table: 'deletion_stats',    timeColumn: 'deleted_at',   key: 'deletionStats' },
  { table: 'daily_active_users', timeColumn: 'day',         key: 'dau'           },
];

async function sweepAuditTable(
  table: AuditTable['table'],
  timeColumn: string,
  cutoff: string,
): Promise<{ deleted: number; error: boolean }> {
  // silent-success 룰 (CLAUDE.md): 외부 의존성 호출 결과의 error 를
  // destructure 후 console.error 로 가시화. PGRST205 같은 테이블 부재
  // 에러도 동일 경로 — silent skip 금지.
  //
  // 단, cutoff 기준 DELETE 는 멱등이라 일시적 네트워크 실패 (`TypeError: fetch
  // failed` — Fly ↔ Supabase 순간 끊김) 는 1 회 재시도한다. 첫 실패부터 Sentry
  // 이벤트로 승격시키면 하루 한 번 도는 sweep 의 네트워크 딸꾹질이 그대로
  // 알림이 된다 (2026-08-20 HARU-BACKEND-H). 두 번째도 실패하면 그때 가시화.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .lt(timeColumn, cutoff);
    if (!result.error) return { deleted: result.count ?? 0, error: false };
    if (attempt === 1) {
      console.error(`[audit-cleanup] ${table} delete failed`, result.error.message);
      return { deleted: 0, error: true };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { deleted: 0, error: true }; // 도달 불가 (루프가 항상 return)
}

export async function sweepAuditTables(): Promise<{
  moderationDeleted: number;
  freezeDeleted: number;
  reportsDeleted: number;
  blocksDeleted: number;
  deletionStatsDeleted: number;
  dauDeleted: number;
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
    moderationDeleted:    lookup.moderation.deleted,
    freezeDeleted:        lookup.freeze.deleted,
    reportsDeleted:       lookup.reports.deleted,
    blocksDeleted:        lookup.blocks.deleted,
    deletionStatsDeleted: lookup.deletionStats.deleted,
    dauDeleted:           lookup.dau.deleted,
    errors: results.filter((r) => r.error).length,
  };
}

// 탈퇴자의 별사탕 구매 내역 (star_ledger kind='purchase') 5 년 sweep.
// deleteAccount (1.12) 가 구매 줄만 남기는 이유가 전자상거래법상 대금결제 기록
// 5 년 보존이라, 결제 시점 기준 5 년이 지나면 지운다. 탈퇴자만 대상 — 활동 중인
// 사용자의 원장을 지우면 잔액(star_balance = 원장 합계)이 바뀐다.
const PURCHASE_RETENTION_DAYS = 5 * 365 + 2; // 윤년 여유

export async function sweepExpiredPurchaseLedger(): Promise<number> {
  const cutoff = cutoffIso(PURCHASE_RETENTION_DAYS);
  // ponytail: 오래된 구매 줄 1000 개만 후보로 본다. 활동 중 사용자의 5 년 넘은
  // 구매가 1000 개를 넘으면 탈퇴자 줄이 밀려 안 지워질 수 있다 — 그때는
  // DELETE ... USING profiles 조인 RPC 로 옮긴다.
  const { data: rows, error: rowsErr } = await supabase
    .from('star_ledger')
    .select('user_id')
    .eq('kind', 'purchase')
    .lt('created_at', cutoff)
    .limit(1000);
  if (rowsErr) throw new Error(`star_ledger select: ${rowsErr.message}`);
  const candidates = [...new Set((rows ?? []).map((r) => r.user_id as string))];
  if (candidates.length === 0) return 0;

  const { data: deleted, error: profErr } = await supabase
    .from('profiles')
    .select('id')
    .in('id', candidates)
    .not('deleted_at', 'is', null);
  if (profErr) throw new Error(`profiles select: ${profErr.message}`);
  const ids = (deleted ?? []).map((p) => p.id as string);
  if (ids.length === 0) return 0;

  const { count, error: delErr } = await supabase
    .from('star_ledger')
    .delete({ count: 'exact' })
    .in('user_id', ids)
    .lt('created_at', cutoff);
  if (delErr) throw new Error(`star_ledger delete: ${delErr.message}`);
  return count ?? 0;
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
        r.blocksDeleted > 0 ||
        r.deletionStatsDeleted > 0 ||
        r.dauDeleted > 0
      ) {
        console.log(`[audit-cleanup.sweep] ${label}`, r);
      }
    })
    .catch((err) => console.error(`[audit-cleanup.sweep] ${label} error`, err));
  sweepExpiredPurchaseLedger()
    .then((n) => {
      if (n > 0) console.log(`[audit-cleanup.purchase] ${label}`, { deleted: n });
    })
    .catch((err) => console.error(`[audit-cleanup.purchase] ${label} error`, err));
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
