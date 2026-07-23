-- deletion_stats 에 국가/성별 스냅샷 추가.
--
-- 이탈 분석을 "어느 세그먼트가 일찍 나가는지" 축으로 자를 수 있게 한다.
-- (anonymize 는 profiles 의 nationality/gender 를 지우지 않지만, 스냅샷 테이블
-- 단독으로 조회 가능하게 비정규화.) 043 을 이미 적용한 환경에서도 안전하도록
-- ADD COLUMN IF NOT EXISTS — 043 미적용 환경은 043 → 044 순서로 실행.

ALTER TABLE public.deletion_stats
  ADD COLUMN IF NOT EXISTS nationality TEXT,
  ADD COLUMN IF NOT EXISTS gender TEXT;
