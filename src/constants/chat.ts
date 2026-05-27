// PhotoAccess 공개 임계치 (FE/BE/DB 3원 동기화 필수).
//
// 동기화 대상:
// - FE: haru_FE/src/constants/photoAccess.ts
// - DB: haru_BE/supabase/migrations/028_profile_photos_conversion.sql
//       (match_roundtrip_on_insert 트리거의 `new_count >= 10` 리터럴 + v4 RPC 의
//        UNLOCK_ALL CONSTANT — single source of truth)
//
// photo-watercolor-pipeline sprint (2026-05-27):
//   * 옛 5/10 단계 → 10 단일 단계로 단순화.
//   * 디스커버에서 변환본을 노출하므로 5회 milestone 의 "원본 메인 unlock" 의미가
//     사라짐. main_photo_unlocked / all_photos_unlocked 가 항상 동일 값 (10 도달 시
//     동시 unlock).
//   * UNLOCK_MAIN_PHOTO_AT 상수는 보존 (FE wire 호환 + 의미 변경: rt>=10 시 main 도
//     unlock 되는 단일 unlock 시점).
//
// 여기 상수는 스웨거/문서 및 테스트 어서션 목적. 실제 unlock 판정은 DB 트리거가 수행한다.
export const UNLOCK_MAIN_PHOTO_AT = 10;

export const UNLOCK_ALL_PHOTOS_AT = 10;
