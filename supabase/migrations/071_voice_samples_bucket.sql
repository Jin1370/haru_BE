-- voice-samples: 목소리 등록 원본 녹음 보관 (주기적 클론 재생성 대비).
--
-- 2026-05 voice-sample-removal (mig 023) 에서 원본을 즉시 폐기하던 정책을 뒤집는다 —
-- 목소리 클론을 나중에 다시 만들어야 할 때 (제공사 교체·모델 갱신) 사용자에게 재녹음을
-- 요구하지 않기 위해. 생체정보라 노출 리스크가 가장 큰 데이터:
--   * 버킷 **private** + storage.objects 정책 0개 → anon/authenticated 는 읽기·쓰기 모두
--     불가, service_role(BE) 만 접근. 서명 URL 도 발급하지 않는다 (재생 용도 없음).
--   * 경로 `{userId}/sample` 고정 — 재등록 시 덮어써 사람당 최신 1개만 남긴다.
--   * 탈퇴 시 purgeUserFolders 가 폴더째 삭제.
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-samples', 'voice-samples', false)
ON CONFLICT (id) DO UPDATE SET public = false;
