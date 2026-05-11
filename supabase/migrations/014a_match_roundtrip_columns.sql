-- ========== match-roundtrip-realtime: Step A — 컬럼 추가 ==========
--
-- 본 마이그레이션은 4단계(014a/b/c/d)로 분할된 match-roundtrip-realtime
-- sprint 의 첫 단계로, 트리거/백필을 적용하기 위한 컬럼 + 실패 적재
-- 테이블만 선행 추가한다. 실제 백필은 014b, 트리거 활성화는 014c,
-- Realtime publication 확장은 014d.
--
-- 신규 컬럼은 모두 **DEFAULT NULL** — 014b 백필이 완료될 때까지
-- 기존 행은 NULL 상태로 남는다. NULL 은 "백필 미완 매치" 식별자로
-- 사용되며, 014c 트리거 활성화 사전 조건(`match_backfill_failures`
-- empty 검증) 통과 후에만 비-NULL 로 채워진다.
--
-- 005 mig 의 get_match_summaries_v2 RPC 는 fallback 채널로 남겨두고
-- 본 sprint 에서는 삭제/수정하지 않는다 (forward-only).

ALTER TABLE matches
  ADD COLUMN round_trip_count INTEGER DEFAULT NULL,
  ADD COLUMN round_trip_unpaired_sender UUID DEFAULT NULL,
  ADD COLUMN main_photo_unlocked_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN all_photos_unlocked_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN matches.round_trip_count IS
  'AFTER INSERT on messages 트리거가 유지하는 누적 라운드트립 카운터. '
  'NULL = 014b 백필 미완 또는 백필 실패 (match_backfill_failures 참조). '
  '값 0 = 최소 1건의 메시지가 있으나 페어가 아직 형성되지 않음.';

COMMENT ON COLUMN matches.round_trip_unpaired_sender IS
  '트리거 상태머신 내부값. 직전 페어 완성 이후 첫 발신자 sender_id 를 들고 있다가, '
  '반대편 sender 가 들어오면 round_trip_count + 1 후 NULL 로 복귀. '
  '연속 동일 발신은 unpaired_sender 를 유지(카운트 불변). '
  '단조성 가드 대상 아님 — 운영 핫픽스 허용.';

COMMENT ON COLUMN matches.main_photo_unlocked_at IS
  'round_trip_count >= UNLOCK_MAIN_PHOTO_AT(=5) 도달 시각. 한 번 NOT NULL 이 '
  '되면 BEFORE UPDATE 가드(014c match_unlock_monotonic_guard)가 NULL 로의 '
  '전이를 차단한다. service role 도 우회 불가.';

COMMENT ON COLUMN matches.all_photos_unlocked_at IS
  'round_trip_count >= UNLOCK_ALL_PHOTOS_AT(=10) 도달 시각. main_photo_unlocked_at '
  '과 동일한 단조성 가드 적용.';

-- 백필 per-match sub-transaction 실패 적재 테이블.
-- 014b 의 DO 블록이 EXCEPTION 시 본 테이블에 row 를 남기고 다음 매치로
-- 진행한다. 014c 트리거는 본 테이블이 empty 임을 운영자가 확인한 후에
-- 적용한다 (단일 트랜잭션이 아닌 운영 게이트).
CREATE TABLE match_backfill_failures (
  match_id UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE match_backfill_failures IS
  '014b 백필 per-match TX 실패 적재. 014c 트리거 활성화 사전 조건: '
  'SELECT count(*) FROM match_backfill_failures = 0.';

-- RLS: 본 테이블은 운영자(SQL editor / service_role) 전용. anon /
-- authenticated 키로는 일절 접근 불가. service_role 은 Supabase 정책상
-- 자동으로 RLS 를 우회하므로 BE 의 014b DO 블록 및 운영자 점검 쿼리는
-- 정상 동작한다. 정책을 만들지 않으면 RLS enable 만으로 deny-all 효과.
ALTER TABLE match_backfill_failures ENABLE ROW LEVEL SECURITY;
