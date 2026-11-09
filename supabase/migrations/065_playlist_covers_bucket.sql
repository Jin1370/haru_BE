-- playlist-covers: 탐색 탭 플레이리스트 LP 커버 사진 (장식용, 사용자 데이터 아님).
-- 앱이 날짜·칸 번호로 {n}.jpg 를 골라 공개 URL 로 직접 읽는다 — public 버킷.
-- 파일은 마이그가 아니라 수동 업로드 (원본: 운영자 로컬 lp커버/업로드 폴더, 0.jpg ~ N-1.jpg).
-- 장 수를 바꾸면 haru_FE discover.tsx 의 COVER_COUNT 도 같이 바꾼다.
INSERT INTO storage.buckets (id, name, public)
VALUES ('playlist-covers', 'playlist-covers', true)
ON CONFLICT (id) DO NOTHING;
