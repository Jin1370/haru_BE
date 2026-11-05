-- 061_like_card_pins.sql
-- 받은 좋아요의 맨 앞 카드(무료 또는 잠긴 카드) 고정. 정렬이 점수순이라 고정하지
-- 않으면 점수 높은 새 좋아요가 앞으로 끼어든다. 뷰어당 1행이고, 고정된 카드가
-- 넘겨지거나 공개되면 다음 조회 때 새 카드로 덮어쓴다.
CREATE TABLE IF NOT EXISTS like_card_pins (
  viewer_id UUID PRIMARY KEY,
  liker_id  UUID NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE like_card_pins ENABLE ROW LEVEL SECURITY;
