-- 062_like_reveal_split.sql
-- 별사탕으로 공개한 받은 좋아요 카드의 상대가 사라져 좋아요가 들어가지 않으면 공개에
-- 쓴 별사탕을 돌려준다. 쓴 그대로(무료분은 무료로, 유료분은 유료로) 돌려주려면 공개
-- 한 건에서 무료·유료가 각각 몇 개 나갔는지 알아야 하는데, spend_stars 의 원장 줄에는
-- 어느 공개였는지가 남지 않아 공개 기록에 함께 저장한다.
ALTER TABLE like_reveals
  ADD COLUMN IF NOT EXISTS free_spent SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_spent SMALLINT NOT NULL DEFAULT 0;

-- 차감과 공개 기록을 한 트랜잭션으로. 연타로 이미 공개됐으면(PK 충돌) 차감도 함께
-- 취소된다. 무료분 계산은 spend_stars 와 같은 잠금 안에서 해야 그 사이 잔액이 바뀌지
-- 않는다 (advisory lock 은 같은 트랜잭션에서 다시 잡아도 된다).
CREATE OR REPLACE FUNCTION reveal_like(p_viewer UUID, p_liker UUID, p_stars INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_free INTEGER;
  v_from_free INTEGER;
  v_remaining INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('stars:' || p_viewer::TEXT));
  SELECT b.free INTO v_free FROM star_balance(p_viewer) b;
  v_from_free := LEAST(GREATEST(v_free, 0), p_stars);
  v_remaining := spend_stars(p_viewer, p_stars, 'like_reveal');
  INSERT INTO like_reveals (viewer_id, liker_id, paid, free_spent, paid_spent)
  VALUES (p_viewer, p_liker, true, v_from_free, p_stars - v_from_free);
  RETURN v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION reveal_like(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reveal_like(UUID, UUID, INTEGER) TO service_role;
