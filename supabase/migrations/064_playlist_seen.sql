-- 064_playlist_seen.sql
-- (1) 플레이리스트에서 실제로 화면에 나온 카드. 자정에는 본 카드만 pass 로 기록하고,
--     안 본 카드의 사람은 다시 후보로 돌아간다.
ALTER TABLE discover_playlist_items ADD COLUMN IF NOT EXISTS seen BOOLEAN NOT NULL DEFAULT false;

-- (2) 탐색 카드 n장 구매(mig 060)는 플레이리스트 구매(mig 063 open_playlist)로 대체됐다.
--     강제 업데이트로 옛 앱이 사라져 card-reset 라우트를 지웠으므로 테이블과 함수도 지운다.
DROP FUNCTION IF EXISTS buy_cards(UUID, INTEGER, INTEGER);
DROP TABLE IF EXISTS card_purchases;
