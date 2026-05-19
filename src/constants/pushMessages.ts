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
  match: {
    ko: '{name}님과 매칭되었어요!',
    ja: '{name}さんとマッチしました！',
    en: 'You matched with {name}!',
  },
} as const;

export type PushMessageType = keyof typeof PUSH_MESSAGES;

export function buildPushBody(
  type: PushMessageType,
  locale: PushLocale,
  name: string,
): string {
  const template = PUSH_MESSAGES[type][locale];
  return template.replace('{name}', name);
}
