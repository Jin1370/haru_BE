-- ========== match-roundtrip-realtime: Step D — Realtime publication ==========
--
-- matches 테이블을 supabase_realtime publication 에 추가하여 FE 가
-- 014c 트리거가 갱신한 round_trip_count / *_unlocked_at 변화를 실시간
-- 수신할 수 있게 한다. RLS (user1_id=auth.uid() OR user2_id=auth.uid()) 는
-- Realtime 에서도 자동 적용되므로 타 사용자 매치 UPDATE 는 수신되지 않는다.

ALTER PUBLICATION supabase_realtime ADD TABLE matches;
