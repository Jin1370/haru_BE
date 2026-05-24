# haru 플레이스토어 출시 체크리스트

본 문서는 Google Play (Android) 첫 출시 시 사용자 / 운영 / 법무 측에서
직접 처리해야 하는 항목 모음입니다. 코드/마이그 정합성은 commit 이력으로
이미 정리됐고, 본 체크리스트는 **시스템 외부 작업** 위주.

- 작성: 2026-05-25 (audit-cleanup + cluster B 직후)
- 1차 출시 타겟: 한국 (ko) — 일본 (ja) 은 ja 번역 완료 후

---

## A. 코드/설정 점검 (현 상태 ✅)

이미 코드/설정 상으로 충족된 항목.

- [x] **번들 ID** — iOS `com.voicemate.app` / Android `com.voicemate.app`
- [x] **앱 버전** — `app.json` version 1.0.0
- [x] **앱 아이콘 / 어댑티브 아이콘 / 스플래시** — `assets/{icon,adaptive-icon,splash-icon}.png`
- [x] **권한 선언**
  - Android: `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `MODIFY_AUDIO_SETTINGS`, `POST_NOTIFICATIONS` (Android 13+ 필수)
  - iOS: `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `UIBackgroundModes: [remote-notification]`
- [x] **Expo 플러그인** — `expo-router`, `expo-secure-store`, `expo-image-picker`, `expo-audio`, `expo-notifications`, `google-signin`
- [x] **Google Services 파일** — `haru_FE/google-services.json` 존재
- [x] **newArchEnabled** — true (New Architecture 활성)
- [x] **Expo SDK** — 54 (targetSdkVersion 35 / Android 15 자동 충족)
- [x] **EAS profile** — development / preview / production / submit.production 정의됨

---

## B. 출시 직전 코드/환경 변경 (사용자 작업)

### B1. 운영자 모드 비활성 (CRITICAL — 사쿠라 리스크)

- [ ] **`ADMIN_DASHBOARD_ENABLED=false`** — BE production env 에서 admin
      라우트 자체가 mount 안 되게 (`src/index.ts:97` 게이트)
- [ ] **Admin Vercel 프로젝트 disable** — Production 배포 중지
- [ ] **`npm run cleanup:dev`** — dev seed 계정 일괄 정리 (실유저와 채팅에 끼지 않게)

세 단계 모두 출시 직전 (스토어 심사 통과 → 실유저 가입 직전) 실행.

### B2. CS 채널 정식화

- [ ] **정식 CS 이메일 도메인** 입수 (예: `support@haru.app`)
- [ ] 동시 3 위치 교체:
  - `haru_FE/src/i18n/locales/{ko,en,ja}.ts` 의 `moderation.frozen.notice` 카피
  - `haru_BE/docs/legal_drafts.md` 의 §7, 처리방침 §7
  - 카피라이팅 정합 표 §3 의 해당 행

### B3. 모더레이션 사전 외주 (일본 시장 진입 시)

- [ ] **`npx tsx scripts/generate-jp-dictionary.ts`** 실행 → 사람 검수 → JA 사전 4
      상수 paste (`src/constants/moderationDictionary.ts`). 현재 빈 배열로 시작
      상태라 일본어 차단망이 통과 (영문/한글 사전만 작동). 일본 출시 전 필수.

### B4. ElevenLabs / OpenAI API 키 운영용 재발급

- [ ] **ElevenLabs API key** 운영용 신규 (dev 키 = 무료 한도)
- [ ] **OpenAI API key** 운영용 신규 (사용량 모니터링 + 한도 설정)
- [ ] BE production env 적용

---

## C. Google Play Console 등록 작업

### C1. 사전 등록 (앱 등록 전)

- [ ] **개발자 계정 등록** — Google Play Console ($25 일회성)
- [ ] **앱 등록** — 신규 앱 `haru` / 카테고리 Dating
- [ ] **타겟 국가 설정** — 한국 (1차) / 일본 (ja 번역 후 추가)
- [ ] **콘텐츠 등급 (IARC)** — 데이팅앱 + 사용자 생성 콘텐츠 (메시지/음성) 설문
      완료. 18+ 등급 명시 — `legal_drafts.md` 약관 §4(1) 정합.

### C2. 정책/법무 자료 등록

- [ ] **Privacy Policy URL** — `legal_drafts.md` 처리방침 본문을 공개 URL 로
      게시 후 등록 (필수). 무료 호스팅 가능: GitHub Pages / Vercel / Notion
- [ ] **Data Safety form** — `legal_drafts.md` 처리방침 §1 표 (수집 항목)
      기반으로 작성. 일치 안 하면 정책 위반 + 경고/리스팅 거부 가능.
- [ ] **사용자 데이터 삭제 요청 채널** — `auth.ts:deleteAccount` (앱 내) +
      CS 이메일 두 경로 명시 (GDPR / 한국 PIPA 정합).

### C3. 스토어 리스팅 자산

- [ ] **앱 스크린샷** — 폰 (16:9 / 9:16) 최소 2장, 권장 4-8장
- [ ] **피처 그래픽** — 1024×500 px (스토어 헤더)
- [ ] **짧은 설명** — 80자 (한/일 동시)
- [ ] **자세한 설명** — 4000자 (차별점 1·2 마케팅 카피 활용)
- [ ] **앱 아이콘** — 512×512 px (`assets/icon.png` 기반 변환)

---

## D. EAS Production Build & 제출

### D1. APNs / FCM 자격증명

