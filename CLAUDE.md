# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # 개발 서버 (tsx watch, 핫리로드)
npm run build        # TypeScript 컴파일 (dist/)
npm start            # 프로덕션 서버
npm test             # vitest 전체 테스트
npx vitest run tests/auth.test.ts  # 단일 테스트 파일 실행
```

## Architecture

Express 5 + Supabase + ElevenLabs 기반 크로스언어 소개팅 API 서버.

**인증 흐름**: Google OAuth id_token → Supabase `signInWithIdToken` → JWT 발급. 이후 요청은 `authMiddleware`에서 Supabase JWT secret으로 검증하여 `req.userId`(= `sub` claim) 세팅.

**메시지 파이프라인**: 텍스트 메시지를 즉시 저장/응답한 뒤, 발신자에게 ElevenLabs voice clone이 있으면 비동기로 번역 → TTS → Storage 업로드 처리. 송수신자의 `profiles.language` 값이 다르면 Vertex AI Gemini 2.5 Flash로 번역(존댓말/초면 컨텍스트 시스템 프롬프트, `BLOCK_ONLY_HIGH` safety, `temperature=0.3`) → `translated_text`에 저장, 이후 ElevenLabs `eleven_v3` TTS(`stability=0.4`, emotion 프리픽스 지원)로 발신자 클론 보이스 합성. 같은 언어면 번역 생략하고 원문 그대로 TTS. `audio_status` 필드로 진행 상태 추적. 차단된 유저 간 메시지 전송은 403 차단.

**Voice intro 오디오** (구 bio): 프로필의 `voice_intro` 텍스트 작성/수정 시 voice clone이 있으면 비동기로 TTS 생성하여 `voice_intro_audio_url`에 저장. 프로필 조회 시 추가 API 호출 없이 URL 반환. 버킷은 `voice-intro-audio` (mig 007).

**언어 모델링**: `profiles.language` (TEXT scalar, ko/ja/en/th/hi 화이트리스트) 가 단일 source of truth. mig 009 에서 multi-language + level 모델(`profiles.languages` JSONB / `user_preferences.preferred_languages_detail`)을 모두 삭제하고 단순화 — 프로필 등록은 단일 언어 강제, proficiency level UI 도 제거. 메시지 번역 파이프라인의 source/target 은 송수신자의 `profiles.language` 직접 사용. mig 008 컨텍스트 주의: 008 에서 옛 scalar `profiles.language` 와 codes-only `user_preferences.preferred_languages` 를 drop 했고, 009 가 동일 이름을 단순화된 의미로 재도입한 것 (rollback 아님).

**추천 알고리즘**: 디스커버에서 스와이프/차단/선호도를 병렬 조회 후, 후보를 limit×5개(최대 200) 가져옴. 사전 SQL 필터는 (a) 성별/연령 (b) **viewer 의 `profiles.language` 와 동일한 후보를 하드 제외** — 크로스언어 매칭 차별점을 알고리즘 차원에서 강제. viewer 언어가 비어있으면 이 필터는 적용 안 함. 국가 선호와 언어 선호는 SQL 단계에서 거르지 않고 티어 정렬 신호로만 사용. 서버에서 4-단계 티어 + 동일 티어 내 2차 점수 계산 → `(tier ASC, intra DESC)` 정렬 → limit개 반환. `src/routes/swipe.ts`의 `computeTier()` + `computeIntraScore()` + `matchesLanguage()` + `matchesNationality()` + `hashJitter()`. 티어는 국가 부합을 언어 부합보다 우선해 (1) 국가+언어 둘 다 부합 (2) 국가만 부합 (3) 언어만 부합 (4) 둘 다 미부합 으로 가른다. 언어 부합은 `user_preferences.preferred_languages` (TEXT[]) 가 비어있거나 후보의 `profiles.language` 를 포함하면 true (level 차원은 mig 009 에서 제거됨), 국가 부합은 후보 `profiles.nationality` 가 `preferred_nationalities` 안에 있으면 true. 각 차원별로 빈 선호는 그 차원이 항상 부합으로 처리된다 (=제약 없음). 단 국가 우선 정책상 빈 차원과 활성 차원의 조합은 비대칭하게 분기됨에 주의: 빈 lang + 채워진 nat 는 nat 부합 시 T1, nat 미부합 시 **T3** (langOk 가 항상 true 라 T2 분기 도달 불가); 빈 nat + 채워진 lang 은 lang 부합 시 T1, lang 미부합 시 **T2** (natOk 가 항상 true 라 T3 도달 불가). 양 차원 모두 비어있으면 모두 T1. 동일 티어 내 2차 점수는 관심사 겹침(최대 +30), 사진 3장+ (+10), 신규 가입 7일 이내 (+10), 결정적 jitter (0~15) 합산이며 합산 상한이 65로 묶여 티어 경계를 절대 넘지 않는다. jitter는 같은 viewer-candidate 쌍에 대해 결정적이므로 페이지네이션 시 순서 안정.

**일일 카드 한도**: 사용자당 하루 최대 50장 노출 (`DISCOVER_MAX_PER_DAY = 50`, `src/routes/swipe.ts`). `swipes` 테이블이 source of truth — 기기 간 동기화를 위해 BE 가 일일 카운트를 산출. `GET /api/discover/quota` 가 `{ used, max, remaining }` 를 반환하며 FE 는 이 값을 폴링/캐시. 자정 기준은 서버 UTC 타임존 (자세한 롤오버 동작은 `quotaQuerySchema` 참고). FE 의 `BATCH_SIZE=10`, `PREFETCH_THRESHOLD=3` 등 클라이언트 prefetch 동작은 `haru_FE/docs/discover-card-logic.md` 참고.

**라우트 마운트 구조**:
- `/api/auth` — Google OAuth, 토큰 갱신
- `/api/profile` — 프로필 CRUD, 사진 업로드/삭제 (JPEG/PNG/WebP만 허용, 파일명 UUID화)
- `/api/voice` — ElevenLabs 음성 클론 관리
- `/api/discover` — 추천 후보 조회, 스와이프 (동시 like 중복 매치 방지), `/quota` 일일 한도 조회
- `/api/matches` — 매치 목록(N+1 해결 RPC, 커서 페이지네이션), 언매치, 메시지 CRUD, 읽음 처리
- `/api/block` — 유저 차단/해제/목록 (차단 시 매치 자동 soft delete, 해제 시 404 처리)
- `/api/report` — 유저 신고
- `/api/preferences` — 매칭 선호도 (나이/성별/언어/국가). 사전 SQL 필터: 나이·성별 + viewer 본인 언어와 동일한 후보 하드 제외. 언어 선호 (`preferred_languages` TEXT[])와 국가 선호는 티어 정렬 신호.
- `/docs` — Swagger UI

## Key Conventions

- 모든 인증 필요 라우트는 `authMiddleware`를 `router.use()`로 적용
- 입력 검증: zod 스키마 (`src/schemas/`) + `validateBody`/`validateQuery` 미들웨어 (`src/middleware/validate.ts`). Express 5에서 `req.query`는 getter 전용이므로 `Object.defineProperty`로 덮어씀.
- 에러 처리: `AppError` 클래스 (`src/errors.ts`) + `errorMiddleware`에서 `instanceof` 판별
- Supabase service role key 사용 (RLS 우회) — 서버 사이드 전용. `env.supabase.anonKey`도 설정 가능.
- 매치 생성 시 `user1_id < user2_id` 정렬 보장 (DB UNIQUE 제약조건). 동시 like로 인한 중복(23505) 시 기존 매치 조회로 fallback.
- 매치 삭제는 soft delete (`unmatched_at`, `unmatched_by`)
- 파일 업로드: multer 메모리 스토리지 → Supabase Storage `uploadFile` 유틸. 사진 파일명은 `{timestamp}_{uuid}.{ext}`로 원본명 미사용.
- 사진 삭제: DB 먼저 업데이트 후 Storage 삭제는 fire-and-forget (Storage 고아 파일보다 DB 불일치가 더 위험)
- 비동기 처리 (메시지 번역/TTS, voice intro 오디오): fire-and-forget + `.catch()` 로깅. 상태 필드로 추적.
- 번역은 `src/services/translation.ts`의 `translateMessage()` (Vertex AI Gemini 2.5 Flash, `responseMimeType: application/json`, `temperature=0.3`, `BLOCK_ONLY_HIGH` safety). source/target 은 송수신자의 `profiles.language` 스칼라 값. TTS는 `src/services/elevenlabs.ts`의 `synthesizeSpeech()` — `eleven_v3` 모델, `stability=0.4`, 언어 코드는 안 보내고 텍스트에서 자동 감지. emotion 값이 있으면 텍스트 앞에 `[emotion]` 프리픽스로 전달.
- Supabase `.update()` / `.delete()`에서 count가 필요하면 `{ count: 'exact' }` 옵션 사용

## DB Migrations

- `001_initial_schema.sql` — profiles, swipes, matches, messages + RLS + Realtime
- `002_blocks_reports_preferences_read.sql` — blocks, reports, user_preferences 테이블 + messages.read_at + matches.unmatched_at/unmatched_by + profiles.bio_audio_url + get_match_summaries RPC + 추가 인덱스
- `003_bio_audio_bucket.sql` — `bio-audio` Storage 버킷 생성 (mig 007 에서 voice-intro-audio 로 대체)
- `004_message_emotion.sql` — messages.emotion 컬럼 + CHECK 제약
- `005_match_photo_access.sql` — 라운드트립 기반 photo unlock 플래그 + `get_match_summaries_v2` RPC
- `006_multi_language_proficiency.sql` — `profiles.languages` JSONB + `user_preferences.preferred_languages_detail` JSONB 추가, 옛 scalar 컬럼에서 백필
- `007_rename_bio_to_voice_intro.sql` — `profiles.bio` → `voice_intro`, `profiles.bio_audio_url` → `voice_intro_audio_url`. Storage 버킷 `bio-audio` → `voice-intro-audio`. 옛 URL은 NULL 리셋 후 다음 저장 시 재합성.
- `008_cleanup_languages_add_nationalities.sql` — 옛 scalar `profiles.language` 컬럼 삭제(언어는 `languages` JSONB 만 사용). 옛 codes-only `user_preferences.preferred_languages` 컬럼 삭제. 신규 `user_preferences.preferred_nationalities TEXT[]` 추가 (그 전엔 FE 만 보내고 BE가 silent drop 했음).
- `009_simplify_language_model.sql` — 언어 모델 단순화 (다중 + level → 단일 scalar / 코드 배열). `profiles.language TEXT` 재도입 (mig 008 에서 같은 이름이 drop 된 이력 있음 — rollback 아니라 단순화된 형태로의 재도입). `profiles.languages` JSONB 삭제. `user_preferences.preferred_languages TEXT[]` 재도입 (level 없음). `user_preferences.preferred_languages_detail` JSONB 삭제. 백필: `languages[0].code` → `language`, `preferred_languages_detail[].code` → `preferred_languages`.
- `010_profile_language_not_null.sql` — `profiles.language` NOT NULL 강제. mig 009 백필 검증 후 단계.

## Testing

vitest + supertest. `tests/setup.ts`에서 env, Supabase, ElevenLabs, Storage를 전역 모킹. `app`은 `src/index.ts`에서 export하며, `NODE_ENV=test`일 때 `listen()` 스킵.

`tests/helpers.ts`: `generateTestToken(userId?)`, `createMockSupabaseQuery(data, error)` — 체이닝 가능한 Supabase 쿼리 mock 생성.
