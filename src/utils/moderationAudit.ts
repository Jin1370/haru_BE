import { supabase } from '../config/supabase';

// moderation_blocks 차단 이벤트 audit 헬퍼.
//
// 사용 위치 (현재 4 곳):
//   * routes/message.ts — dictionary / openai layer 메시지 차단
//   * routes/profile.ts — dictionary / openai layer voice intro 차단
//
// 응답 정책 (호출자 측 일관 유지):
//   * 422 + { error, code: 'message_blocked' } — FE 핸들러는 i18n 토스트 키
//     `moderation.blocked.toast` 를 surface 무관하게 재사용.
//   * 카테고리 / 매칭 토큰은 응답 body 에 절대 노출 ❌ (우회 패턴 학습 차단).
//
// 본 helper 는 audit log 와 INSERT 만 담당. 422 응답 분기는 호출처 그대로.
// INSERT 실패는 응답 흐름을 막지 않음 (fire-and-forget) — 운영 모니터링만 위해
// console.error 로 가시화. 사전/openai 어느 layer 든 차단 효과 자체는 호출처에서
// 이미 결정된 시점이므로 audit 누락이 차단 자체를 무효화하지 않는다.

export interface ModerationBlockEvent {
  senderId: string;
  category: string;
  language: string;
  layer: 'dictionary' | 'openai';
  surface: 'message' | 'voice_intro';
  // openai layer 만 채움 — `omni-moderation-latest` 의 매핑 전 raw 카테고리.
  // 사전 layer 는 카테고리가 그대로 raw 이므로 생략.
  rawCategory?: string;
}

export function logModerationBlock(event: ModerationBlockEvent): void {
  console.warn('[moderation.block]', {
    sender_id: event.senderId,
    category: event.category,
    raw_category: event.rawCategory,
    language: event.language,
    layer: event.layer,
    surface: event.surface,
    at: new Date().toISOString(),
  });
  void supabase
    .from('moderation_blocks')
    .insert({
      sender_id: event.senderId,
      category: event.category,
      language: event.language,
      surface: event.surface,
    })
    .then(({ error }) => {
      if (error) {
        console.error('[moderation.block.audit_insert_failed]', error.message);
      }
    });
}
