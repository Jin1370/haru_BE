-- ========== match-roundtrip-realtime: Step B — 백필 ==========
--
-- 014a 에서 추가한 4개 컬럼을 기존 매치에 채워 넣는다. 페어링 로직은
-- 005 mig 의 get_match_summaries_v2 RPC 와 **동일한 알고리즘** 으로
-- inline 포팅:
--
--   각 match 의 messages 를 created_at ASC 로 순회하며 첫 발신자를
--   기준으로 A/B 교대 페어를 완성한 횟수를 센다. sender 가 연속으로
--   같은 쪽이면 1회로 묶임. 반대쪽이 처음 등장한 순간 페어 1 완성.
--
-- 014c 트리거의 상태머신은 unpaired_sender (= 직전 페어 완성 후 첫
-- 발신자) 만 들고 진행하면 등가의 결과를 산출한다. 본 백필은 모든
-- 메시지를 1회 스캔해 round_trip_count + unpaired_sender 의 최종
-- snapshot 을 저장한다.
--
-- 임계치 (UNLOCK_MAIN_PHOTO_AT=5, UNLOCK_ALL_PHOTOS_AT=10) 는
-- haru_BE/src/constants/chat.ts 와 동기화. drift 가드는
-- tests/matchRoundtripTrigger.test.ts.
--
-- 매치별 sub-transaction: 한 매치의 백필이 실패해도 다른 매치는
-- 영향받지 않고, 실패는 match_backfill_failures 에 적재된다.
-- DEFAULT NULL 유지 정책 — 실패 매치는 round_trip_count = NULL 상태로
-- 남고, 014c 트리거 활성화 사전 게이트(failures empty 검증)에서
-- 운영자가 인지한다.

DO $$
DECLARE
  UNLOCK_MAIN CONSTANT INTEGER := 5;
  UNLOCK_ALL  CONSTANT INTEGER := 10;
  match_row RECORD;
  rec RECORD;
  first_sender UUID;
  seen_a BOOLEAN;
  seen_b BOOLEAN;
  rt INTEGER;
  unpaired UUID;
  last_pair_sender UUID;  -- 페어 완성 직후 다음 페어의 첫 발신자 후보
  main_at TIMESTAMPTZ;
  all_at TIMESTAMPTZ;
  now_ts TIMESTAMPTZ := now();
BEGIN
  FOR match_row IN SELECT id FROM matches LOOP
    BEGIN
      first_sender := NULL;
      seen_a := FALSE;
      seen_b := FALSE;
      rt := 0;
      unpaired := NULL;
      last_pair_sender := NULL;

      FOR rec IN
        SELECT sender_id
          FROM messages
         WHERE messages.match_id = match_row.id
         ORDER BY created_at ASC
      LOOP
        IF first_sender IS NULL THEN
          first_sender := rec.sender_id;
          seen_a := TRUE;
          unpaired := rec.sender_id;
        ELSIF rec.sender_id = first_sender THEN
          seen_a := TRUE;
          -- 페어 미완 상태에서 unpaired 가 NULL 이면 (직전 페어 직후) 재설정
          IF unpaired IS NULL THEN
            unpaired := rec.sender_id;
          END IF;
        ELSE
          seen_b := TRUE;
          IF unpaired IS NULL THEN
            unpaired := rec.sender_id;
          END IF;
        END IF;

        IF seen_a AND seen_b THEN
          rt := rt + 1;
          seen_a := FALSE;
          seen_b := FALSE;
          first_sender := NULL;  -- 다음 페어의 첫 발신자는 다음 메시지에서 결정
          unpaired := NULL;
        END IF;
      END LOOP;

      -- 임계치 도달 시 unlock 타임스탬프 (백필은 일괄 now() 로 표시)
      IF rt >= UNLOCK_MAIN THEN
        main_at := now_ts;
      ELSE
        main_at := NULL;
      END IF;
      IF rt >= UNLOCK_ALL THEN
        all_at := now_ts;
      ELSE
        all_at := NULL;
      END IF;

      UPDATE matches
         SET round_trip_count = rt,
             round_trip_unpaired_sender = unpaired,
             main_photo_unlocked_at = main_at,
             all_photos_unlocked_at = all_at
       WHERE id = match_row.id;

    EXCEPTION WHEN OTHERS THEN
      -- per-match sub-transaction 의 실패는 다음 매치 처리를 막지 않는다.
      INSERT INTO match_backfill_failures (match_id, reason)
      VALUES (match_row.id, SQLERRM)
      ON CONFLICT (match_id) DO UPDATE
        SET reason = EXCLUDED.reason,
            failed_at = now();
    END;
  END LOOP;
END $$;
