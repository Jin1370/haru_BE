-- ========== match-roundtrip-realtime: Step C — 트리거 + 단조성 가드 ==========
--
-- 운영자 게이트:
--   014b 적용 후 `SELECT count(*) FROM match_backfill_failures` = 0 을
--   검증한 다음에만 본 014c 를 적용한다. 잔존 실패 매치가 있으면
--   해당 매치의 round_trip_count 가 NULL 인 채로 트리거가 활성화되어
--   첫 INSERT 시 첫 페어부터 1로 시작하는 오집계가 발생한다.
--
-- 임계치 (UNLOCK_MAIN=5, UNLOCK_ALL=10) SQL 리터럴은
-- haru_BE/src/constants/chat.ts 의 UNLOCK_MAIN_PHOTO_AT / UNLOCK_ALL_PHOTOS_AT
-- 와 동기화. FE 의 haru_FE/src/constants/photoAccess.ts 도 동일 값.
-- tests/matchRoundtripTrigger.test.ts 가 3-way drift 를 차단한다.
--
-- 1) AFTER INSERT on messages — match_roundtrip_on_insert
-- 2) BEFORE UPDATE on matches — match_unlock_monotonic_guard

-- 1) AFTER INSERT on messages
--
-- 동시 INSERT 안전성: messages INSERT 흐름에서 동일 matches 행을 외부에서
-- 잠그는 경로가 없으므로 SELECT ... FOR UPDATE 단일 락이면 충분.
-- 같은 match_id 의 동시 INSERT 2건은 자연 직렬화된다 (사람 입력 ms 간격에
-- 두 발신자가 동시에 누르는 경우만 1회 대기 — 무시할 수 있는 latency).
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

  -- COALESCE NULL → 0 정책: 014b 백필 실패로 NULL 인 매치라도 트리거가
  -- 활성화된 시점부터는 0 기반으로 정상 누적. 14b empty 게이트가 1차
  -- 방어선이며 본 줄은 fail-safe.
  new_count := COALESCE(cur_count, 0);

  IF cur_unpaired IS NULL THEN
    -- 직전 페어 완성 직후 또는 매치 최초 메시지 — 첫 발신자 기록만
    new_unpaired := NEW.sender_id;
  ELSIF cur_unpaired = NEW.sender_id THEN
    -- 연속 동일 발신자 — 카운트 불변, unpaired 유지
    new_unpaired := cur_unpaired;
  ELSE
    -- 반대편 발신자 — 페어 1 완성
    new_count := new_count + 1;
    new_unpaired := NULL;
  END IF;

  -- 단조성: 이미 NOT NULL 이면 그대로 유지. NULL 이고 임계치 도달 시에만 now().
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

-- 2) BEFORE UPDATE on matches — 단조성 가드
--
-- *_unlocked_at 컬럼은 한 번 NOT NULL 이 되면 NULL 로 되돌릴 수 없다.
-- service role 도 우회 불가 — 운영 핫픽스로 강제 잠금 복구가 필요하면
-- 별도 마이그레이션으로 가드 일시 해제 후 재설치.
--
-- round_trip_count / round_trip_unpaired_sender 는 가드 대상 **아님**
-- (운영 핫픽스 허용. 상태머신 내부값).
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
