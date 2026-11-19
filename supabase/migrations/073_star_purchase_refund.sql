-- 스토어 환불 시 별사탕 회수 (RevenueCat CANCELLATION). 구매 줄과 같은 ref(거래 ID)로
-- 'purchase_refund' 마이너스 줄을 넣는다 — (kind, ref) 유니크라 웹훅이 재전송돼도 한 번만.
-- 이미 써 버린 별사탕까지 회수하므로 유료 잔액이 마이너스가 될 수 있다 (spend_stars 는
-- 무료+유료 합계로 검사하므로 다시 충전하기 전까지 그만큼 못 쓴다).

ALTER TABLE star_ledger DROP CONSTRAINT IF EXISTS star_ledger_kind_check;
ALTER TABLE star_ledger ADD CONSTRAINT star_ledger_kind_check
  CHECK (kind IN ('ad', 'purchase', 'like', 'card_reset', 'like_reveal', 'refund', 'nickname', 'purchase_refund'));
