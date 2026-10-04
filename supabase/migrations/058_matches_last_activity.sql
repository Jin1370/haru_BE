-- 058: 채팅 목록을 "마지막 대화 순" 으로 서버에서 자르기 위한 정렬 키.
--
-- 기존 GET /api/matches 는 matches.created_at DESC 로 페이지를 자르고 FE 가
-- last_message 기준으로 재정렬했다 → 오래전에 맺었지만 최근 대화한 방이 첫
-- 페이지에서 빠졌다. last_activity_at = max(매치 생성, 마지막 메시지) 를 컬럼으로
-- 두고 BE 가 이 키로 정렬 + 커서 페이지네이션한다.
--
-- NOT NULL + 매치 생성 시각으로 시작 → 메시지 없는 매치도 정렬 키를 가진다.
-- 수신자에게 숨겨지는 메시지(failed 등)도 갱신에 포함된다 — 순서가 살짝 위로
-- 올라갈 뿐 누락은 없다.

ALTER TABLE matches ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

UPDATE matches m
SET last_activity_at = GREATEST(
  m.created_at,
  COALESCE((SELECT max(created_at) FROM messages WHERE match_id = m.id), m.created_at)
)
WHERE last_activity_at IS NULL;

ALTER TABLE matches ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE matches ALTER COLUMN last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matches_user1_activity ON matches (user1_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_user2_activity ON matches (user2_id, last_activity_at DESC);

-- 001 의 단일 컬럼 인덱스는 위 복합 인덱스의 선두 컬럼과 같아 중복. 지우면
-- 메시지마다 갱신되는 인덱스 수가 이 마이그레이션 전과 같아진다.
DROP INDEX IF EXISTS idx_matches_user1;
DROP INDEX IF EXISTS idx_matches_user2;

-- 메시지마다 matches 를 이미 UPDATE 하는 왕복 트리거(028 정의)에 last_activity_at
-- 한 줄만 얹는다. 별도 트리거로 두면 메시지당 matches UPDATE 와 Realtime 이벤트가
-- 2 배가 된다. 아래 본문은 028 과 동일, 마지막 UPDATE 의 SET 에 한 줄 추가뿐.
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
  ELSIF new_count >= 10 THEN
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
         all_photos_unlocked_at = new_all_at,
         last_activity_at = GREATEST(last_activity_at, NEW.created_at)
   WHERE id = NEW.match_id;

  RETURN NEW;
END;
$$;
