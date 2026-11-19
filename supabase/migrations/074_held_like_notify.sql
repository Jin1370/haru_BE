-- 플레이리스트에 든 사람이 보낸 인사는 받은 인사 탭에서 숨겨져 알림을 바로 보내지 않는다.
-- 그 인사에 "알림 보낼 시각"(그 플레이리스트가 끝나는 현지 새벽 5시 + 4시간 = 오전 9시)을
-- 적어 두고, 서버 작업이 그때 받은 인사 탭에 실제로 보이면 알림을 보낸다.
ALTER TABLE swipes ADD COLUMN IF NOT EXISTS like_notify_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_swipes_like_notify_at
  ON swipes (like_notify_at)
  WHERE like_notify_at IS NOT NULL;
