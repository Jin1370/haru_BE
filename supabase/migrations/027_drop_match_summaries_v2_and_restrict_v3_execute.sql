-- ========== mig 025: dead v2 RPC DROP + v3 EXECUTE 권한 회수 ==========
--
-- 변경 사항:
--   1) read-at-removal-list-mask sprint (mig 018) 이후 dead 상태인
--      get_match_summaries_v2 함수 DROP. routes/match.ts:111 은 v3 단일 사용,
--      v2 호출처는 활성 코드에 0건 (주석/문서/테스트 컨텍스트만 참조).
--   2) get_match_summaries_v3 의 EXECUTE 권한을 PUBLIC/anon/authenticated 에서
--      회수하고 service_role 만 명시 GRANT. BE 라우트가 service_role key 로만
--      호출하므로 anon/authenticated 노출 표면 제거 — read-at-removal-list-mask
--      sprint 의 "별도 cleanup 카드" 항목 (anon/authenticated 에 GRANT EXECUTE
--      PUBLIC 노출은 v2 도 동일하던 기존 위협) 정리.
--
-- 참고:
--   * v1 (get_match_summaries) 는 mig 005 주석의 "롤백 대비 유지(삭제 금지)"
--     원칙대로 보존.
--   * v3 는 LANGUAGE plpgsql STABLE (INVOKER default). service_role 은 RLS
--     우회 권한 보유 — EXECUTE 회수 후에도 BE 정상 동작.
--
-- 적용:
--   사용자가 Supabase Dashboard SQL Editor 로 본 파일 실행. 적용 전 v2 함수
--   호출이 0건임을 한 번 더 확인 (이미 코드 grep 으로 검증됨).

DROP FUNCTION IF EXISTS get_match_summaries_v2(UUID[], UUID);

REVOKE EXECUTE ON FUNCTION get_match_summaries_v3(UUID[], UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_match_summaries_v3(UUID[], UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION get_match_summaries_v3(UUID[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_match_summaries_v3(UUID[], UUID) TO service_role;
