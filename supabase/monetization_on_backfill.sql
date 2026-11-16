-- monetization_on_backfill.sql — 유료화(MONETIZATION_ENABLED=true) 켜기 직전에 한 번 실행.
-- migrations/ 밖에 두어 마이그레이션 적용 때 함께 돌지 않는다 (켜는 시점 기준으로 실행해야
-- 그때까지 받은 인사가 모두 포함된다). 사용자가 SQL Editor 에서 직접 실행한다.
--
-- 유료화 전(무료 기간)에 받은 인사 탭에서 보던 카드가 켜는 순간 잠기지 않게, 아직 응답하지
-- 않은 받은 인사를 전부 "열림" 으로 기록한다 (사용자 결정 2026-11-16).
-- - paid=true + 차감 0: 무료 카드 24시간 타이머에 잡히지 않고, 환급할 별사탕도 0.
-- - revealed_at = 인사 받은 시각: 받은 인사 탭의 열린 카드 순서가 받은 순서가 된다.
-- - 이미 응답한(스와이프한) 상대는 제외 — 다시보기로 풀린(reset_at) pass 는 미응답으로 본다.
-- 여러 번 실행해도 결과가 같다 (ON CONFLICT DO NOTHING).
-- 순서: mig 059~068 적용 → BE 배포(유료화 OFF) → 이 파일 실행 → MONETIZATION_ENABLED=true.
-- 이 파일 실행과 켜기 사이에 들어온 인사는 잠긴 카드가 된다 — 실행 직후 바로 켠다.

INSERT INTO like_reveals (viewer_id, liker_id, paid, free_spent, paid_spent, revealed_at)
SELECT s.swiped_id, s.swiper_id, true, 0, 0, COALESCE(s.created_at, now())
FROM swipes s
WHERE s.direction = 'like'
  AND NOT EXISTS (
    SELECT 1 FROM swipes r
    WHERE r.swiper_id = s.swiped_id AND r.swiped_id = s.swiper_id AND r.reset_at IS NULL
  )
ON CONFLICT (viewer_id, liker_id) DO NOTHING;
