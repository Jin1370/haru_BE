-- discover-like-limit sprint: 하루 15 like 예산 카운트/캡의 단일 진실원.
-- direction='like' AND swipe 시점 reciprocal 부재(=매치 미완성)일 때만 true.
-- quota count 와 POST /swipe 캡 count 가 이 컬럼 하나를 공유해 정의 불일치를 원천 차단.
ALTER TABLE swipes
  ADD COLUMN counts_toward_limit BOOLEAN NOT NULL DEFAULT false;

-- 백필: 과거 like 중 "그 시점 reciprocal이 없던" 투기적 like만 예산 소모로 표시.
-- 완성 like(상대가 먼저 like 후 되받은)는 created_at 비교로 exempt(=false 유지).
-- pass 행은 default false 유지. 베타 소량 데이터라 비용 무시 가능.
UPDATE swipes s
SET counts_toward_limit = true
WHERE s.direction = 'like'
  AND NOT EXISTS (
    SELECT 1 FROM swipes r
    WHERE r.swiper_id = s.swiped_id
      AND r.swiped_id = s.swiper_id
      AND r.direction = 'like'
      AND r.created_at <= s.created_at
  );

-- 핫패스(quota + 캡) 전용 부분 인덱스. 기존 idx_swipes_pair(swiper_id, swiped_id)
-- 는 created_at 범위/counts 필터를 못 살린다. swiper_id + 오늘 범위 count 를 직접 지원.
CREATE INDEX IF NOT EXISTS idx_swipes_budget_likes
  ON swipes (swiper_id, created_at)
  WHERE counts_toward_limit = true;
