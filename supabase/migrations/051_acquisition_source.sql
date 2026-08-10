-- 유입 경로 (앱을 어떻게 알게 되었는지). 가입 완료 후 1회 필수 응답, 응답 뒤 수정 불가
-- (BE 라우트가 `.is('acquisition_source', null)` 로 write-once 강제).
-- 값: friend | app_store | web_search | sns:instagram|x|youtube|facebook|threads|tiktok
-- SNS 세부 플랫폼은 `sns:` prefix 로 같은 컬럼에 담는다 (집계는 LIKE 'sns:%').
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS acquisition_source TEXT;
