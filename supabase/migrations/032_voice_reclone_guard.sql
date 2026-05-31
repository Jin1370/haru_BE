-- 재녹음(voice clone 재생성) 레이트리밋 가드용 카운터.
-- POST /api/voice/clone 의 "재등록" 경로만 카운트(최초 등록 제외). 고정 윈도우
-- (env.voice.recloneWindowDays, 기본 30일) 동안 env.voice.recloneMonthlyCap(기본 3)
-- 회를 초과하면 429. ElevenLabs 의 월간 voice operations 쿼터(계정 공유 풀)를 1인
-- 어뷰즈/인위적 몰림으로부터 보호.
--
-- voice_reclone_window_start: 현재 윈도우 시작 시각. NULL = 아직 재녹음 이력 없음.
--   now - window_start >= window 면 윈도우 만료로 보고 다음 재녹음에서 리셋.
-- voice_reclone_count: 현재 윈도우 내 재녹음 횟수.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS voice_reclone_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_reclone_window_start TIMESTAMPTZ;
