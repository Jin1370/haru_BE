-- 강제 업데이트 전까지 옛 서버(haru-be, 유료화 OFF)와 새 서버(유료화 ON)가 같은 DB 를 쓴다.
-- 그 기간에 새 앱 사용자만 구분하는 표시 2개.

-- 1) 새 서버가 등록한 푸시 토큰 = 새 앱이 설치되고 한 번 이상 열린 기기.
--    플레이리스트 알림은 이 토큰에만 보낸다 (옛 앱은 플레이리스트가 없다).
--    옛 서버의 토큰 upsert 는 이 컬럼을 안 보내 값이 그대로 남는다.
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS supports_playlist BOOLEAN NOT NULL DEFAULT false;

-- 2) 옛 앱에서 무료로 보던 받은 인사를 새 앱에서 처음 볼 때 열어 둔 시각.
--    NULL = 아직 안 함. 새 서버에서 가입한 사람은 가입 때 바로 채운다 (열어 줄 게 없음).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS likes_backfilled_at TIMESTAMPTZ;

-- 사람 단위로 한 번만: 아직 응답 안 한 받은 인사를 전부 열림으로 기록한다.
-- paid=true + 차감 0 → 무료 카드 24시간 타이머에 안 잡히고 환급할 별사탕도 0.
-- revealed_at = 인사 받은 시각 → 열린 카드 순서가 받은 순서.
-- 이미 응답한 상대는 제외 (다시보기로 풀린 reset_at pass 는 미응답으로 본다).
-- 동시에 두 번 불려도 ON CONFLICT DO NOTHING + 조건부 UPDATE 라 결과가 같다.
CREATE OR REPLACE FUNCTION open_prior_likes(p_viewer UUID) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_viewer AND likes_backfilled_at IS NULL) THEN
    RETURN;
  END IF;

  INSERT INTO like_reveals (viewer_id, liker_id, paid, free_spent, paid_spent, revealed_at)
  SELECT s.swiped_id, s.swiper_id, true, 0, 0, COALESCE(s.created_at, now())
  FROM swipes s
  WHERE s.swiped_id = p_viewer
    AND s.direction = 'like'
    AND NOT EXISTS (
      SELECT 1 FROM swipes r
      WHERE r.swiper_id = s.swiped_id AND r.swiped_id = s.swiper_id AND r.reset_at IS NULL
    )
  ON CONFLICT (viewer_id, liker_id) DO NOTHING;

  UPDATE profiles SET likes_backfilled_at = now()
  WHERE id = p_viewer AND likes_backfilled_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION open_prior_likes(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_prior_likes(UUID) TO service_role;
