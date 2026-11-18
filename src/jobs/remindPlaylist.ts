// 플레이리스트 알림 sweep.
//
// 플레이리스트는 현지 새벽 5시에 초기화되는데, 그 시각엔 자고 있어 알림을 보내지 않는다.
// 인사가 가장 많은 저녁(prod 20~21시) 직전인 현지 저녁 8시에, 그날 플레이리스트를 아직 안 연
// 사람에게만 한 번 보낸다. 타임존은 목소리 리마인더와 같이 국적에서 파생한다.
//
// 대상: 활성 계정 + 최근 14일 안에 앱을 쓴 사람 (오래 안 쓴 사람에게 매일 보내면 스팸이라 삭제로
// 이어진다) + 오늘 연 플레이리스트 없음. 알림 설정 OFF·토큰 없음은 sendPushToUser 가 거른다.
// 하루 1회 보장은 profiles.playlist_reminder_on (mig 070) — 그날 날짜로 먼저 claim 한 쪽만 보낸다.

import { supabase } from '../config/supabase';
import { sendPushToUser } from '../services/pushNotifications';
import { TZ_OFFSET_MINUTES, nationalitiesAtLocalHour } from './remindVoiceSetup';

const SEND_LOCAL_HOUR = 20;
const ACTIVE_WITHIN_DAYS = 14;
// ponytail: 한 시간대에 1000명 넘게 대상이 되면 나머지는 그날 못 받는다 — 그때 페이지 돌리기.
const BATCH_SIZE = 1000;

export async function remindPlaylist(now = Date.now()): Promise<{ sent: number }> {
  const nationalities = nationalitiesAtLocalHour(now, SEND_LOCAL_HOUR);
  if (nationalities.length === 0) return { sent: 0 };
  // 같은 시각에 20시인 국적은 오프셋이 같아 현지 날짜도 같다.
  const offset = TZ_OFFSET_MINUTES[nationalities[0]];
  const localDate = new Date(now + offset * 60_000).toISOString().slice(0, 10);

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id')
    .in('nationality', nationalities)
    .eq('is_active', true)
    .is('deleted_at', null)
    .or(`playlist_reminder_on.is.null,playlist_reminder_on.lt.${localDate}`)
    .limit(BATCH_SIZE);
  if (error) {
    console.error('[remindPlaylist.profiles]', error.message);
    return { sent: 0 };
  }
  let ids = (profiles ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return { sent: 0 };

  // 최근 14일 안에 앱을 쓴 사람 (daily_active_users, KST 날짜).
  const since = new Date(now + 540 * 60_000 - ACTIVE_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: active, error: activeError } = await supabase
    .from('daily_active_users')
    .select('user_id')
    .in('user_id', ids)
    .gte('day', since);
  if (activeError) {
    console.error('[remindPlaylist.active]', activeError.message);
    return { sent: 0 };
  }
  const activeIds = new Set((active ?? []).map((r: { user_id: string }) => r.user_id));
  ids = ids.filter((id) => activeIds.has(id));
  if (ids.length === 0) return { sent: 0 };

  // 오늘 플레이리스트를 이미 연 사람은 뺀다 (끝나지 않은 플레이리스트가 있음).
  const { data: opened, error: openedError } = await supabase
    .from('discover_playlists')
    .select('user_id')
    .in('user_id', ids)
    .gt('expires_at', new Date(now).toISOString());
  if (openedError) {
    console.error('[remindPlaylist.opened]', openedError.message);
    return { sent: 0 };
  }
  const openedIds = new Set((opened ?? []).map((r: { user_id: string }) => r.user_id));
  ids = ids.filter((id) => !openedIds.has(id));
  if (ids.length === 0) return { sent: 0 };

  // claim 먼저, 발송 나중 — 서버 2대가 같은 tick 에 돌아도 날짜 가드에 걸린 쪽만 돌려받는다.
  const { data: claimed, error: claimError } = await supabase
    .from('profiles')
    .update({ playlist_reminder_on: localDate })
    .in('id', ids)
    .or(`playlist_reminder_on.is.null,playlist_reminder_on.lt.${localDate}`)
    .select('id');
  if (claimError) {
    console.error('[remindPlaylist.claim]', claimError.message);
    return { sent: 0 };
  }

  const targets = ((claimed ?? []) as { id: string }[]).map((r) => r.id);
  await Promise.all(targets.map((id) => sendPushToUser(id, { type: 'playlist' })));
  if (targets.length > 0) console.log('[remindPlaylist.sweep]', { sent: targets.length, nationalities });
  return { sent: targets.length };
}

let scheduler: NodeJS.Timeout | null = null;

export function startPlaylistReminderScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduler) return;
  // 1시간 간격 — 현지 20시대 tick 을 놓치지 않는 최소 주기. 부팅 직후는 다른 sweep 과 어긋나게 180s.
  const run = () => remindPlaylist().catch((e) => console.error('[remindPlaylist.error]', e));
  setTimeout(run, 180 * 1000).unref();
  scheduler = setInterval(run, 60 * 60 * 1000);
  scheduler.unref();
}
