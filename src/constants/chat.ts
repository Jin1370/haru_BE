// PhotoAccess 2단계 공개 임계치 (FE/BE/DB 3원 동기화 필수).
//
// 동기화 대상:
// - FE: haru_FE/src/constants/photoAccess.ts (iter 2 이후)
//   (현행 FE는 haru_FE/src/utils/chat.ts 에 동일 상수 보유)
// - DB: haru_BE/supabase/migrations/005_match_photo_access.sql
//       (get_match_summaries_v2 내부 UNLOCK_MAIN / UNLOCK_ALL 리터럴)
//
// 여기 상수는 스웨거/문서 및 테스트 어서션 목적. 실제 unlock 판정은 DB 함수가 수행한다.
export const UNLOCK_MAIN_PHOTO_AT = 5;

// TODO: 기획 확정 필요 (Planner §10 #3). 현행 FE 값을 잠정 승계.
export const UNLOCK_ALL_PHOTOS_AT = 10;
