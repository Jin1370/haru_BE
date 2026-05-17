// message-moderation-v1 follow-up (B 안, 2026-05-18) — OpenAI Moderation 2차 검수.
//
// 사전 차단 layer (constants/moderationDictionary.ts) 통과 메시지를 OpenAI
// omni-moderation-latest 로 보내 우회 패턴 + 그루밍 + 스캠 + 1인칭 위기 신호를 잡는다.
//
// 차단 카테고리 정책 (사용자 결정 2026-05-18 — 사전 4종과 동일):
//   - sexual                   ↔ 사전 sexual
//   - sexual/minors            ↔ 사전 minor
//   - illicit                  ↔ 사전 drug (omni 전용 카테고리)
//   - self-harm/instructions   ↔ 사전 self_harm (타인 대상 명령형)
//
// 의도적으로 제외 (1차 출시 false positive 회피):
//   - harassment / harassment-threatening
//   - hate / hate-threatening
//   - violence / violence-graphic
//   → 출시 후 운영 데이터 보고 후속 sprint 에서 추가 결정
//
// 1인칭 위기 신호 (self-harm 카테고리, /intent 또는 /instructions 아닌 일반)
//   → 차단 X. 후속 카드 (helpline 안내 분기) 분리.
//
// fail-open 정책: OpenAI 다운 / 키 미설정 / 네트워크 에러 시 통과.
// 사전 차단 layer 가 1차 방어선 — OpenAI 장애로 채팅 전체 마비되는 회귀 회피.
// 운영 모니터링은 콘솔 로그로 가시화.

import OpenAI from 'openai';
import { env } from '../config/env';
import type { ModerationCategory } from '../constants/moderationDictionary';

// 사전 차단의 ModerationCategory 와 같은 shape 유지 — moderation_blocks audit
// 테이블 + 422 응답이 두 layer 모두 동일 흐름.
export interface OpenAiModerationResult {
  blocked: boolean;
  category?: ModerationCategory;
  /** 디버깅 / 운영 로그용 — 실제 OpenAI 가 트리거한 raw 카테고리명 (응답엔 미노출). */
  rawCategory?: string;
}

const PASS: OpenAiModerationResult = { blocked: false };

// SDK 클라이언트는 module top-level lazy init — env 미설정 시 null.
// 매 호출마다 새 인스턴스 생성 회피 (rate limit 관점 안전).
let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (client) return client;
  if (!env.openai.moderationApiKey) return null;
  client = new OpenAI({ apiKey: env.openai.moderationApiKey });
  return client;
}

// OpenAI 카테고리 → 우리 카테고리 매핑. 우선순위 순서 (먼저 매칭된 카테고리로 응답).
// omni-moderation-latest 의 categories key 명세에 정확히 일치.
const CATEGORY_MAP: Array<[string, ModerationCategory]> = [
  ['sexual/minors', 'minor'],
  ['self-harm/instructions', 'self_harm'],
  ['illicit', 'drug'],
  ['illicit/violent', 'drug'],
  ['sexual', 'sexual'],
];

export async function checkOpenAiModeration(text: string): Promise<OpenAiModerationResult> {
  const c = getClient();
  if (!c) return PASS; // 키 미설정 → fail-open

  try {
    const res = await c.moderations.create({
      model: 'omni-moderation-latest',
      input: text,
    });
    const result = res.results?.[0];
    if (!result?.categories) return PASS;

    // 응답의 categories 객체 — key: OpenAI 카테고리명, value: boolean (true=위반).
    // SDK 의 Categories 타입은 명시 key 만 노출하지만 omni-moderation 의 illicit /
    // illicit/violent 등은 별칭 키라 unknown 경유 cast.
    const cats = result.categories as unknown as Record<string, boolean>;

    for (const [openaiKey, ourCategory] of CATEGORY_MAP) {
      if (cats[openaiKey] === true) {
        return { blocked: true, category: ourCategory, rawCategory: openaiKey };
      }
    }

    return PASS;
  } catch (err) {
    // fail-open: 네트워크/rate limit/응답 오류 시 통과. 사전 차단 layer 가 1차 방어선.
    // 운영 모니터링 위해 콘솔 로그만. text 원문은 절대 미노출 (PII 차단).
    console.error('[openaiModeration.error]', {
      message: (err as Error).message,
      text_length: text.length,
    });
    return PASS;
  }
}
