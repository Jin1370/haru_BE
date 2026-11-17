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

**메시지 파이프라인**: 텍스트 메시지를 즉시 저장/응답한 뒤, 발신자에게 ElevenLabs voice clone이 있으면 비동기로 (1) Gemini 태깅+번역 → (2) TTS → (3) Storage 업로드 처리. (1) **감정 마커 → audio tag 치환은 Gemini가 번역과 같은 호출에서 수행** (regex `prepareTextForTTS` 폐지). raw 텍스트를 그대로 Vertex AI Gemini 로 보내고 (회사 프로젝트 2.5 Flash 우선 → 실패 시 개인 키 3.8 Flash thinking LOW → 429 시 3.1 Flash-Lite), 시스템 프롬프트가 STEP 1(텍스트에 **실제로 나타난** 채팅체 감정 마커 — `ㅋ`/`ㅎ`(융합 자모 `욬`→`요` 복원 포함)/`www`/`草`/`hahaha`/`lol`/`5`+/`हाहा`/`ㅠ`/`ㅜ`/`xD`/`:(`/`T_T` 등 ko/ja/en/th/hi 웃음·슬픔 마커만 → `[laughs]`/`[sad]`, 문맥/의미 추론 삽입 금지) + STEP 2(register-preserving 번역 — ko 해요체 default + 반말 허용, ja です/ます default + 캐주얼 허용, en 회화체, zh 您 default + 你 허용, 삽입 태그 verbatim 보존)를 한 번에 처리. 한숨은 모든 언어가 의성어 단어(에휴/はぁ/ugh)로 표현되어 태그 우회 불필요 → dictionary 제외. Gemini 응답은 `sanitizeAudioTags`(`src/utils/textNormalization.ts`)로 **화이트리스트 검증** — `[laughs]`/`[sad]`(+eleven_v3 표준 태그) 외 태그·malformed 태그를 strip해 규율 이탈 시 TTS/UI 오염 차단. **송수신자 언어 일치 여부와 무관하게** 항상 Gemini 경유(대화 중 언어 전환·code-switching 대비). `BLOCK_ONLY_HIGH` safety, `temperature=0.4`. (2) TTS 직전 `stripNonAudibleTags`로 **`[laughs]`만 남기고 `[sad]` 등 나머지 audio tag는 제거** — 사용자 정책상 `[laughs]`만 audible(웃음 소리), `[sad]`는 **display-only**(클론 보이스가 흐느낌은 안 냄). `[sad]` 마커 감지·정규화는 STEP 1이 여전히 수행(raw `ㅠㅠ`가 TTS로 새서 자모 괴음 나는 것 방지 목적)하되 소리로는 합성 안 함. 순수 sad 메시지(`ㅠㅠ`)는 strip 후 빈 텍스트 → `hasSpeakableContent` false → TTS 스킵(`audio_url=null`), display 슬랭은 유지. strip 뒤 텍스트로 ElevenLabs `eleven_v3` TTS(`stability=1.0`, 사용자 선택 emotion은 별도 `[emotion]` 프리픽스)로 발신자 클론 보이스 합성. (3) `translated_text` 저장 시 `replaceTagsForDisplay`로 audio tag를 **타깃 언어 슬랭으로 치환**(TTS strip과 무관하게 `[sad]`→슬랭 유지) — UI에 raw 태그 노출은 막되 원본의 감정 표현 의도를 번역본에서도 보존 (예: ko→ja에서 `[laughs]` → `www`, `[sad]` → `(泣)`). 매핑: laughs={ko:ㅋㅋㅋ, ja:www, en:lol, th:555, hi:हाहा}, sad={ko:ㅠㅠ, ja:(泣), en::(, th:T_T, hi::(}. identity 판정(`senderLang===recipientLang` **이고** `replaceTagsForDisplay(translation)===원문`)이면 `translated_text = NULL`로 저장해 FE 번역 인디케이터 숨김 — code-switching(프로필=ko인데 영어로 타이핑)이면 display가 원문과 달라 번역 노출. `audio_status` 필드로 진행 상태 추적. 차단된 유저 간 메시지 전송은 403 차단.

**Voice intro 오디오** (구 bio): 프로필의 `voice_intro` 텍스트 작성/수정 시 voice clone이 있으면 비동기로 TTS 생성하여 `voice_intro_audio_url`에 저장. 프로필 조회 시 추가 API 호출 없이 URL 반환. 버킷은 `voice-intro-audio` (mig 007).

**언어 모델링**: `profiles.language` (TEXT scalar, ko/ja/en/th/hi 화이트리스트) 가 단일 source of truth. mig 009 에서 multi-language + level 모델(`profiles.languages` JSONB / `user_preferences.preferred_languages_detail`)을 모두 삭제하고 단순화 — 프로필 등록은 단일 언어 강제, proficiency level UI 도 제거. 메시지 번역 파이프라인의 source/target 은 송수신자의 `profiles.language` 직접 사용. mig 008 컨텍스트 주의: 008 에서 옛 scalar `profiles.language` 와 codes-only `user_preferences.preferred_languages` 를 drop 했고, 009 가 동일 이름을 단순화된 의미로 재도입한 것 (rollback 아님).

**추천 알고리즘**: 탐색 후보는 DB 함수 `discover_pool(p_user, p_slot, p_exclude)` (mig 067) 가 골라 점수를 매겨 id·점수·`liked_you` 만 돌려준다 (서버 `loadDiscoverPool`). 인원 상한 없이 노출 가능한 사람 전원이 대상 — 예전의 "최근 가입 200명만 점수 대상" 은 prod 한국어 사용자 기준 노출 가능 200명 중 81명을 영영 못 보게 해 제거. 제외: 나 / 이미 스와이프(다시보기 reset_at 제외) / 차단 양방향 / 아직 pass 처리 전인 플레이리스트 멤버 / 받은 좋아요 탭에서 연 사람 / 받은 좋아요 탭의 다음 무료 카드(`like_card_pins` — 플레이리스트로 가면 타이머가 안내 없이 다른 사람에게 옮겨 가므로) / 섀도우 숨김·캠페인 봇(`p_exclude`) / **viewer 와 같은 언어** (크로스언어 강제) / 사진 0장 / 내 언어 보이스 한마디 없음. 점수: 관심사 겹침(최대 +30), 사진 3장+ (+15), 가입 7일 이내 (+10), 최근 접속 (`daily_active_users` KST 오늘·어제 +20, 7일 이내 +10), 쌍 jitter (0~15). **jitter 는 두 id 를 정렬해 해시해 A→B 와 B→A 가 같다** — 관심사 겹침도 대칭이라 점수가 거리처럼 작동해 서로의 상위에 함께 뜨는 쌍이 생긴다 (거리 필터 없는 앱에서 상호 노출을 만드는 장치). 칸 고르기(`pickPlaylistCards`): 점수 순으로 앞에서부터 10명을 담되, 나에게 인사한 사람은 칸당 `LIKED_YOU_SLOTS`(2)명까지 (넘는 사람은 건너뜀). 인사한 사람 가산(`LIKED_YOU_PICK_BONUS`)은 0 — 인사한 사람은 최근 활동해 이미 접속 가산을 받아, 가산 없이도 칸마다 0~2명이 섞인다 (prod 실데이터 24명 시뮬레이션: +0 은 1-2-2-1-1-2… 처럼 섞이고 +10 은 대부분 2-2-2-2… 로 앞 칸부터 꽉 참). 받은 인사가 후보의 ~20% 이상이면 가산과 무관하게 매 칸 2명이 찬다. **다시 보기** (새 카드가 바닥나지 않게): 내가 넘긴 사람도 후보로 돌아온다 (`discover_pool` 가 `passed_at` 을 달아 줌, 인사한 사람·차단은 제외). 그날 첫 칸(무료)은 새 카드 `freeNewSlots(남은 새 카드)` = min(남은, 10, 반올림(4 + 남은/8))장(50+ → 10, 40 → 9, 25 → 7, 10 → 5, 3 → 3, 0 → 0) + 나머지를 다시 보기 카드로 채운다 (`pickFreePlaylist`). 다시 보기 카드가 모자라면 새 카드로 마저 채워 10장을 맞춘다 (플레이리스트 기본 구성 10장 — 덜 채우면 다음 조회의 빈자리 채우기가 새 카드를 넣어 열기 전에 보여 준 LP 수가 줄었다). 다시 보기 카드는 대기 기간 3일 × 2^(넘긴 횟수-1) (3 → 6 → 12일)이 지나야 나오고, 한 사람당 최대 3번, 점수 − 넘긴 횟수 × 10 순으로 꺼낸다 (`swipes.pass_count`, DB 함수 안에서 처리). 다시 보기 카드는 새 카드와 같은 선상에서 경쟁시키지 않는다 — 새 카드가 모자란 자리만 채운다 (사용자 결정) — 새 카드를 여러 날에 나눠 써 다시 보기 비중이 천천히 커진다. 별사탕 칸은 새 카드 10장으로만 (`pickPaidPlaylist`), 새 카드가 10장 안 남으면 그 칸은 안 보인다(`candidate_count` = 열 수 있는 칸 수 × 10). 다시 보기 카드에 인사하면 기존 pass 행을 like 로 바꾸고(POST /swipe, `source=playlist` 멤버일 때만 — 아니면 409), 다시 넘기면 초기화 정리가 넘긴 시각(`created_at`)을 지금으로, `pass_count` 를 +1 한다. 다시 보기 표시(배지)는 없다 (사용자 결정). 인사 안 한 사람이 모자라 10명이 안 차면 건너뛴 인사한 사람으로 마저 채운다. 덜 찬 칸 채우기·인사 시 빈자리 채우기도 인사 안 한 사람부터, 모자라면 인사한 사람. **매칭 선호 설정(성별·나이·선호 국적)은 쓰지 않는다** (데이터와 `/api/preferences` 라우트는 옛 앱 호환을 위해 남김). 받은 좋아요 탭도 같은 점수로 정렬한다 — 점수 공식은 DB 함수 `discover_score(p_user, p_ids)` 하나에 있고 `discover_pool` 와 `GET /likes-received` 가 함께 쓴다.

**탐색 플레이리스트** (mig 063·064): 하루 3개(사용자 로컬 날짜, 하루는 현지 새벽 5시에 바뀜 — `DAY_START_HOUR`, `tz_offset_minutes`). 처음 여는 1개 무료, 나머지는 곡 수 비례 별사탕 (유료화 OFF 면 하루 1개). 여는 순간 서버가 상위 최대 10명을 고정(`open_playlist` RPC — 차감+생성 한 트랜잭션). 열 때 후보가 모자라 10명이 안 찬 칸은 이후 `GET /playlists` 에서 새로 생긴 후보로 먼저 채운다(먼저 연 칸부터, `allocatePlaylistTopUp`, 추가 차감 없음) — 남은 후보로만 새 칸을 보여주며 `candidate_count` 로 FE 가 보여줄 LP 수를 정한다. FE 가 처음 화면에 나온 카드를 `POST /playlists/:idx/seen` 으로 기록하고, 초기화 뒤 처음 조회(`finalizePastPlaylists`)에서 본 카드 중 대화 신청 안 한 카드만 pass 로 기록한 뒤 지난 플레이리스트를 지운다 (안 본 카드는 후보로 복귀, 스케줄러 없음). 좋아요(대화 신청) 한도는 없다 — 플레이리스트 대화 신청은 오늘 내 플레이리스트 멤버에게만(`source=playlist`, 아니면 403 `not_in_playlist`). `GET /quota` 는 별사탕 잔액·받은 좋아요 무료 카드 타이머·광고 남은 횟수만 반환.

**라우트 마운트 구조**:
- `/api/auth` — Google OAuth, 토큰 갱신
- `/api/profile` — 프로필 CRUD, 사진 업로드/삭제 (JPEG/PNG/WebP만 허용, 파일명 UUID화)
- `/api/voice` — ElevenLabs 음성 클론 관리
- `/api/discover` — `/playlists` 탐색 플레이리스트(목록·열기·카드·seen), `/swipe` 대화 신청 (동시 like 중복 매치 방지), `/quota` 별사탕 상태, `/likes-received` 받은 좋아요 목록 (나를 like 한 사용자 중 미스와이프·비차단 후보, 유료화 ON 이면 오늘 탐색 플레이리스트 멤버는 숨김(OFF 는 숨기지 않음), 탐색에서 한 번 지나친 사람(초기화 때 자동 넘김 포함)은 응답한 것으로 보고 제외 — 틴더와 같음, 유료화 ON 이면 공개 순 + 안 연 사람 전원 잠긴 카드, 맨 앞 잠긴 카드는 무료 시각이 되면 조회 때 자동 공개) + `/likes-received/reveal` (별사탕 또는 무료 카드)
- `/api/matches` — 매치 목록(N+1 해결 RPC, 커서 페이지네이션), 언매치, 메시지 CRUD, 읽음 처리
- `/api/block` — 유저 차단/해제/목록 (차단 시 매치 자동 soft delete, 해제 시 404 처리)
- `/api/report` — 유저 신고
- `/api/preferences` — 매칭 선호도 (나이/성별/국가). 사전 SQL 필터: 나이·성별 + viewer 본인 언어와 동일한 후보 하드 제외. 국가 선호는 티어 정렬 신호. (선호 언어 기능은 mig 042 에서 완전 제거 — 컬럼 drop + 라우트/스키마에서 삭제. 언어가 국적에서 파생되어 선호 국적이 동일 신호를 커버.)
- `/docs` — Swagger UI

## Key Conventions

- 모든 인증 필요 라우트는 `authMiddleware`를 `router.use()`로 적용
- 입력 검증: zod 스키마 (`src/schemas/`) + `validateBody`/`validateQuery` 미들웨어 (`src/middleware/validate.ts`). Express 5에서 `req.query`는 getter 전용이므로 `Object.defineProperty`로 덮어씀.
- 에러 처리: 라우트 핸들러가 직접 `res.status(...).json({ error })` 응답. `errorMiddleware`는 미처리 예외를 500 으로 변환하는 최종 안전망 (옛 `AppError` 클래스 컨벤션은 사용처 0 으로 2026-07 리팩토링에서 제거됨)
- Supabase service role key 사용 (RLS 우회) — 서버 사이드 전용. `env.supabase.anonKey`도 설정 가능.
- 매치 생성 시 `user1_id < user2_id` 정렬 보장 (DB UNIQUE 제약조건). 동시 like로 인한 중복(23505) 시 기존 매치 조회로 fallback.
- 매치 삭제는 soft delete (`unmatched_at`, `unmatched_by`)
- 파일 업로드: multer 메모리 스토리지 → Supabase Storage `uploadFile` 유틸. 사진 파일명은 `{timestamp}_{uuid}.{ext}`로 원본명 미사용.
- 사진 삭제: DB 먼저 업데이트 후 Storage 삭제는 fire-and-forget (Storage 고아 파일보다 DB 불일치가 더 위험)
- 비동기 처리 (메시지 번역/TTS, voice intro 오디오): fire-and-forget + `.catch()` 로깅. 상태 필드로 추적.
- 번역은 `src/services/translation.ts`의 `translateMessage()` (Vertex AI Gemini — `GCP_PROJECT_ID` 설정 시 회사 2.5 Flash 우선, 실패 시 개인 키 3.8 Flash + 429 시 3.1 Flash-Lite, `@google/genai` + `GEMINI_API_KEY`(서비스 계정 바인딩 키), `responseMimeType: application/json`, `temperature=0.4`, `BLOCK_ONLY_HIGH` safety). source/target 은 송수신자의 `profiles.language` 스칼라 값. TTS는 `src/services/elevenlabs.ts`의 `synthesizeSpeech()` — `eleven_v3` 모델, `stability=1.0`, 언어 코드는 안 보내고 텍스트에서 자동 감지. emotion 값이 있으면 텍스트 앞에 `[emotion]` 프리픽스로 전달.
- Supabase `.update()` / `.delete()`에서 count가 필요하면 `{ count: 'exact' }` 옵션 사용
- **외부 의존성 호출 시 error 가시화 룰** (silent-success 금지): Supabase / ElevenLabs / OpenAI / Vertex AI / Storage 호출 결과에서 반드시 `error` 를 destructure 하고 (a) 응답 status 적절히 set 또는 (b) `console.error` 로 가시화한다. 무가시 silent skip 금지. 회귀 사례 2건 (voice-first-message-gate listened POST schema-drift / read-at-removal-list-mask v3 RPC error 가드 누락) 모두 같은 패턴으로 발견됨. fire-and-forget 패턴이라도 `.then(({ error }) => ...)` 로 명시 노출.
- **신규 user-linked 테이블 추가 시 `auth.ts:deleteAccount` 동기 정리 룰**: profiles FK CASCADE 가 fire 되지 않는다 (deleteAccount 가 anonymize 만 함). 신규 테이블이 `user_id` / `sender_id` 등 사용자 참조 컬럼을 가지면 deleteAccount 의 cleanup task 에 동기 DELETE 를 추가해야 GDPR/PIPA 데이터 삭제권 충족. 회귀 사례 2건 (push-notifications device_tokens / message-moderation-v1 moderation_blocks+freeze_events) 모두 sprint 내 follow-up 으로 처리됨.
- **moderation_blocks audit INSERT 는 `logModerationBlock` helper 사용** (`src/utils/moderationAudit.ts`). 4 위치 (메시지 dictionary/openai + voice intro dictionary/openai) 통합. surface (`message` / `voice_intro`) 와 layer (`dictionary` / `openai`) 만 호출처 분기로 전달.

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

Supabase 모킹은 각 테스트 파일이 `vi.hoisted` + `vi.mock` 패턴으로 직접 구성한다 (옛 `tests/helpers.ts` 의 `createMockSupabaseQuery` 는 라이브-DB 테스트 정리 커밋 `e52e0eb` 에서 삭제됨 — `tests/swipe.test.ts` 가 현행 패턴의 참조 예시).
