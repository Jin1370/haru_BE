// 푸시 알림 body 사전. 수신자 locale(profiles.language) 기준으로 BE 가 빌드한다.
// FE i18next 와 별개 — BE 는 FE 의 in-app 언어 설정을 모르고, 수신자 profile.language
// 만 권위 있는 신호이기 때문.
//
// 정책:
//   * title 은 항상 "haru" 고정 (브랜드 일관)
//   * body 만 동적. {name} 자리에 sender_name / matched_name 보간.
//   * data 페이로드에 번역본/음성 URL 절대 포함 금지 (보이스 클론 악용 차단)
//   * fallback 은 'en' — th/hi 그 외 모든 locale.

export type PushLocale = 'ko' | 'ja' | 'en';

const SUPPORTED: ReadonlyArray<PushLocale> = ['ko', 'ja', 'en'];

export function resolvePushLocale(language: string | null | undefined): PushLocale {
  if (language && (SUPPORTED as ReadonlyArray<string>).includes(language)) {
    return language as PushLocale;
  }
  return 'en';
}

const PUSH_MESSAGES = {
  message: {
    ko: '{name}님의 새 음성 메시지',
    ja: '{name}さんから新しいボイスメッセージ',
    en: 'New voice message from {name}',
  },
  // 같은 채팅방 알림은 트레이에서 한 줄로 병합되므로(pushNotifications 의
  // tag/collapseId), 2건 이상 쌓였을 때 몇 건인지 알려주지 않으면 이전 알림이
  // 그냥 사라진 것처럼 보인다. 미청취 개수는 채팅 목록 배지(get_match_summaries_v4
  // 의 unread_count)와 같은 정의를 쓴다.
  message_multi: {
    ko: '{name}님의 새 음성 메시지 {count}개',
    ja: '{name}さんから新しいボイスメッセージ{count}件',
    en: '{count} new voice messages from {name}',
  },
  match: {
    ko: '{name}님과 매칭되었어요!',
    ja: '{name}さんとマッチしました！',
    en: 'You matched with {name}!',
  },
  // 좋아요는 익명 — 이름을 넣지 않는다. 트레이에 남는 개인정보 0 + 앱을 열어
  // 확인하게 만드는 동기 유지 (받은 좋아요 탭에서 누구인지 확인).
  like: {
    ko: '새로운 좋아요가 도착했어요',
    ja: '新しいいいねが届きました',
    en: 'You received a new like',
  },
  // 목소리 미등록 리마인더 — 계정당 1회. 카드가 왜 안 보이는지(디스커버 노출
  // 조건 = 보이스 클론 + 한마디)를 알려주는 게 핵심이라 이유를 body 에 넣는다.
  voice_reminder: {
    ko: '목소리 등록하는 것을 깜빡하셨나요? 1분 안에 등록하고 자유롭게 대화해보세요.',
    ja: '声の登録をお忘れではありませんか？1分で登録して、自由に会話してみましょう。',
    en: 'Forgot to record your voice? Set it up in a minute and start talking freely.',
  },
} as const;

export type PushMessageType = keyof typeof PUSH_MESSAGES;

// count 는 메시지 알림의 미청취 건수. 2건 이상일 때만 개수 문구로 바꾼다
// (1건이면 개수를 붙여봐야 노이즈).
export function buildPushBody(
  type: PushMessageType,
  locale: PushLocale,
  name: string,
  count?: number,
): string {
  const key: PushMessageType =
    type === 'message' && count !== undefined && count > 1 ? 'message_multi' : type;
  return PUSH_MESSAGES[key][locale]
    .replace('{name}', name)
    .replace('{count}', String(count ?? ''));
}
