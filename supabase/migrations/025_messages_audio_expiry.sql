-- audio-expiry sprint
--
-- 차별점 2 (송신자 클론 보이스 TTS) 의 합성 음성 파일을 "수신자 청취 완료 +
-- 30일" 시점에 자동 폐기. 음성을 재청취하려는 경우 ElevenLabs 로 on-demand
-- 재생성. 텍스트/번역/메시지 row 는 매치 생명주기 동안 유지.
--
-- 두 컬럼을 분리한 이유:
--   * audio_purged_at — FE 가 "purge 된 상태" 를 명시적으로 감지하기 위한 플래그.
--     sweep 시 audio_url=NULL 과 함께 set, 재생성 시 NULL 로 reset. audio_url IS
--     NULL 단독 조건은 "TTS 미발화 (no-speakable-content)" / "pipeline failed"
--     케이스와 구별 불가하므로 별도 컬럼 필요.
--   * audio_refreshed_at — sweep 의 "현재 audio file 의 age" 추적. 재생성 후
--     30일이 지나야 재차 purge 대상이 되도록 한다 (재생성 직후 즉시 재퍼지
--     회귀 차단). 최초 INSERT 시 created_at 이 사실상 audio age 이므로
--     audio_refreshed_at IS NULL = "한 번도 재생성된 적 없음" 의미로 사용.

ALTER TABLE public.messages
  ADD COLUMN audio_purged_at TIMESTAMPTZ NULL,
  ADD COLUMN audio_refreshed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.messages.audio_purged_at IS
  'audio-expiry sprint: sweep job 이 음성 파일을 Storage 에서 삭제한 시각. '
  'audio_url=NULL 과 동시 set. FE 가 "재생성 가능한 purge 상태" 를 감지하는 단일 '
  '진실원. 재생성 시 NULL 로 reset. NULL = 정상(audio_url 유무로 활성/없음 구분).';

COMMENT ON COLUMN public.messages.audio_refreshed_at IS
  'audio-expiry sprint: 가장 최근 재생성 시각. 최초 INSERT 시 NULL '
  '(audio age = created_at). 재생성 시 now() set. sweep eligibility 의 "current '
  'audio 가 30일 이상 묵었는가" 판단에 사용.';

-- sweep 핫패스 인덱스. listened_at + audio_purged_at 조합으로 후보 좁히기.
-- audio_url IS NOT NULL 은 partial index predicate 로 정확도 강화.
CREATE INDEX idx_messages_audio_expiry
  ON public.messages (listened_at, audio_refreshed_at)
  WHERE audio_url IS NOT NULL
    AND audio_purged_at IS NULL
    AND listened_at IS NOT NULL;

-- RLS 정책 변경 없음 — service_role 로만 sweep/regen 라우트 접근.
-- Realtime publication 변경 불필요 — mig 001 의 messages 전체 컬럼 publish 가
-- 이미 두 신규 컬럼을 자동 포함. REPLICA IDENTITY DEFAULT 라 UPDATE payload 의
-- `new` 에 두 컬럼 모두 노출.