- [ ] **APNs key** (iOS, .p8) 등록 — Apple Developer Account 필요. Expo
      Push Service 가 프록시. (iOS 출시 시점에 진행)
- [ ] **FCM v1 자격증명** (Android) — `google-services.json` 이미 존재 ✓.
      Expo Push Service 가 자동 사용.
- [ ] EAS Dashboard 에서 credentials 확인 (`eas credentials`)

### D2. 빌드 & 제출

- [ ] **`eas build --platform android --profile production`** — AAB 생성
- [ ] **첫 업로드는 manual** — Google Play Console 에서 AAB 직접 업로드 +
      Internal Testing 트랙 → Closed Testing → Open Testing → Production
- [ ] **이후 자동 제출** — `eas submit --platform android`

---

## E. DB Migration 적용 상태 (점검)

dev DB 적용 완료, **staging/prod 신규 환경** 에서는 순차 실행 필요.

| Migration | Dev | Staging/Prod |
|---|---|---|
| 001~023 | ✅ 적용 | ⏳ 첫 배포 시 |
| 024 (moderation_blocks.surface) | ✅ 적용 | ⏳ |
| 025 (v2 DROP + EXECUTE 회수) | ✅ 적용 (사용자 SQL Editor) | ⏳ |
| 026 (audio_purged_at + audio_refreshed_at) | ✅ 적용 (idempotent IF NOT EXISTS) | ⏳ |

- [ ] staging 환경 첫 배포 시 `npx supabase db push --linked` (CLI 사용 시)
      또는 SQL Editor 순차 실행

---

## F. 법무 별도 sprint (출시 후 즉시 또는 1차 출시 ko 한정)

- [ ] **legal_drafts.md ja 번역** — 일본 시장 진입 시 필수
- [ ] **legal_drafts.md en 번역** — 미국/영어권 출시 시 필수
- [ ] **회사명 / 사업자등록번호 / 대표자 / 소재지** — 약관 §2·§11 채우기
- [ ] **개인정보 보호책임자** 성명·직책·연락처 — 처리방침 §7
- [ ] **변호사 자문** — 한국 PIPA / 일본 個情法 / 미국 주별 정합 점검
- [ ] **PIPA §17 5요소 표** — 제3자 제공 동의의 5요소 별도 정리 (법무 자문 input)

---

## G. 출시 후 우선 모니터링

- [ ] **모더레이션 차단 로그** (`moderation_blocks` table + `console.warn`)
      daily review — 사전 vs OpenAI layer 비율로 사전 튜닝
- [ ] **자동 freeze 발동** (`freeze_events`) 모니터링 — false positive 발견 시
      admin 수동 해제 SOP
- [ ] **ElevenLabs / OpenAI / Vertex AI 사용량** — 비용 가시화
- [ ] **푸시 알림 delivery rate** — Expo Push Service 대시보드
- [ ] **30 일 음성 폐기 sweep** (`jobs/purgeExpiredAudio.ts`) 동작 확인 (출시
      후 31일째 첫 polling)
- [ ] **365 일 audit cleanup sweep** (`jobs/cleanupAuditTables.ts`) 동작 확인
      (출시 1년 후)

---

## H. 출시 후 후속 sprint (CLAUDE.md 변경이력 기준 누적 후속 카드)

1. **legal_drafts.md ja/en 번역** (위 F)
2. **bioPhrasesCatalog change-gate 룰** (audio tag 미포함 검증, 더블 사인오프 체크리스트)
3. **moderation_blocks.layer 컬럼** (dictionary/openai 비율 분석용)
4. **voice intro 차단 ≥ 10회 admin 알림** (daily cron)
5. **외부 채널 사전** (LINE/카톡 ID, P0)
6. **1인칭 위기 신호 helpline 분기** (1393 / よりそいホットライン)
7. **harassment/hate/violence 카테고리 추가** (출시 후 데이터 보고)
8. **OpenAI 호출 회귀 통합 테스트** (현재 unit only)
9. **받은 좋아요 paywall** (Tinder Gold 식)
10. **받은 좋아요 보이스 청취 게이팅** (차별점 1 funnel 누수 보호)
11. **새 좋아요 N개 탭바 배지**
12. **푸시 채팅방 foreground OFF / 묶음 / quiet hours / badge / stale cleanup**
13. **failed 메시지 수신자 측 "메시지만 보기" 분기** (voice-first-message-gate 영구 락 보완)
14. **재합성 비용 cap 정책** (audio-expiry, 월 ~$1/활성유저 예상)
15. **언매치 후 재합성 정책** (tombstone 매치에서도 재합성 허용 중 — 차단 사용자 분기 검토)
16. **snake_case ↔ camelCase 변환 layer** (Cluster E, 큰 변경 — 출시 후 안정화 시기)
17. **expo-router 그룹 구조 정리** (Cluster E)
18. **`auth.ts:deleteAccount` 통합 테스트** (push-notifications + message-moderation-v1 두 sprint 공통 약점)

---

## TL;DR — 출시 전 반드시 처리

1. **B1** (admin disable + cleanup:dev 3 단계)
2. **B2** (CS 이메일 정식화) — 또는 sejinim02@gmail.com 유지로 진행 가능
3. **B3** (ja 사전) — 일본 출시 시
4. **B4** (API 키 운영용 재발급)
5. **C1 + C2 + C3** (Google Play Console 등록 + Privacy Policy URL 게시 + Data Safety form)
6. **D2** (EAS production build + 업로드)
7. **F** 일부 (회사명/보호책임자 등 약관 채우기 + 법무 자문)
