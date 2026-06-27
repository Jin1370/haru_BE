# haru_BE

> **보이스 클론 기반 cross-language 데이팅 앱 — 백엔드**
>
> Express 5 + Supabase + ElevenLabs + Vertex AI Gemini.

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-7c3aed)](https://claude.com/claude-code)
[![Express](https://img.shields.io/badge/Express-5-000)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

이 레포는 백엔드(Express + Supabase) 만 다룹니다. **모바일 클라이언트는 별도 레포** → [`perso-devrel/haru_FE`](https://github.com/perso-devrel/haru_FE)

---

## 앱 소개

> 사진과 텍스트만으론 느낄 수 없던 진짜 첫인상을 '목소리'로 만나보세요.
> 하루(Haru)는 언어가 달라도 마음이 통하는 글로벌 데이팅·소개팅 앱입니다.

### 🎧 목소리로 만나는 첫인상
프로필을 넘기며 상대의 목소리를 직접 들어보세요. 사진만으로는 알 수 없던 분위기, 말투, 진심까지 — 사진과 목소리를 함께 느끼며 더 입체적인 첫인상을 만나는 새로운 데이팅 방식입니다.

### 🎨 부담 없는 아트 프로필
하루는 등록한 사진을 감성적인 그림체로 변환해 보여줍니다. 실사 노출이 부담스러워 망설였다면, 이제 아트 프로필로 편하게 시작하세요. 친구나 낯선 사람에게 알아봐질 걱정도 이제 없어요. 부담을 덜면서도 분위기와 매력은 그대로 전하는, 한결 편안한 시작 방법입니다.

### 🌏 언어 장벽 없는 대화, AI 자동 번역
내가 한국어로 보내면 상대의 언어로, 상대가 보내면 내 언어로 AI가 자동 번역합니다. 외국인 데이팅이 처음이어도 번역기를 따로 켤 필요 없이, 하루 안에서 자연스럽게 채팅하고 언어교환까지 즐기세요.

### 🗣️ 감정까지 담는 음성 메시지
음성 메시지를 보내면 번역된 내용이 '당신의 목소리'로 상대에게 전달됩니다. 기쁨·슬픔 같은 감정을 선택하면 단순한 이모티콘과 달리 목소리 톤에 그 감정이 그대로 실리고, 'ㅋㅋㅋ' 같은 표현도 진짜 웃음소리로 살아나요. 언어가 달라도 감정까지 전해지는 데이팅을 경험해보세요.

### 💛 이런 분께 추천해요
- 일본, 미국 등 다른 나라 사람과 새로운 인연을 만들고 싶으신 분
- 외국인 친구를 사귀거나 언어교환을 하고 싶으신 분
- 좋은 목소리가 이상형이신 분
- 내 목소리로 매력을 어필하고 싶으신 분
- 실사 사진 노출이 부담스러우신 분

지금 하루에서 목소리로 만나는 글로벌 데이팅을 시작해보세요.

### 다운로드

<p align="center">
  <a href="https://apps.apple.com/kr/app/%ED%95%98%EB%A3%A8-%EB%AA%A9%EC%86%8C%EB%A6%AC-%EB%8D%B0%EC%9D%B4%ED%8C%85-%EC%99%B8%EA%B5%AD%EC%9D%B8-%EC%86%8C%EA%B0%9C%ED%8C%85/id6779128759">
    <img alt="Download on the App Store" src="https://img.shields.io/badge/App_Store-1a1a1a?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  &nbsp;
  <a href="https://play.google.com/store/apps/details?id=com.haruvoice.app&hl=ko&gl=KR">
    <img alt="Get it on Google Play" src="https://img.shields.io/badge/Google_Play-1a1a1a?style=for-the-badge&logo=googleplay&logoColor=white">
  </a>
</p>

---

## 핵심 기능

사용자가 본인 언어로 텍스트 메시지를 작성

→ 메시지를 자동으로 상대 언어로 번역

→ 사용자의 목소리를 입혀서 음성으로 전달

이 흐름이 메시지 송신 라우트의 **비동기 파이프라인 6단계**에 그대로 들어 있습니다.

---

## 페르소나: 한국 남성 × 일본 여성

이미 검증된 수요 위에 만듭니다.

- 한남-일녀 결혼 **1,176건 (2024)** — 전년 대비 **+40.2%**, 최근 10년 내 최고치
- 한남-일녀 결혼이 한녀-일남 결혼의 **약 8배** (1,176건 vs 147건)
- 지리·문화적으로 근접 → 실제 만남으로 이어질 수 있는 조건이 갖춰져 있음

1차 출시 한국·일본, 확장 미국·태국·인도 순.

---

## Claude Code 활용

이 백엔드는 [Claude Code](https://claude.com/claude-code) 를 단순 코드 자동완성이 아니라, **6명의 전문 에이전트가 협업하는 개발 하네스**로 구성해서 만들었습니다.

- **역할별 에이전트 팀** — 제품 전략 / 풀스택 아키텍처 / 보이스·i18n 파이프라인 / 모바일 UX / 보안·안전 / QA 정합성 6개 역할을 에이전트로 분리. 신규 기능은 `Think → Plan → Build → Review → Test` 흐름으로 팀이 함께 처리합니다.
- **스킬 기반 진입점** — `/sprint`(기능 단위 통합 개발), `/voice-pipeline`(보이스·번역), `/safety-audit`(보안 감사), `/qa-integration`(BE↔FE 정합성) 등 작업 성격에 맞는 스킬로 워크플로를 호출합니다.
- **안전 게이트 강제** — 데이팅 앱 특성상 모든 변경은 머지 전에 보안·안전 에이전트(`safety-security-reviewer`)를 반드시 통과시켜, RLS·차단/신고·미성년자 차단·보이스 클론 악용 방지·GDPR/PIPA 데이터 삭제권을 점검합니다.
- **의사결정 누적** — 매 sprint 의 변경 내용·근거·트레이드오프를 [`CLAUDE.md`](CLAUDE.md) 변경 이력에 sprint 단위로 누적해, 외부에서 봐도 어떤 흐름으로 만들어졌는지 추적할 수 있습니다.
- **자동 회귀 방어** — 신규 외부 의존성 호출 시 `error` destructure 가시화(silent-success 가드), 마이그레이션 forward-only, `auth.ts:deleteAccount` 동기 cleanup 같은 규칙을 에이전트가 매 작업마다 검증합니다.

> 음성 클론 / TTS는 현재 **ElevenLabs API**, 번역은 **Vertex AI Gemini 2.5 Flash**, 모더레이션은 **OpenAI Moderation** 으로 구성되어 있으며 음성 파이프라인은 추후 **Perso AI API** 로 전환 예정입니다.

---

## 핵심 파이프라인 한눈에

```
POST /api/matches/:id/messages   ───┐
   ▼                                │
[즉시 INSERT + 202 stub 응답]        │  ◀── 송신자 클론 있으면 비동기 분기
                                    │
        ┌───────────────────────────┘
        ▼
  1) prepareTextForTTS()       ㅋㅋㅋ → [laughs] (5개 언어 슬랭 + 이모티콘)
  2) 모더레이션 사전 + OpenAI    노골 표현 즉시 차단
  3) translateMessage()        Gemini 2.5 Flash, audio tag 보존
  4) synthesizeSpeech()        ElevenLabs eleven_v3, 송신자 voice_id
  5) Storage 업로드             voice-messages 버킷
  6) DB UPDATE + Realtime 푸시  audio_status: processing → ready
        ▼
[수신자 채팅창: 번역문 + 송신자 목소리 재생 버튼]
```

수신자 측에서는 **음성을 1회 청취해야 텍스트가 공개**됩니다 (`messages.listened_at` + `POST /api/matches/:matchId/messages/:messageId/listened` + 채팅 목록 미리보기에서도 미청취 시 "새 메시지" 마스킹).

---

## 기술 스택

| 영역 | 스택 | 비고 |
|---|---|---|
| 런타임 | Express 5 + TypeScript 6 | `tsx watch` 로 핫리로드 |
| DB / Auth / Storage / Realtime | Supabase (`@supabase/supabase-js` 2.103+) | service_role 로 RLS 우회, 서버 전용 |
| 음성 클론 / TTS | ElevenLabs (`eleven_v3`, `stability=1.0`) — 추후 Perso AI 전환 예정 | inline audio tag (`[laughs]`/`[sad]`) |
| 번역 | Vertex AI Gemini 2.5 Flash | `temperature=0.3`, `BLOCK_ONLY_HIGH` |
| 모더레이션 2차 | OpenAI `omni-moderation-latest` | 사전 통과분만 호출, fail-open |
| 푸시 | Expo Push API | `device_tokens` + locale 본문 + DeviceNotRegistered cleanup |
| 입력 검증 | zod 4 | `schemas/` + `validateBody`/`validateQuery` 미들웨어 |
| 테스트 | vitest 4 + supertest 7 | 20+ suite, 290+ cases |

---

## 시작하기

```bash
# 1) BE — 이 레포
git clone https://github.com/perso-devrel/haru_BE
cd haru_BE
npm install
cp .env.example .env       # 값 채우기 (아래 환경 변수 섹션)

# 2) Supabase 마이그레이션 — 002~025 를 Dashboard SQL Editor 에서 순서대로 실행
#    Storage 버킷 3개 수동 생성: photos, voice-messages, voice-intro-audio

# 3) 개발 서버
npm run dev                # http://localhost:3000  (Swagger: /docs)

# 4) FE 클론 + 띄우기 (별도 레포)
git clone https://github.com/perso-devrel/haru_FE
cd ../haru_FE
npm install --legacy-peer-deps
cp .env.example .env       # 값 채우기 (FE 레포 README 참고)
npm run start
```

---

## 환경 변수

```dotenv
PORT=3000
NODE_ENV=development

# Supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role>        # 서버 전용, FE에 절대 노출 ❌
SUPABASE_ANON_KEY=<anon>
SUPABASE_JWT_SECRET=<jwt_secret>

# Google OAuth — Web/iOS/Android 3개 클라이언트 ID
GOOGLE_WEB_CLIENT_ID=...
GOOGLE_IOS_CLIENT_ID=...
GOOGLE_ANDROID_CLIENT_ID=...

# ElevenLabs
ELEVENLABS_API_KEY=...

# Vertex AI (Gemini 번역)
GOOGLE_APPLICATION_CREDENTIALS=credentials/gcp.json
GCP_PROJECT_ID=...
GCP_LOCATION=us-central1

# OpenAI Moderation
OPENAI_API_KEY=...

# 운영 정책
AUTO_FREEZE_REPORT_THRESHOLD=3                  # 신고 누적 자동 freeze 임계치
```

---

## 디렉터리 구조

```
src/
├── routes/                  # /api/* 라우트
│   ├── auth.ts              # Google OAuth, 토큰 갱신, 계정 삭제
│   ├── profile.ts           # 프로필 CRUD, 사진 업로드
│   ├── voice.ts             # ElevenLabs voice clone 관리
│   ├── discover.ts → swipe.ts  # 추천 후보 + 스와이프 + 받은 좋아요 + quota
│   ├── match.ts             # 매치 목록 + 메시지 + 파트너 상세 + 언매치
│   ├── message.ts           # 메시지 송신 (즉시 + 비동기 파이프라인)
│   ├── block.ts             # 차단 (양방향 가시성 차단)
│   ├── report.ts            # 신고 → 누적 시 자동 freeze
│   ├── notifications.ts     # 푸시 토큰 등록 + 선호 토글
│   └── preference.ts        # 매칭 선호도 (나이/성별/언어/국가)
│
├── services/                # 외부 의존성 통합
│   ├── elevenlabs.ts        # voice clone 생성 + eleven_v3 TTS
│   ├── translation.ts       # Vertex AI Gemini 호출 + register-preserving 프롬프트
│   ├── voiceIntro.ts        # 보이스 인트로 다국어 슬롯 합성 (ko/ja/en)
│   ├── pushNotifications.ts # Expo Push API + 차단/freeze/옵트아웃 가드
│   ├── openaiModeration.ts  # OpenAI moderation 2차 layer
│   └── storage.ts           # Supabase Storage 업로드 유틸 (UUID 파일명)
│
├── schemas/                 # zod 입력 스키마
├── middleware/              # auth, validate, error, freezeGuard
├── constants/               # bioPhrasesCatalog, moderationDictionary
├── utils/                   # textNormalization (audio tag 치환), errors
├── jobs/                    # purgeExpiredAudio (30일 TTL sweep, in-process 24h interval)
└── index.ts                 # Express app + swagger + scheduler 부팅

supabase/migrations/         # 025개 forward-only 마이그
tests/                       # vitest 20+ suite
scripts/                     # seed-dev-accounts, cleanup-dev-accounts 등
```

---

## 라우트 요약

| 경로 | 설명 |
|---|---|
| `/api/auth` | Google OAuth `signInWithIdToken`, refresh, 계정 삭제 (anonymize + 동기 cleanup) |
| `/api/profile` | 프로필 CRUD, 사진 업로드 (JPEG/PNG/WebP, UUID 파일명) |
| `/api/voice` | ElevenLabs voice clone 등록 (재녹음 시 옛 voice 자동 cleanup) |
| `/api/discover` | 4-단계 티어 추천 + 일일 50장 한도 + 받은 좋아요 + reciprocity boost |
| `/api/matches` | 매치 목록 (RPC `get_match_summaries_v4`), 파트너 상세, 메시지 CRUD, 청취 / 언매치 |
| `/api/block`, `/api/report` | 차단 + 신고 누적 자동 freeze |
| `/api/notifications` | Expo Push 토큰 register/unregister + 선호 GET/PATCH |
| `/api/preferences` | 매칭 선호도 (나이/성별/언어/국가) |
| `/docs` | Swagger UI |

---

## 주요 컨벤션 (요약)

전체는 [`CLAUDE.md`](CLAUDE.md) 에 있어요. 자주 부딪히는 것만:

- 모든 인증 필요 라우트는 `authMiddleware` 를 `router.use()` 로 적용
- 입력 검증: zod 스키마 + `validateBody`/`validateQuery` 미들웨어
- 에러 처리: `AppError` 클래스 + `errorMiddleware` 에서 `instanceof` 판별
- 매치 ID 는 `user1_id < user2_id` 정렬 보장 (DB UNIQUE 제약)
- 매치 삭제는 soft delete (`unmatched_at`, `unmatched_by`)
- 비동기 처리 (메시지 TTS, voice intro 합성): fire-and-forget + `.catch()` 로깅
- 신규 user-linked 테이블 추가 시 **`auth.ts:deleteAccount` 에 동기 cleanup 추가 필수** (GDPR/PIPA 데이터 삭제권)
- 마이그레이션은 **forward-only**, 파일명은 `NNN_<name>.sql` 패턴만

---

## 데이터 보호 정책

| 자산 | 정책 |
|---|---|
| 음성 학습 원본 (`voice-samples`) | ElevenLabs 클론 생성 직후 즉시 폐기 — 버킷 자체 제거됨 (mig 023) |
| 합성된 음성 메시지 (`voice-messages`) | 청취 후 30일 자동 폐기 (in-process scheduler), 재청취 시 재합성 (mig 025) |
| ElevenLabs voice_id | 계정 탈퇴 시 ElevenLabs API 삭제 호출 (`auth.ts:deleteAccount` cleanup task) |
| 차단된 사용자 메시지 | 양방향 가시성 차단 (수신자 GET 필터 + Realtime 필터) |
| 모더레이션 audit | `moderation_blocks` 90일 보존, service_role 전용 RLS |

---

## 테스트

```bash
npm test                                      # 전체 vitest
npx vitest run tests/message.test.ts          # 단일 파일
```

`tests/setup.ts` 에서 env / Supabase / ElevenLabs / Storage / Gemini 를 전역 모킹.
`tests/helpers.ts` 의 `generateTestToken(userId?)` + `createMockSupabaseQuery()` 로 빠르게 작성.

신규 외부 의존성 호출은 **`error` destructure + 가시화 룰** — silent-success 회귀 차단.

---

## 함께 보는 레포

- **FE (Expo + React Native)** → [`perso-devrel/haru_FE`](https://github.com/perso-devrel/haru_FE)

추가로:
- [`CLAUDE.md`](CLAUDE.md) — 전체 컨벤션 + 메시지 파이프라인 상세 + sprint 회고
- Swagger UI — `npm run dev` 후 `http://localhost:3000/docs`

---

## 라이선스

MIT. 음성 클론 / 번역 / 실시간 채팅을 결합한 백엔드가 어떻게 구성될 수 있는지에 대한 레퍼런스로 자유롭게 참고하세요.
