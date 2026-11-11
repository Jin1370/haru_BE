-- 066_open_playlist_exact.sql
-- 플레이리스트 열기에서 고른 사람을 다 넣지 못하면(같은 계정이 두 기기에서 거의 동시에 다른
-- 칸을 열어 같은 사람이 이미 다른 칸에 들어감) 차감까지 전부 취소한다. 가격은 고른 인원으로
-- 매기므로, 일부만 들어가면 낸 만큼 카드를 못 받는다. 서버가 'cards_changed' 를 받아 차감
-- 없이 409 로 다시 묻는다.
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
  v_inserted INTEGER;
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
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted < cardinality(p_candidates) THEN
    RAISE EXCEPTION 'cards_changed';
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION open_playlist(UUID, DATE, SMALLINT, INTEGER, BOOLEAN, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_playlist(UUID, DATE, SMALLINT, INTEGER, BOOLEAN, UUID[]) TO service_role;
