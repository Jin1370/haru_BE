-- 닉네임 변경에 별사탕 차감 (유료화 ON 일 때만, BE 가 판단).
-- 차감과 이름 변경을 한 트랜잭션으로 묶어, 이름이 이미 쓰이고 있으면(23505) 차감도 취소된다.

ALTER TABLE star_ledger DROP CONSTRAINT IF EXISTS star_ledger_kind_check;
ALTER TABLE star_ledger ADD CONSTRAINT star_ledger_kind_check
  CHECK (kind IN ('ad', 'purchase', 'like', 'card_reset', 'like_reveal', 'refund', 'nickname'));

CREATE OR REPLACE FUNCTION change_display_name(p_user UUID, p_name TEXT, p_stars INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_current TEXT;
BEGIN
  -- 행을 잠그고 지금 이름을 본다. 거의 동시에 온 같은 요청(연타·응답 유실 후 재시도)은
  -- 앞 요청이 끝날 때까지 기다렸다가 이미 바뀐 이름을 보고 차감 없이 끝난다.
  SELECT display_name INTO v_current FROM profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  IF v_current = p_name THEN
    RETURN 0;  -- 이미 그 이름: 차감 없음
  END IF;
  PERFORM spend_stars(p_user, p_stars, 'nickname');
  UPDATE profiles SET display_name = p_name, updated_at = now() WHERE id = p_user;
  RETURN p_stars;  -- 차감한 개수
END;
$$;

REVOKE ALL ON FUNCTION change_display_name(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION change_display_name(UUID, TEXT, INTEGER) TO service_role;
