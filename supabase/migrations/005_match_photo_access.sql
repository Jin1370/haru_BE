-- ========== PhotoAccess 2단계 공개: get_match_summaries_v2 RPC ==========
--
-- 목적: 기존 get_match_summaries 반환 필드에 round_trip_count,
--       main_photo_unlocked, all_photos_unlocked 를 추가한 확장판.
--
-- 라운드트립 정의 (FE haru_FE/src/utils/chat.ts countRoundTrips 와 동일 의미):
--   각 match 의 messages 를 created_at ASC 로 순회하며
--   첫 발신자를 기준으로 A/B 교대 페어를 완성한 횟수를 센다.
--   (sender 가 연속으로 같은 쪽이면 1회로 묶임. 반대쪽이 처음 등장한 순간 페어 1 완성)
--
-- 임계치 상수 UNLOCK_MAIN / UNLOCK_ALL 은 BE 측
-- haru_BE/src/constants/chat.ts 의 UNLOCK_MAIN_PHOTO_AT,
-- UNLOCK_ALL_PHOTOS_AT 와 반드시 **동일 값으로 동기화** 되어야 한다.
-- 값 변경 시 본 migration 과 constants/chat.ts, FE 상수 3곳을 동시에 고친다.
--
-- 기존 get_match_summaries 는 롤백 대비 유지(삭제 금지).

CREATE OR REPLACE FUNCTION get_match_summaries_v2(
  match_ids UUID[],
  viewer_id UUID
)
RETURNS TABLE (
  match_id UUID,
  last_message_id UUID,
  last_message_text TEXT,
  last_message_sender_id UUID,
  last_message_created_at TIMESTAMPTZ,
  unread_count BIGINT,
  round_trip_count BIGINT,
  main_photo_unlocked BOOLEAN,
  all_photos_unlocked BOOLEAN
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- constants/chat.ts 와 동기화 필요
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
  unread BIGINT;
BEGIN
  FOREACH mid IN ARRAY match_ids LOOP
    -- 라운드트립 계산 (FE countRoundTrips 포팅)
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

    -- 마지막 메시지
    SELECT id, original_text, sender_id, created_at
      INTO last_id, last_text, last_sender, last_ts
      FROM messages
     WHERE messages.match_id = mid
     ORDER BY created_at DESC
     LIMIT 1;

    -- unread (viewer 기준)
    SELECT COUNT(*) INTO unread
      FROM messages
     WHERE messages.match_id = mid
       AND messages.sender_id <> viewer_id
       AND messages.read_at IS NULL;

    match_id := mid;
    last_message_id := last_id;
    last_message_text := last_text;
    last_message_sender_id := last_sender;
    last_message_created_at := last_ts;
    unread_count := COALESCE(unread, 0);
    round_trip_count := rt;
    main_photo_unlocked := rt >= UNLOCK_MAIN;
    all_photos_unlocked := rt >= UNLOCK_ALL;
    RETURN NEXT;
  END LOOP;
END;
$$;
