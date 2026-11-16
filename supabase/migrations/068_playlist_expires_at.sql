-- 068_playlist_expires_at.sql
-- 플레이리스트가 끝나는 시각을 열 때 정해 저장한다. 그동안은 요청마다 휴대폰 시간대로
-- "오늘" 을 다시 계산해서, 시간대가 바뀌면(여행·설정 변경) 연 플레이리스트가 자정 전에
-- 다시 잠기거나(서쪽) 일찍 초기화됐다(동쪽). 이제 오늘 플레이리스트 = 아직 끝나지 않은 것.
-- 같은 날 나중에 여는 칸은 먼저 연 칸의 day·expires_at 을 그대로 쓴다 (BE).

ALTER TABLE discover_playlists ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- 기존 행: 한국·일본 자정 기준으로 채운다.
UPDATE discover_playlists
  SET expires_at = (day + 1)::timestamp AT TIME ZONE 'Asia/Seoul'
  WHERE expires_at IS NULL;
ALTER TABLE discover_playlists ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discover_playlists_user_expires ON discover_playlists (user_id, expires_at);

DROP FUNCTION IF EXISTS open_playlist(UUID, DATE, SMALLINT, INTEGER, BOOLEAN, UUID[]);

-- 066 과 같고 p_expires 만 추가.
CREATE OR REPLACE FUNCTION open_playlist(
  p_user UUID,
  p_day DATE,
  p_expires TIMESTAMPTZ,
  p_idx SMALLINT,
  p_stars INTEGER,
  p_first BOOLEAN,
  p_candidates UUID[]
)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  v_id BIGINT;
  v_inserted INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('stars:' || p_user::TEXT));

  IF p_first AND EXISTS (SELECT 1 FROM discover_playlists WHERE user_id = p_user AND expires_at > now()) THEN
    RAISE EXCEPTION 'not_first';
  END IF;

  IF p_stars > 0 THEN
    PERFORM spend_stars(p_user, p_stars, 'card_reset');
  END IF;

  INSERT INTO discover_playlists (user_id, day, idx, stars, expires_at)
  VALUES (p_user, p_day, p_idx, p_stars, p_expires)
  RETURNING id INTO v_id;

  INSERT INTO discover_playlist_items (playlist_id, user_id, candidate_id, position)
  SELECT v_id, p_user, c.id, c.ord
  FROM unnest(p_candidates) WITH ORDINALITY AS c(id, ord)
  WHERE NOT EXISTS (
    SELECT 1 FROM discover_playlist_items i WHERE i.user_id = p_user AND i.candidate_id = c.id
  );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted < cardinality(p_candidates) THEN
    RAISE EXCEPTION 'cards_changed';
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION open_playlist(UUID, DATE, TIMESTAMPTZ, SMALLINT, INTEGER, BOOLEAN, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_playlist(UUID, DATE, TIMESTAMPTZ, SMALLINT, INTEGER, BOOLEAN, UUID[]) TO service_role;
