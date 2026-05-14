-- ========== read-at-removal-list-mask sprint (step 2) ==========
--
-- 사전 조건:
--   * mig 017 적용됨 (v3 RPC 신설, v2 잔존).
--   * BE 라우트 (`src/routes/match.ts`) 가 v3 호출로 교체되어 배포됨.
--   * BE 라우트 (`src/routes/message.ts`) 의 read_at UPDATE 및 응답 필드가 제거됨
--     (PATCH /:matchId/messages/read 라우트 자체 삭제).
--
-- 본 마이그가 read_at 컬럼을 DROP 하면 v2 RPC 도 함께 깨진다.
-- v2 는 유지하되 호출 시 에러나는 dead function 으로 남는다 — 다음 sprint 에서
-- v2 DROP 카드로 정리 (롤백 안전망 목적). v3 만 정상 동작.
--
-- mig 002 의 RLS 정책에는 read_at 참조 없음 (검증 완료: blocks/reports/
-- user_preferences/matches.unmatched_at 만 다룸). 따라서 RLS ALTER 불필요.
-- mig 002 가 만든 부분 인덱스 `idx_messages_read` 는 read_at 컬럼 DROP 과 함께
-- CASCADE 로 사라지지만, 명시적으로 먼저 DROP 해 의도 명확.

DROP INDEX IF EXISTS public.idx_messages_read;

ALTER TABLE public.messages
  DROP COLUMN IF EXISTS read_at;

-- 새 인덱스 추가 안 함 — listened_at 기반 unread 쿼리는 RPC 안에서만 발생
-- 하고, messages(match_id, created_at) 기존 인덱스가 매치 단위 필터를 충분히
-- 좁힌다. 향후 unread badge 응답 지연이 보이면 별도 마이그에서
-- messages(match_id, sender_id, listened_at) WHERE listened_at IS NULL
-- 부분 인덱스를 검토.
--
-- Realtime publication 변경 불필요 — column DROP 은 publication 컬럼 set 을
-- 자동으로 줄인다. REPLICA IDENTITY DEFAULT 라 별도 처리 없음. FE 의
-- realtime UPDATE 핸들러는 read_at 필드를 더 이상 참조하지 않음.
