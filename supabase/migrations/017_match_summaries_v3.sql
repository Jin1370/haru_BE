-- ========== read-at-removal-list-mask sprint ==========
--
-- v2 → v3 의 핵심 변경:
--   1. unread_count 가 read_at IS NULL → listened_at IS NULL 로 전환
--      ("읽음" 의미를 음성 청취로 일원화).
--   2. unread_count 산정 시 audio_status = 'ready' 필터 추가
--      (voice-first-message-gate follow-up 의 채팅방 GET 필터와 정합).
--      → 영구 락 메시지(pending/failed) 가 unread badge 를 부풀리지 않음.
--   3. last_message 후보 SELECT 에 viewer 시점 필터 추가:
--        WHERE sender_id = viewer_id OR audio_status = 'ready'
--      → "수신자에게 안 보이는 메시지" 가 last_message 로 잡혀
--         원문/마스킹이 모두 비어 카드가 "비어있는 메시지" 상태로
--         보이는 회귀 차단. 본인 발신은 status 무관하게 후보 (송신자
--         본인은 자기 메시지를 알아야 재전송 등 대응 가능).
--   4. last_message_listened_at, last_message_audio_status 컬럼 추가
--      → FE MatchItem 의 마스킹 분기가 요구하는 raw 필드. RPC 단에서
--        한 번에 노출해 FE 가 별도 fetch 안 해도 됨.
--   5. last_message_text 컬럼명을 last_message_preview 로 변경
--      (의미 정확성 — 마스킹/원문 분기가 FE 책임이므로 "preview" 라는
--      중립적 이름이 더 맞음). BE 라우트는 응답 wire 형식의 키 이름
--      (original_text) 을 유지하고 값만 preview 컬럼에서 가져온다.
--
-- 기존 v2 는 DROP 하지 않고 유지 — 본 마이그 적용 후 BE 라우트가 v3 로
-- 교체되기 전까지의 짧은 윈도우 동안 v2 가 계속 호출됨 (downtime 0).
-- v2 의 read_at 참조는 다음 마이그 (018) 직전까지 살아있어야 한다.
-- 마이그 018 적용 후 v2 는 dead function 으로 남고 다음 sprint 에서
-- 정리 카드.

CREATE OR REPLACE FUNCTION get_match_summaries_v3(
  match_ids UUID[],
  viewer_id UUID
)
RETURNS TABLE (
  match_id UUID,
  last_message_id UUID,
  last_message_preview TEXT,
  last_message_sender_id UUID,
  last_message_created_at TIMESTAMPTZ,
  last_message_audio_status TEXT,
  last_message_listened_at TIMESTAMPTZ,
  unread_count BIGINT,
  round_trip_count BIGINT,
  main_photo_unlocked BOOLEAN,
  all_photos_unlocked BOOLEAN
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- constants/chat.ts 와 동기화 필요 (v2 와 동일 값)
  UNLOCK_MAIN CONSTANT INTEGER := 5;
  UNLOCK_ALL  CONSTANT INTEGER := 10;
  mid UUID;
  rec RECORD;
  first_sender UUID;
  seen_a BOOLEAN;
  seen_b BOOLEAN;
  rt BIGINT;
  last_id UUID;
  last_text TEXT;
  last_sender UUID;
  last_ts TIMESTAMPTZ;
  last_status TEXT;
  last_listened TIMESTAMPTZ;
  unread BIGINT;
BEGIN
  FOREACH mid IN ARRAY match_ids LOOP
    -- 라운드트립 계산 (v2 와 동일 로직 — 본인/상대 페어 카운트)
    first_sender := NULL;
    seen_a := FALSE;
    seen_b := FALSE;
    rt := 0;

    FOR rec IN
      SELECT sender_id
        FROM messages
       WHERE messages.match_id = mid
       ORDER BY created_at ASC
    LOOP
      IF first_sender IS NULL THEN
        first_sender := rec.sender_id;
        seen_a := TRUE;
      ELSIF rec.sender_id = first_sender THEN
        seen_a := TRUE;
      ELSE
        seen_b := TRUE;
      END IF;

      IF seen_a AND seen_b THEN
        rt := rt + 1;
        seen_a := FALSE;
        seen_b := FALSE;
      END IF;
    END LOOP;

    -- 마지막 메시지 — viewer 시점 필터 적용.
    -- 본인 발신은 status 무관, 상대 발신은 audio_status='ready' 만.
    SELECT id, original_text, sender_id, created_at, audio_status, listened_at
      INTO last_id, last_text, last_sender, last_ts, last_status, last_listened
      FROM messages
     WHERE messages.match_id = mid
       AND (messages.sender_id = viewer_id OR messages.audio_status = 'ready')
     ORDER BY created_at DESC
     LIMIT 1;

    -- unread (viewer 기준) — 상대 발신 + 미청취 + ready 만.
    SELECT COUNT(*) INTO unread
      FROM messages
     WHERE messages.match_id = mid
       AND messages.sender_id <> viewer_id
       AND messages.audio_status = 'ready'
       AND messages.listened_at IS NULL;

    match_id := mid;
    last_message_id := last_id;
    last_message_preview := last_text;
    last_message_sender_id := last_sender;
    last_message_created_at := last_ts;
    last_message_audio_status := last_status;
    last_message_listened_at := last_listened;
    unread_count := COALESCE(unread, 0);
    round_trip_count := rt;
    main_photo_unlocked := rt >= UNLOCK_MAIN;
    all_photos_unlocked := rt >= UNLOCK_ALL;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 권한 — Supabase service role 만 호출하므로 별도 GRANT 불필요 (v2 와 동일 정책).
-- v2 도 그대로 유지 (다음 마이그 018 직전까지 살아 있어야 함).
