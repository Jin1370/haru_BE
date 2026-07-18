// audio-expiry sprint
//
// 일일 sweep: 수신자가 청취 완료한 지 30일이 지난 음성 메시지 파일을 Storage
// 에서 삭제하고 audio_url=NULL + audio_purged_at=now() 로 표기. 텍스트/번역
// 컬럼은 절대 건드리지 않는다 — 매치가 살아있는 동안 텍스트는 유지가 정책.
//
// 재생성 (POST /api/matches/:matchId/messages/:messageId/audio) 으로 음성을
// 복원한 메시지는 audio_refreshed_at 가 set 되므로 sweep 이 30일이 더 지난
// 뒤에야 재차 대상에 포함된다 (재생성 직후 즉시 재퍼지 회귀 차단).
//
// 실행 모델: BE process 내부 setInterval (24h). 다중 인스턴스 배포 시에는
// 동일 row 가 여러 워커에 동시 잡힐 수 있으나 UPDATE 의 WHERE 조건 (audio_url
// IS NOT NULL) 이 첫 워커 이후 row 를 자동 배제하므로 idempotent. Storage
// delete 도 동일 path 에 대한 중복 호출은 200 / not-found 로 무해.
//
// NODE_ENV=test 환경에선 등록 자체를 스킵 — vitest 가 idle handle 로 인해
// 종료 못 하는 회귀 차단.

import { supabase } from '../config/supabase';
import { deleteFile, extractPath } from '../services/storage';

// 30일. const 로 분리해 후속 정책 변경 (예: 60일/14일) 시 한 곳만 갱신.
// 환경변수화는 v1 에선 미도입 — 모든 환경 동일 정책 유지가 우선.
const AUDIO_TTL_DAYS = 30;

// 한 번 sweep 사이클에서 처리하는 최대 행 수. 1000명 규모에선 일일 대상이
// 수십~수백 건 수준이라 500 이면 충분. 대량 누적 회귀 시에도 cron 이 다음
// 사이클에 이어 처리.
const SWEEP_BATCH_SIZE = 500;

interface PurgeCandidate {
  id: string;
  audio_url: string;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;
}

// Sweep 한 번 실행. 외부에서 admin script / 테스트가 호출 가능하도록 export.
export async function purgeExpiredAudio(): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - AUDIO_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // eligibility:
  //   1) audio_url IS NOT NULL — 현재 활성 음성을 보유
  //   2) audio_purged_at IS NULL — 이미 퍼지된 row 재처리 회피
  //   3) listened_at < cutoff — 수신자가 청취 완료한 지 30일 이상 경과
  //   4) audio_refreshed_at IS NULL OR < cutoff — 재생성 음성도 30일 경과 후 재퍼지
  //
  // 정렬 / pagination 은 필요 없음 — UPDATE 가 멱등하고 다음 사이클이 이어
  // 처리한다. SELECT 만으로 row id 와 audio_url 을 확보한 뒤, Storage delete
  // 와 UPDATE 를 row 단위로 순차 실행 (Storage 실패 시 audio_url 은 그대로 두고
  // 다음 사이클에서 재시도).
  const { data: rows, error: selectError } = await supabase
    .from('messages')
    .select('id, audio_url, audio_refreshed_at')
    .not('audio_url', 'is', null)
    .is('audio_purged_at', null)
    .not('listened_at', 'is', null)
    .lt('listened_at', cutoff)
    .or(`audio_refreshed_at.is.null,audio_refreshed_at.lt.${cutoff}`)
    .limit(SWEEP_BATCH_SIZE);

  if (selectError) {
    console.error('[purgeExpiredAudio] select error:', selectError.message);
    return { scanned: 0, purged: 0, failed: 0 };
  }

  const candidates = (rows ?? []) as PurgeCandidate[];
  let purged = 0;
  let failed = 0;

  for (const row of candidates) {
    try {
      // Storage delete 먼저 → DB UPDATE. 역순으로 하면 DB 만 갱신되고 객체가
      // 잔존하는 경로가 생기므로 sweep 다음 사이클이 같은 row 를 못 보고 객체
      // orphan 화. delete → UPDATE 순서가 idempotent 측면에서도 안전 (Storage
      // 객체 없음을 재호출하면 그냥 no-op, UPDATE 는 audio_url IS NOT NULL
      // 가드로 중복 실행 안 됨).
      let path: string;
      try {
        path = extractPath('voice-messages', row.audio_url);
      } catch (e) {
        // audio_url 이 정상 public URL 포맷이 아닌 경우 (legacy / corrupted).
        // 파일 정리 못 하지만 row 마킹은 진행 — 그 외 코드 경로에서 잘못된
        // URL 로 재생 실패하는 걸 막기 위함.
        console.warn(`[purgeExpiredAudio] extractPath failed for ${row.id}:`, (e as Error).message);
        const { error: markError } = await supabase
          .from('messages')
          .update({ audio_url: null, audio_purged_at: new Date().toISOString() })
          .eq('id', row.id)
          .not('audio_url', 'is', null);
        if (markError) {
          failed += 1;
          console.error(`[purgeExpiredAudio] mark-only update failed for ${row.id}:`, markError.message);
        } else {
          purged += 1;
        }
        continue;
      }

      await deleteFile('voice-messages', path);

      const { error: updateError } = await supabase
        .from('messages')
        .update({ audio_url: null, audio_purged_at: new Date().toISOString() })
        .eq('id', row.id)
        // audio_url IS NOT NULL 가드 — 동시 sweep 워커 / 재생성 race 보호.
        .not('audio_url', 'is', null);

      if (updateError) {
        failed += 1;
        console.error(`[purgeExpiredAudio] update failed for ${row.id}:`, updateError.message);
        continue;
      }

      purged += 1;
    } catch (e) {
      failed += 1;
      console.error(`[purgeExpiredAudio] unexpected error for ${row.id}:`, (e as Error).message);
    }
  }

  if (candidates.length > 0) {
    console.log(`[purgeExpiredAudio] scanned=${candidates.length} purged=${purged} failed=${failed}`);
  }

  return { scanned: candidates.length, purged, failed };
}

// 부팅 시 등록되는 sweep scheduler. NODE_ENV=test 에선 스킵.
let scheduled: NodeJS.Timeout | null = null;

export function startAudioExpiryScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduled) return;

  // 부팅 직후 1회 (60초 후 — 다른 startup 작업과 충돌 회피) + 이후 24시간 간격.
  const FIRST_DELAY_MS = 60_000;
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  setTimeout(() => {
    purgeExpiredAudio().catch((e) => {
      console.error('[purgeExpiredAudio] startup run failed:', e);
    });
  }, FIRST_DELAY_MS);

  scheduled = setInterval(() => {
    purgeExpiredAudio().catch((e) => {
      console.error('[purgeExpiredAudio] scheduled run failed:', e);
    });
  }, INTERVAL_MS);

  // unref 로 이벤트 루프 alive 신호 제거 — 다른 종료 핸들러 (graceful shutdown)
  // 가 sweep timer 때문에 hang 되지 않도록.
  scheduled.unref?.();
}
