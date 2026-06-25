import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { buildPushBody, resolvePushLocale, type PushMessageType } from '../constants/pushMessages';

// 페이로드 — data 영역에는 type + match_id + sender_id 만. 번역 본문/음성 URL
// 절대 포함 금지 (보이스 클론 악용 정황 차단 + 차단된 사용자 잔존 알림 데이터
// 노출 방지). FE 가 알림 탭 시 deep link 로 채팅방/매치 화면 진입한 뒤 정상 API
// 흐름으로 본문을 가져온다.
export type PushPayload =
  | {
      type: 'message';
      match_id: string;
      sender_id: string;
      sender_name: string;
    }
  | {
      type: 'match';
      match_id: string;
      matched_user_id: string;
      matched_name: string;
    };

interface DeviceTokenRow {
  expo_push_token: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket[];
  errors?: unknown;
}

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

// 핵심 송신 헬퍼.
//   1. 차단 양방향 → silent skip
//   2. 옵트아웃 (notify_messages / notify_matches) → silent skip
//   3. device_tokens 0개 → silent skip
//   4. 수신자 locale 기반 body 빌드 → Expo Push API 호출 (배치)
//   5. DeviceNotRegistered 응답이면 해당 토큰 DB 정리
//
// 항상 try/catch 로 wrap — 호출자(message/swipe 라우트)의 응답을 절대 막지
// 않는다. 호출 시 `.catch(...)` 로 fire-and-forget.
export async function sendPushToUser(
  receiverId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    const counterpartyId =
      payload.type === 'message' ? payload.sender_id : payload.matched_user_id;

    // 1) 차단 양방향 검증 — message.ts 의 OR 패턴과 동일
    const { data: blocks } = await supabase
      .from('blocks')
      .select('id')
      .or(
        `and(blocker_id.eq.${receiverId},blocked_id.eq.${counterpartyId}),and(blocker_id.eq.${counterpartyId},blocked_id.eq.${receiverId})`,
      )
      .limit(1);

    if (blocks && blocks.length > 0) {
      return;
    }

    // 1.5) 송신자/매칭 상대방 freeze 검증 — auth.ts 의 deleteAccount 는 auth.users
    // 를 anonymize 만 하므로 is_active=false / deleted_at 으로 비활성 상태를
    // 판별한다. 탈퇴 후 옛 매치에서 흘러온 메시지·매치 푸시가 트레이에 잔존하지
    // 않게 차단. admin freeze 케이스도 동일 분기로 처리.
    const { data: counterpartyProfile } = await supabase
      .from('profiles')
      .select('is_active, deleted_at')
      .eq('id', counterpartyId)
      .maybeSingle();
    if (
      !counterpartyProfile ||
      counterpartyProfile.is_active === false ||
      counterpartyProfile.deleted_at
    ) {
      return;
    }

    // 2) 옵트아웃 검증 — user_preferences 행이 없으면 default true (전송)
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('notify_messages, notify_matches')
      .eq('user_id', receiverId)
      .maybeSingle();

    if (prefs) {
      if (payload.type === 'message' && prefs.notify_messages === false) {
        return;
      }
      if (payload.type === 'match' && prefs.notify_matches === false) {
        return;
      }
    }

    // 2.5) per-match 옵트아웃 (mig 022). 채팅 목록 long-press 액션시트의
    // "알림 끄기" 토글. type='match' 는 매치 형성 시점이라 그 전에 mute 가
    // 존재할 수 없으므로 type='message' 에만 적용. mig 미적용 윈도우에서
    // PostgREST 가 404 를 주면 data=null + error 만 set 되어 silent skip
    // 처리 (회귀 없이 기존 동작 유지).
    if (payload.type === 'message') {
      const { data: mute } = await supabase
        .from('match_mutes')
        .select('match_id')
        .eq('match_id', payload.match_id)
        .eq('user_id', receiverId)
        .maybeSingle();
      if (mute) {
        return;
      }
    }

    // 3) 토큰 조회 — 다기기 허용 (배열). 실유저 일반 토큰은 label 없음.
    const { data: tokens } = await supabase
      .from('device_tokens')
      .select('expo_push_token')
      .eq('user_id', receiverId);

    const tokenList: { expo_push_token: string; label: string | null }[] = (
      (tokens as DeviceTokenRow[] | null) ?? []
    ).map((t) => ({ expo_push_token: t.expo_push_token, label: null }));

    // 3.5) dev/QA 알림 싱크 (mig 040) — 한 테스터 폰으로 여러 dev seed 계정의
    // 푸시를 모아 받기 위한 매핑. 실유저 push 경로(device_tokens)와 분리된 dev
    // 전용 테이블이며 ADMIN_DASHBOARD_ENABLED 일 때만 조회한다 (출시 빌드에서는
    // 쿼리 자체가 실행되지 않아 prod 푸시 경로 무영향). label 은 수신 계정 표시명
    // — 한 폰에 여러 계정 알림이 섞여도 어느 계정 알림인지 제목으로 구분.
    if (env.admin.dashboardEnabled) {
      const { data: sinks, error: sinkError } = await supabase
        .from('dev_notification_sinks')
        .select('expo_push_token, label')
        .eq('dev_user_id', receiverId);
      if (sinkError) {
        console.error('[sendPushToUser] dev sink select error:', sinkError.message);
      } else if (sinks) {
        for (const s of sinks as { expo_push_token: string; label: string | null }[]) {
          tokenList.push({ expo_push_token: s.expo_push_token, label: s.label });
        }
      }
    }

    // 같은 토큰이 device_tokens 와 sink 양쪽에 잡히면 1회만 발송 — label 있는 쪽을
    // 우선해 수신 계정명을 보여준다.
    const byToken = new Map<string, string | null>();
    for (const t of tokenList) {
      const existing = byToken.get(t.expo_push_token);
      if (existing === undefined || (existing === null && t.label !== null)) {
        byToken.set(t.expo_push_token, t.label);
      }
    }
    const dedupedTokens = [...byToken.entries()].map(([expo_push_token, label]) => ({
      expo_push_token,
      label,
    }));

    if (dedupedTokens.length === 0) {
      return;
    }

    // 4) locale 기반 body 빌드
    const { data: receiverProfile } = await supabase
      .from('profiles')
      .select('language')
      .eq('id', receiverId)
      .maybeSingle();

    const locale = resolvePushLocale(
      (receiverProfile?.language as string | null | undefined) ?? null,
    );

    const name =
      payload.type === 'message' ? payload.sender_name : payload.matched_name;
    const body = buildPushBody(payload.type as PushMessageType, locale, name);
    // dev 알림 싱크(label 있는 토큰)는 테스터 폰 1대 전용이라 수신 dev 계정의
    // 언어(ja 등)와 무관하게 한국어로 고정 — 테스터 가독성. 실유저 토큰(label
    // null)은 위 수신자 언어 body 그대로.
    const sinkBody = buildPushBody(payload.type as PushMessageType, 'ko', name);

    const data: Record<string, string> = { type: payload.type, match_id: payload.match_id };
    if (payload.type === 'message') {
      data.sender_id = payload.sender_id;
    }

    // priority: 'high' — FCM 측에서 즉시 wakeup + Android Notification Channel
    // 의 IMPORTANCE_HIGH 와 결합해 화면 상단 헤드업/플로팅 배너로 노출시킨다.
    // 'default' 면 doze/대기 상태에서 지연 + 헤드업 미노출. APNs 는 무관.
    const messages = dedupedTokens.map((t) => ({
      to: t.expo_push_token,
      sound: 'default' as const,
      // label 있는 토큰(dev 알림 싱크)은 "haru · <수신계정명>" 으로 어느 계정
      // 알림인지 구분. 실유저 토큰(label null)은 기존대로 'haru'.
      title: t.label ? `haru · ${t.label}` : 'haru',
      body: t.label ? sinkBody : body,
      data,
      channelId: 'default',
      priority: 'high' as const,
    }));

    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'gzip,deflate',
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      console.error(
        `[sendPushToUser] Expo Push API HTTP ${response.status}`,
      );
      return;
    }

    const result = (await response.json()) as ExpoPushResponse;
    const tickets = result.data ?? [];

    // 5) DeviceNotRegistered 토큰 정리.
    // 에러 로그에 expo_push_token 평문을 절대 출력하지 않는다 (token redirect
    // 공격 위협 모델 — token 이 BE 로그에 남으면 노출 시 해당 단말 푸시를
    // 공격자가 자기 계정으로 transfer 할 수 있음). ticket 객체 대신 status/
    // details.error 만 마스킹된 토큰 prefix 와 함께 로그.
    const invalidTokens: string[] = [];
    tickets.forEach((ticket, idx) => {
      const t = dedupedTokens[idx];
      const maskedToken = t ? `${t.expo_push_token.slice(0, 24)}...` : '?';
      if (
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered'
      ) {
        if (t) invalidTokens.push(t.expo_push_token);
      } else if (ticket.status === 'error') {
        console.error(
          `[sendPushToUser] Expo ticket error token=${maskedToken} details=${ticket.details?.error ?? 'unknown'}`,
        );
      }
    });

    if (invalidTokens.length > 0) {
      await supabase
        .from('device_tokens')
        .delete()
        .in('expo_push_token', invalidTokens);
      // dev 알림 싱크에도 같은 죽은 토큰이 복제돼 있으면 함께 정리.
      if (env.admin.dashboardEnabled) {
        await supabase
          .from('dev_notification_sinks')
          .delete()
          .in('expo_push_token', invalidTokens);
      }
    }
  } catch (error) {
    console.error('[sendPushToUser] unhandled error:', error);
  }
}
