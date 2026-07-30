-- 신규 user_preferences 행의 성별 선호 기본값을 {male,female,other} → {male,female} 로.
--
-- 이 DEFAULT 는 preferred_genders 를 생략한 INSERT 에서만 발화한다 —
-- `/api/preferences` PUT 은 항상 값을 채우지만(zod default),
-- `/api/notifications/preferences` PATCH 의 upsert 는 알림 토글만 보내므로
-- 그 경로로 행이 먼저 생기면 이 DEFAULT 가 쓰인다.
--
-- 기존 행은 건드리지 않는다 (사용자가 실제로 고른 값일 수 있음).
-- BE 기본값 3곳과 동일해야 한다: src/schemas/preference.ts (zod default),
-- src/routes/preference.ts (GET 폴백), haru_FE setup/preferences.tsx (초기 상태).

ALTER TABLE public.user_preferences
  ALTER COLUMN preferred_genders SET DEFAULT '{male,female}';
