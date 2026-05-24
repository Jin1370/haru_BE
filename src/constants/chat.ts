// PhotoAccess 2단계 공개 임계치 (FE/BE/DB 3원 동기화 필수).
//
// 동기화 대상:
// - FE: haru_FE/src/constants/photoAccess.ts
// - DB: haru_BE/supabase/migrations/014_match_roundtrip.sql
//       (AFTER INSERT 트리거의 `new_count >= N` 리터럴 — single source of truth)
//
// 여기 상수는 스웨거/문서 및 테스트 어서션 목적. 실제 unlock 판정은 DB 트리거가 수행한다.
export const UNLOCK_MAIN_PHOTO_AT = 5;

// TODO: 기획 확정 필요 (Planner §10 #3). 현행 FE 값을 잠정 승계.
export const UNLOCK_ALL_PHOTOS_AT = 10;
