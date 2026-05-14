-- profiles.voice_intro_audio_url (단일 컬럼) drop.
--
-- 배경:
--   * mig 011 에서 시청자 언어 슬롯 ko/ja/en 을 voice_intro_audio_urls JSONB
--     로 도입하면서 단일 컬럼은 "작성자 언어 슬롯 미러" 역할로 잔존시킴.
--   * 잔존 사유는 chat 파트너 detail FE 가 supabase 에서 단일 컬럼을 직접
--     select 하던 호환 — 그 경로가 GET /api/matches/:matchId/partner 로
--     교체되면서 FE 의 DB 직접 read 가 0 건이 됨.
--   * 디스커버/매치 라우트 응답의 wire key `voice_intro_audio_url` 은 BE 가
--     voice_intro_audio_urls 에서 시청자 언어 슬롯을 추출해 미러하는 in-flight
--     계산이라 컬럼 drop 과 무관 — 그 wire key 는 호환 유지 목적으로 유지됨.
--
-- 데이터 손실 평가:
--   * 단일 컬럼이 NOT NULL 이었던 모든 row 는 voiceIntro.ts 의 작성자 슬롯
--     ready 시점에 voice_intro_audio_urls[<author_lang>] 와 동일 값으로 미러
--     update 되어 있음 → drop 시 손실 0.
--   * 본 마이그와 함께 BE 의 write 경로 3 곳(voiceIntro.ts 미러 update /
--     profile.ts voice_intro 텍스트 변경 시 reset / auth.ts signup placeholder)
--     도 제거. deploy 순서는 BE 코드 deploy → mig 적용 (역순이면 deploy 직전
--     까지 BE 가 단일 컬럼 write 시도해 컬럼 없음 에러).
--
-- forward-only. mig 001~018 은 수정하지 않는다.

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS voice_intro_audio_url;
