-- 063_discover_playlists.sql
-- 탐색 탭 플레이리스트. 하루 3개(사용자 로컬 날짜), 처음 여는 1개는 무료, 나머지는
-- 별사탕. 여는 순간 서버가 점수순 다음 최대 10명을 고정한다.
-- 대화 신청(like) 안 한 카드는 다음 날 처음 플레이리스트를 조회할 때 pass 로 기록하고
-- 지난 플레이리스트는 지운다 — 남아 있는 행은 항상 "아직 pass 처리 전" 이다.

CREATE TABLE IF NOT EXISTS discover_playlists (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL,
  day        DATE NOT NULL,
  idx        SMALLINT NOT NULL CHECK (idx BETWEEN 0 AND 2),
  stars      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day, idx)
);

CREATE TABLE IF NOT EXISTS discover_playlist_items (
  playlist_id  BIGINT NOT NULL REFERENCES discover_playlists(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  candidate_id UUID NOT NULL,
  position     SMALLINT NOT NULL,
  PRIMARY KEY (playlist_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_user ON discover_playlist_items (user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_candidate ON discover_playlist_items (candidate_id);

ALTER TABLE discover_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE discover_playlist_items ENABLE ROW LEVEL SECURITY;

-- 플레이리스트에서 보낸 대화 신청(like)과 자정 pass 의 출처.
ALTER TABLE swipes DROP CONSTRAINT IF EXISTS swipes_source_check;
ALTER TABLE swipes ADD CONSTRAINT swipes_source_check
  CHECK (source IN ('discover', 'likes', 'recycled', 'playlist'));

-- 열기 = (별사탕 차감) + 플레이리스트 + 카드를 한 트랜잭션으로.
-- p_first: 무료로 여는 첫 플레이리스트. 그사이 다른 기기에서 오늘 플레이리스트를 이미
-- 열었으면 'not_first' 로 거절한다 (무료 2번 방지).
-- 같은 칸을 동시에 두 번 열면 UNIQUE 위반으로 전체가 취소된다(차감 포함).
-- 이미 오늘 다른 플레이리스트에 든 사람은 넣지 않는다 (동시에 두 칸을 연 경합 대비).
CREATE OR REPLACE FUNCTION open_playlist(
  p_user UUID,
  p_day DATE,
  p_idx SMALLINT,
  p_stars INTEGER,
  p_first BOOLEAN,
  p_candidates UUID[]
)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  v_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('stars:' || p_user::TEXT));

  IF p_first AND EXISTS (SELECT 1 FROM discover_playlists WHERE user_id = p_user AND day = p_day) THEN
    RAISE EXCEPTION 'not_first';
  END IF;

  IF p_stars > 0 THEN
    PERFORM spend_stars(p_user, p_stars, 'card_reset');
  END IF;

  INSERT INTO discover_playlists (user_id, day, idx, stars)
  VALUES (p_user, p_day, p_idx, p_stars)
  RETURNING id INTO v_id;

  INSERT INTO discover_playlist_items (playlist_id, user_id, candidate_id, position)
  SELECT v_id, p_user, c.id, c.ord
  FROM unnest(p_candidates) WITH ORDINALITY AS c(id, ord)
  WHERE NOT EXISTS (
    SELECT 1 FROM discover_playlist_items i WHERE i.user_id = p_user AND i.candidate_id = c.id
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION open_playlist(UUID, DATE, SMALLINT, INTEGER, BOOLEAN, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_playlist(UUID, DATE, SMALLINT, INTEGER, BOOLEAN, UUID[]) TO service_role;
