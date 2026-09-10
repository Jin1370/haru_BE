// chat-photos sprint
//
// 일일 sweep: 전송 후 30일이 지난 채팅 사진을 Storage 에서 삭제하고
// photo_path=NULL + photo_purged_at=now() 로 표기. 텍스트(폴백 캡션)/번역
// 컬럼은 건드리지 않는다 — 음성 sweep 과 같은 원칙.
//
// 음성과 다른 점 둘:
//   1) 기준이 **전송 시각** 이다. 음성은 listened_at 이 있어서 "청취/발송 중
//      마지막 활동" 을 쓸 수 있지만, 사진엔 열람 추적 컬럼이 없다. 만들려면
//      "언제를 봤다고 할 것인가"부터 정하고 write 경로를 새로 깔아야 해서
//      전송 기준으로 단순화했다 (사용자 결정 2026-09-10).
//   2) **복구가 안 된다.** 음성은 재합성 라우트가 있지만 사진은 원본이
//      사라지면 끝이다. FE 는 photo_purged_at 이 set 된 메시지를 "만료된
//      사진" 플레이스홀더로 렌더한다.
//
// 매치 상태(언매치/차단/숨김)와 무관하게 돈다. 탈퇴해도 지우지 않는다 —
// voice-messages 를 탈퇴 정리에서 의도적으로 제외한 것과 같은 이유
// (`auth.ts:453` 주석): 상대는 이미 받았고, 부적절한 사진을 보내고 바로
// 탈퇴하면 증거가 사라지는 갭도 막는다.

import { supabase } from '../config/supabase';
import { deleteFile } from '../services/storage';

const PHOTO_TTL_DAYS = 30;
const SWEEP_BATCH_SIZE = 500;

interface PurgeCandidate {
  id: string;
  photo_path: string;
}

export interface PhotoPurgeResult {
  scanned: number;
  purged: number;
  failed: number;
}

export async function purgeExpiredPhotos(): Promise<PhotoPurgeResult> {
  const cutoff = new Date(Date.now() - PHOTO_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error: selectError } = await supabase
    .from('messages')
    .select('id, photo_path')
    .not('photo_path', 'is', null)
    .is('photo_purged_at', null)
    .lt('created_at', cutoff)
    .limit(SWEEP_BATCH_SIZE);

  if (selectError) {
    console.error('[purgeExpiredPhotos] select error:', selectError.message);
    return { scanned: 0, purged: 0, failed: 0 };
  }

  const candidates = (rows ?? []) as PurgeCandidate[];
  let purged = 0;
  let failed = 0;

  for (const row of candidates) {
    try {
      // Storage delete 먼저 → DB UPDATE. 역순이면 DB 만 갱신되고 객체가 잔존해
      // 다음 사이클이 그 row 를 못 보고 orphan 이 된다 (음성 sweep 과 동일).
      // DB 에 URL 이 아니라 경로가 들어 있어 음성 쪽의 extractPath 분기가 없다.
      await deleteFile('chat-photos', row.photo_path);

      const { error: updateError } = await supabase
        .from('messages')
        .update({ photo_path: null, photo_purged_at: new Date().toISOString() })
        .eq('id', row.id)
        // 동시 sweep 워커 보호 — 첫 워커 이후 row 는 자동 배제.
        .not('photo_path', 'is', null);

      if (updateError) {
        failed += 1;
        console.error(`[purgeExpiredPhotos] update failed for ${row.id}:`, updateError.message);
        continue;
      }
      purged += 1;
    } catch (e) {
      failed += 1;
      console.error(`[purgeExpiredPhotos] unexpected error for ${row.id}:`, (e as Error).message);
    }
  }

  if (candidates.length > 0) {
    console.log(`[purgeExpiredPhotos] scanned=${candidates.length} purged=${purged} failed=${failed}`);
  }

  return { scanned: candidates.length, purged, failed };
}

let scheduled: NodeJS.Timeout | null = null;

export function startPhotoExpiryScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduled) return;

  // 음성 sweep(60초)과 겹치지 않게 90초 후 첫 실행.
  const FIRST_DELAY_MS = 90_000;
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  setTimeout(() => {
    purgeExpiredPhotos().catch((e) => {
      console.error('[purgeExpiredPhotos] startup run failed:', e);
    });
  }, FIRST_DELAY_MS);

  scheduled = setInterval(() => {
    purgeExpiredPhotos().catch((e) => {
      console.error('[purgeExpiredPhotos] scheduled run failed:', e);
    });
  }, INTERVAL_MS);

  scheduled.unref?.();
}
