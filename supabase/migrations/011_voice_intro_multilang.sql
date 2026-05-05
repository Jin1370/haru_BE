-- 보이스 인트로 다국어 슬롯(ko/ja/en) 도입.
--
-- 배경:
--   * 기존 profiles.voice_intro_audio_url 은 작성자 언어 단일 음성만 저장.
--   * 본 마이그레이션은 시청자 언어 기반 분기를 위해 ko/ja/en 3슬롯을
--     컬럼 확장 방식(JSONB)으로 도입한다. 별도 테이블 대안은 디스커버
--     hot path 의 select 비용 + RLS 정책 중복을 피하기 위해 기각.
--   * 기존 단일 voice_intro_audio_url 컬럼은 drop 하지 않는다.
--     chat 파트너 detail (FE 가 supabase 직접 select) 호환을 위해
--     "작성자 언어 슬롯 URL 미러" 형태로 한동안 유지.
--   * 옛 단일 컬럼 URL 은 NULL 리셋해 다음 voice_intro 저장 시 신규
--     파이프라인이 3슬롯 + 단일 컬럼을 함께 채우도록 한다 (mig 007 패턴 답습).
--
-- 정책:
--   * 작성자가 보내는 voice_intro 텍스트는 1개 언어. BE 가 Gemini 로
--     누락 2개 언어 번역 후 ElevenLabs voice clone 으로 각각 TTS.
--   * 부분 실패 시 그대로 둔다 (status='failed' 또는 NULL).
--   * voice_clone(profiles.elevenlabs_voice_id) 없으면 전체 스킵.
--
-- forward-only. mig 001~010 은 수정하지 않는다.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS voice_intro_translations JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_intro_audio_urls   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice_intro_audio_status JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.voice_intro_translations IS
  '보이스 인트로 다국어 텍스트. 키 ko/ja/en, 값 string. 작성자 입력 슬롯은 원문, '
  '나머지는 Gemini 번역문. 슬롯 미존재 = 키 없음.';

COMMENT ON COLUMN public.profiles.voice_intro_audio_urls IS
  '보이스 인트로 다국어 음성 공개 URL. 키 ko/ja/en, 값 string|null. '
  '슬롯이 ready 상태일 때 URL, 미합성/실패 시 키 없음 또는 null.';

COMMENT ON COLUMN public.profiles.voice_intro_audio_status IS
  '슬롯별 합성 상태. 키 ko/ja/en, 값 pending|processing|ready|failed. '
  '단순 fire-and-forget 모니터링용. 키 없음 = 미시도.';

-- 옛 단일 voice_intro_audio_url 은 NULL 리셋. 다음 PUT /api/profile/me 에서
-- 신규 파이프라인이 3슬롯 + 단일 컬럼 미러를 함께 채운다.
UPDATE public.profiles
SET voice_intro_audio_url = NULL
WHERE voice_intro_audio_url IS NOT NULL;
