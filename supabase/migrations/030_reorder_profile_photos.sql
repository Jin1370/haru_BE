-- ========== photo-reorder-no-reconvert sprint ==========
--
-- 재변환 없이 profile_photos.position 만 원자적으로 재배치하는 RPC.
--
-- 배경:
--   * 현행 FE reorder/메인설정은 전 사진을 삭제 후 재업로드 → gpt-image-2 워터컬러
--     재변환($ + 25~75초 변환 + 그 동안 디스커버 메인 비어 사용자 탈락). 또한
--     재업로드 중 rejected/failed 면 슬롯 영구 손실.
--   * 본 RPC 는 기존 row 의 position 만 바꾼다 — 새 사진을 만들지 않으므로 모더레이션
--     게이트 우회 경로 자체가 없다 (rejected 사진은 어느 position 에 가도 status 가
--     rejected 라 노출 안 됨).
--
-- 안전 제약 (전략가 GO): position 0(메인)은 status='ready' 강제. 비-ready/rejected 를
--   노출 슬롯(특히 메인)으로 끌어올리는 뒷문 차단. 1~4 슬롯의 비-ready 는 ready 필터가
--   노출을 막고 (자기 손해라 악용 인센티브 0) 추가 차단 불필요 (YAGNI).
--
-- UNIQUE(user_id, position) 즉시 검사(NOT DEFERRABLE) 회피:
--   순환 재배치(예 0↔1 swap)를 단일/순차 UPDATE 로 하면 중간 상태에서 두 row 가 같은
--   position 을 갖는 순간 23505. plpgsql 함수의 단일 트랜잭션 안에서
--     1단계: 대상 row 의 position 을 음수 영역(position - 1000)으로 일괄 UPDATE
--            (양수 기존값과 안 겹치고 동일 사용자 내 임시 유니크 보장)
--     2단계: order[i] 의 id 를 position i-1 로 UPDATE
--   로 처리 → 중간 실패 시 자동 롤백 (원자성).
--
-- 권한: service_role 만 (mig 027/028 의 RPC 정책과 동일). BE 가 service_role client 로
--   호출하므로 RLS 우회 정합. 함수 내부 user_id = p_user_id 가드가 소유권 경계.
--
-- forward-only. mig 001~029 수정 금지.

CREATE OR REPLACE FUNCTION reorder_profile_photos(
  p_user_id UUID,
  p_order   UUID[]          -- 1-based array. order[1] → position 0 (메인).
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  existing_count INTEGER;
  order_count    INTEGER := array_length(p_order, 1);
  first_status   TEXT;
BEGIN
  -- 1) 완전성: order 가 사용자의 모든 row 와 정확히 일치(개수).
  SELECT COUNT(*) INTO existing_count
    FROM profile_photos WHERE user_id = p_user_id;
  IF order_count IS DISTINCT FROM existing_count THEN
    RAISE EXCEPTION 'order_count_mismatch' USING ERRCODE = 'check_violation';
  END IF;

  -- 2) 소유권 + 존재: order 의 모든 id 가 본인 row 인지.
  IF EXISTS (
    SELECT 1 FROM unnest(p_order) AS oid
     WHERE NOT EXISTS (
       SELECT 1 FROM profile_photos pp
        WHERE pp.id = oid AND pp.user_id = p_user_id
     )
  ) THEN
    RAISE EXCEPTION 'photo_not_owned' USING ERRCODE = 'check_violation';
  END IF;

  -- 3) 안전 제약: position 0 으로 갈 사진(order[1])은 status='ready' 여야 함.
  SELECT status INTO first_status
    FROM profile_photos
   WHERE id = p_order[1] AND user_id = p_user_id;
  IF first_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'main_photo_not_ready' USING ERRCODE = 'check_violation';
  END IF;

  -- 4) 1단계: 임시 음수 오프셋으로 UNIQUE 충돌 회피.
  UPDATE profile_photos
     SET position = position - 1000, updated_at = now()
   WHERE user_id = p_user_id;

  -- 5) 2단계: order 인덱스 = 새 position (0-based).
  FOR i IN 1 .. order_count LOOP
    UPDATE profile_photos
       SET position = i - 1, updated_at = now()
     WHERE id = p_order[i] AND user_id = p_user_id;
  END LOOP;
END;
$$;

-- 권한: service_role 만 (mig 028 의 v4 RPC 정책과 동일).
REVOKE EXECUTE ON FUNCTION reorder_profile_photos(UUID, UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reorder_profile_photos(UUID, UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION reorder_profile_photos(UUID, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION reorder_profile_photos(UUID, UUID[]) TO service_role;
