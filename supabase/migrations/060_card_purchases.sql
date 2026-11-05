-- 060_card_purchases.sql
-- 탐색 카드 추가 구매 기록. 가격이 장수에 비례하게 바뀌면서(별사탕 2개 = 3~5장)
-- star_ledger 합계만으로는 산 장수를 복원할 수 없어 장수를 따로 남긴다.
-- 오늘 카드 한도 = 무료 10 + 오늘 구매한 장수.
CREATE TABLE IF NOT EXISTS card_purchases (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL,
  cards      INTEGER NOT NULL CHECK (cards > 0),
  stars      INTEGER NOT NULL CHECK (stars > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_purchases_user_created
  ON card_purchases (user_id, created_at);

ALTER TABLE card_purchases ENABLE ROW LEVEL SECURITY;

-- 차감과 기록을 한 트랜잭션으로 묶는다. 잔액 부족이면 spend_stars 가 예외를 던져
-- 기록도 남지 않는다.
CREATE OR REPLACE FUNCTION buy_cards(p_user UUID, p_cards INTEGER, p_stars INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  v_remaining := spend_stars(p_user, p_stars, 'card_reset');
  INSERT INTO card_purchases (user_id, cards, stars) VALUES (p_user, p_cards, p_stars);
  RETURN v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION buy_cards(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION buy_cards(UUID, INTEGER, INTEGER) TO service_role;
