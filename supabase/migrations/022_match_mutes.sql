-- ========== per-match notification mute ==========
-- 채팅 목록의 long-press 액션시트 "알림 끄기" 항목 backing store.
--
-- user_preferences.notify_messages 는 사용자 전역 토글 (전체 메시지 푸시 on/off).
-- 본 테이블은 그 보다 한 단계 좁은 per-match 단위 — 특정 매치에 대해서만 푸시를
-- 끄고 싶을 때 사용 (e.g. 한 상대와의 알림만 잠시 끄기). 두 토글은 AND 로
-- 결합되어 어느 쪽이든 OFF 면 푸시 미발송.
--
-- 모델 선택:
--   * matches 컬럼 확장 (user1_muted/user2_muted) 대신 별도 테이블 — viewer 가
--     user1/user2 중 어느 슬롯인지 모를 때 케이스 분기 회피.
--   * PRIMARY KEY (match_id, user_id) — 멱등 upsert 패턴, 같은 사용자가 같은
--     매치를 두 번 mute 해도 행 1개.
--   * ON DELETE CASCADE 양쪽 (matches / auth.users) — 매치 hard-delete 또는
--     계정 hard-delete 시 자동 정리.
--   * deleteAccount (auth.ts) 는 anonymize 만 하므로 cascade 미발화 →
--     동기 DELETE 를 추가해야 한다 (push-notifications / message-moderation-v1
--     follow-up 과 같은 패턴, 신규 user-linked 테이블 룰).

CREATE TABLE IF NOT EXISTS public.match_mutes (
  match_id  UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);

COMMENT ON TABLE public.match_mutes IS
  '매치별 푸시 알림 옵트아웃 (long-press 액션시트 "알림 끄기"). '
  'user_preferences.notify_messages 전역 토글과 AND 결합 — 어느 한 쪽 OFF 면 미발송.';

-- viewer 의 muted match_ids 일괄 조회 (matches 라우트 핫패스).
CREATE INDEX IF NOT EXISTS idx_match_mutes_user ON public.match_mutes(user_id);

ALTER TABLE public.match_mutes ENABLE ROW LEVEL SECURITY;

-- 본인 mute 만 SELECT/INSERT/DELETE — UPDATE 는 의미가 없다 (toggle 은
-- INSERT/DELETE 로 표현).
CREATE POLICY match_mutes_owner_select ON public.match_mutes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY match_mutes_owner_insert ON public.match_mutes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY match_mutes_owner_delete ON public.match_mutes
  FOR DELETE USING (auth.uid() = user_id);

-- Realtime publication 미포함 — FE 가 본 테이블을 realtime 으로 구독할 일 없음.
-- 토글은 옵티미스틱 + REST 응답으로 충분.
