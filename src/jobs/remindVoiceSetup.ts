// 목소리 미등록 리마인더 sweep.
//
// 프로필은 만들어놓고 voice clone 을 등록 안 한 사용자는 디스커버에 아예 노출되지
// 않는다 (swipe.ts 의 visible 필터 — 보이스 한마디 슬롯 URL 부재 = 제외). 본인은
// "왜 아무 반응도 없지" 로만 체감하므로, 가입 하루 뒤 한 번 찔러준다.
//
// 발송 시각: 가입 1시간 경과 후 "가장 가까운 현지 저녁 9시". 그 시간대엔 대개
// 집이라 조용한 녹음 환경이 나온다 (지하철에서 미루고 잊은 케이스가 원래 표적).
// 타임존은 profiles.nationality 에서 파생 — 정확한 tz 는 저장하지 않는다.
//
// 계정당 1회. profiles.voice_reminder_sent_at (mig 050) 이 마킹이자 claim.
// 재발송/에스컬레이션은 안 한다 — 안 하겠다는 사람에게 두 번 이상은 스팸.

import { supabase } from '../config/supabase';
import { sendPushToUser } from '../services/pushNotifications';

const REMIND_AFTER_MS = 60 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500;
const SEND_LOCAL_HOUR = 21;

// 국적 → UTC offset(분). 표준시 기준이라 DST 시행국(US/GB/CA/AU)은 여름에 1시간
// 어긋난다 (오후 8시 or 10시 발송) — 리마인더 1건에 tz 컬럼을 새로 파느니 감수.
// ponytail: 국적 화이트리스트(schemas/profile.ts NATIONALITY_CODES)에 나라를
// 추가하면 여기도 추가할 것. 없는 국적은 리마인더 대상에서 조용히 빠진다.
const TZ_OFFSET_MINUTES: Record<string, number> = {
  KR: 540,
  JP: 540,
  AU: 600,
  PH: 480,
  SG: 480,
  TH: 420,
  IN: 330,
  GB: 0,
  CA: -300,
  US: -360,
};

// 지금 현지 시각이 저녁 9시대인 국적 목록. sweep 이 1시간 간격이라 각 국적은
// 하루에 정확히 한 tick 만 여기에 걸린다.
export function nationalitiesAtSendHour(now: number): string[] {
  return Object.entries(TZ_OFFSET_MINUTES)
    .filter(([, offset]) => new Date(now + offset * 60_000).getUTCHours() === SEND_LOCAL_HOUR)
    .map(([code]) => code);
}

export async function remindVoiceSetup(): Promise<{ sent: number }> {
  const targetNationalities = nationalitiesAtSendHour(Date.now());
  if (targetNationalities.length === 0) return { sent: 0 };

  const cutoff = new Date(Date.now() - REMIND_AFTER_MS).toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .is('elevenlabs_voice_id', null)
    .is('voice_reminder_sent_at', null)
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('nationality', targetNationalities)
    .lt('created_at', cutoff)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[remindVoiceSetup.select]', error.message);
    return { sent: 0 };
  }

  const ids = (data ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return { sent: 0 };

  // 푸시 토큰이 없는 사용자는 건너뛴다 — 1회뿐인 리마인더를 허공에 태우지 않기
  // 위해서. 나중에 알림 권한을 켜면 그때 잡힌다.
  const { data: tokens, error: tokenError } = await supabase
    .from('device_tokens')
    .select('user_id')
    .in('user_id', ids);

  if (tokenError) {
    console.error('[remindVoiceSetup.tokens]', tokenError.message);
    return { sent: 0 };
  }

  const withTokens = [...new Set((tokens ?? []).map((t: { user_id: string }) => t.user_id))];
  if (withTokens.length === 0) return { sent: 0 };

  // claim 먼저, 발송 나중. 멀티 인스턴스(Fly 2대)가 같은 배치를 동시에 집어도
  // voice_reminder_sent_at IS NULL 가드에 걸린 쪽만 RETURNING 되어 중복 푸시가 없다.
  const { data: claimed, error: claimError } = await supabase
    .from('profiles')
    .update({ voice_reminder_sent_at: new Date().toISOString() })
    .in('id', withTokens)
    .is('voice_reminder_sent_at', null)
    .select('id');

  if (claimError) {
    console.error('[remindVoiceSetup.claim]', claimError.message);
    return { sent: 0 };
  }

  const targets = ((claimed ?? []) as { id: string }[]).map((r) => r.id);
  await Promise.all(targets.map((id) => sendPushToUser(id, { type: 'voice_reminder' })));

  if (targets.length > 0) {
    console.log('[remindVoiceSetup.sweep]', { sent: targets.length });
  }
  return { sent: targets.length };
}

let scheduler: NodeJS.Timeout | null = null;

export function startVoiceReminderScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (scheduler) return;

  // 부팅 직후 1회 — audio-expiry(60s) / audit-cleanup(90s) / photo-retry(120s) 와
  // 어긋나게 150s. 이후 1시간 간격 (현지 21시 window 를 놓치지 않는 최소 주기).
  const bootTimer = setTimeout(() => {
    remindVoiceSetup().catch((e) => console.error('[remindVoiceSetup.boot_error]', e));
  }, 150 * 1000);
  bootTimer.unref();

  scheduler = setInterval(() => {
    remindVoiceSetup().catch((e) => console.error('[remindVoiceSetup.tick_error]', e));
  }, INTERVAL_MS);
  scheduler.unref();
}
