-- ========== match-roundtrip-realtime ==========
--
-- 원본 014a/b/c/d 를 단일 파일로 통합 (Supabase CLI 가 알파벳 접미사를
-- "<timestamp>_name.sql" 패턴 불일치로 스킵하기 때문). 본 sprint 원래
-- 의도는 점진 적용 + 운영자 게이트(match_backfill_failures empty 검증)
-- 였으나, 새 Supabase 프로젝트 fresh DB 에선 matches 가 0 건이라 백필
-- 실패 가능성이 0 → 단일 트랜잭션으로 안전하게 합칠 수 있다.
--
-- 임계치 (UNLOCK_MAIN=5, UNLOCK_ALL=10) SQL 리터럴은
-- haru_BE/src/constants/chat.ts 의 UNLOCK_MAIN_PHOTO_AT / UNLOCK_ALL_PHOTOS_AT
-- 와 동기화. FE 의 haru_FE/src/constants/photoAccess.ts 도 동일 값.
-- tests/matchRoundtripTrigger.test.ts 가 3-way drift 를 차단한다.

-- ---------- Step A — 컬럼 + 실패 적재 테이블 ----------

ALTER TABLE matches
  ADD COLUMN round_trip_count INTEGER DEFAULT NULL,
  ADD COLUMN round_trip_unpaired_sender UUID DEFAULT NULL,
  ADD COLUMN main_photo_unlocked_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN all_photos_unlocked_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN matches.round_trip_count IS
  'AFTER INSERT on messages 트리거가 유지하는 누적 라운드트립 카운터. '
  'NULL = 백필 미완 또는 백필 실패 (match_backfill_failures 참조). '
  '값 0 = 최소 1건의 메시지가 있으나 페어가 아직 형성되지 않음.';

COMMENT ON COLUMN matches.round_trip_unpaired_sender IS
  '트리거 상태머신 내부값. 직전 페어 완성 이후 첫 발신자 sender_id 를 들고 있다가, '
  '반대편 sender 가 들어오면 round_trip_count + 1 후 NULL 로 복귀. '
  '연속 동일 발신은 unpaired_sender 를 유지(카운트 불변). '
  '단조성 가드 대상 아님 — 운영 핫픽스 허용.';

COMMENT ON COLUMN matches.main_photo_unlocked_at IS
  'round_trip_count >= UNLOCK_MAIN_PHOTO_AT(=5) 도달 시각. 한 번 NOT NULL 이 '
  '되면 BEFORE UPDATE 가드(match_unlock_monotonic_guard)가 NULL 로의 '
  '전이를 차단한다. service role 도 우회 불가.';

COMMENT ON COLUMN matches.all_photos_unlocked_at IS
  'round_trip_count >= UNLOCK_ALL_PHOTOS_AT(=10) 도달 시각. main_photo_unlocked_at '
  '과 동일한 단조성 가드 적용.';

CREATE TABLE match_backfill_failures (
  match_id UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE match_backfill_failures IS
  '백필 per-match TX 실패 적재. fresh DB 환경에선 항상 empty.';

ALTER TABLE match_backfill_failures ENABLE ROW LEVEL SECURITY;

-- ---------- Step B — 백필 (fresh DB 에선 no-op) ----------

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
  last_pair_sender UUID;
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
          first_sender := NULL;
          unpaired := NULL;
        END IF;
      END LOOP;

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
      INSERT INTO match_backfill_failures (match_id, reason)
      VALUES (match_row.id, SQLERRM)
      ON CONFLICT (match_id) DO UPDATE
        SET reason = EXCLUDED.reason,
            failed_at = now();
    END;
  END LOOP;
END $$;

-- ---------- Step C — 트리거 + 단조성 가드 ----------

CREATE OR REPLACE FUNCTION match_roundtrip_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  cur_count INTEGER;
  cur_unpaired UUID;
  cur_main_at TIMESTAMPTZ;
  cur_all_at TIMESTAMPTZ;
  new_count INTEGER;
  new_unpaired UUID;
  new_main_at TIMESTAMPTZ;
  new_all_at TIMESTAMPTZ;
  now_ts TIMESTAMPTZ := now();
BEGIN
  SELECT round_trip_count,
         round_trip_unpaired_sender,
         main_photo_unlocked_at,
         all_photos_unlocked_at
    INTO cur_count, cur_unpaired, cur_main_at, cur_all_at
    FROM matches
   WHERE id = NEW.match_id
   FOR UPDATE;

  new_count := COALESCE(cur_count, 0);

  IF cur_unpaired IS NULL THEN
    new_unpaired := NEW.sender_id;
  ELSIF cur_unpaired = NEW.sender_id THEN
    new_unpaired := cur_unpaired;
  ELSE
    new_count := new_count + 1;
    new_unpaired := NULL;
  END IF;

  IF cur_main_at IS NOT NULL THEN
    new_main_at := cur_main_at;
  ELSIF new_count >= 5 THEN
    new_main_at := now_ts;
  ELSE
    new_main_at := NULL;
  END IF;

  IF cur_all_at IS NOT NULL THEN
    new_all_at := cur_all_at;
  ELSIF new_count >= 10 THEN
    new_all_at := now_ts;
  ELSE
    new_all_at := NULL;
  END IF;

  UPDATE matches
     SET round_trip_count = new_count,
         round_trip_unpaired_sender = new_unpaired,
         main_photo_unlocked_at = new_main_at,
         all_photos_unlocked_at = new_all_at
   WHERE id = NEW.match_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER match_roundtrip_on_insert
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION match_roundtrip_on_insert();

CREATE OR REPLACE FUNCTION match_unlock_monotonic_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.main_photo_unlocked_at IS NOT NULL
     AND NEW.main_photo_unlocked_at IS NULL THEN
    RAISE EXCEPTION 'main_photo_unlocked_at monotonic violation: cannot set NOT NULL -> NULL';
  END IF;

  IF OLD.all_photos_unlocked_at IS NOT NULL
     AND NEW.all_photos_unlocked_at IS NULL THEN
    RAISE EXCEPTION 'all_photos_unlocked_at monotonic violation: cannot set NOT NULL -> NULL';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER match_unlock_monotonic_guard
  BEFORE UPDATE ON matches
  FOR EACH ROW
  EXECUTE FUNCTION match_unlock_monotonic_guard();

-- ---------- Step D — Realtime publication ----------

ALTER PUBLICATION supabase_realtime ADD TABLE matches;
