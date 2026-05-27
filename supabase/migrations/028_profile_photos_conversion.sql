-- ========== photo-watercolor-pipeline sprint ==========
--
-- 차별점 4 (수채화·일러스트 톤 프로필 사진 — 디스커버 답답함 해소).
--
-- 핵심 변경 4 부:
--   (A) profile_photos 테이블 신설 — 사진별 status / 원본 path / 변환 URL / position
--       을 row 단위로 정규화. 기존 profiles.photos TEXT[] 배열은 호환 유지를 위해
--       남기되 본 sprint 이후 모든 read path 는 profile_photos 만 참조하도록 BE
--       라우트가 swap (다음 sprint 에서 photos 컬럼 DROP).
--   (B) get_match_summaries_v4 — v3 와 동일 시그니처 + UNLOCK_MAIN=10 (이전 5).
--       main_photo_unlocked 과 all_photos_unlocked 가 항상 같은 값 (5 단계 사라짐).
--       v3 는 dead function 으로 유지 (다음 sprint 에서 DROP).
--   (C) match_roundtrip_on_insert 트리거 함수 교체 — 옛 IF new_count >= 5 분기를
--       제거하고 IF new_count >= 10 단일 분기 (main_at / all_at 동시 set).
--       단조성 가드는 변경 없음 (옛 매치의 main_photo_unlocked_at 잔존 가능, fresh
--       DB 라 영향 0).
--   (D) 백필 — 기존 profiles.photos TEXT[] 의 모든 row → profile_photos 의
--       status='pending' INSERT. retry sweep job 이 후속 변환을 처리.
--
-- 사용자 결정 (2026-05-27):
--   * 자동 백필 ON (architect 권장 SKIP 거부) — 출시 전 + 테스트 데이터 적음.
--   * AI 변환 라벨 i18n 키 미추가 (별개 결정).
--
-- forward-only. mig 001~027 수정 금지.

-- ---------- (A) profile_photos 테이블 ----------

CREATE TABLE IF NOT EXISTS public.profile_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  -- Storage path inside the 'photos' bucket. NULL = 변환 성공 직후 폐기.
  -- 백필 row 의 경우 기존 public URL 을 그대로 저장 (sweep job 이 URL → bytes
  -- download → 변환본 업로드 → 'ready' 전이 후 NULL).
  original_path   TEXT NULL,
  -- public URL. NULL when status != 'ready'.
  converted_url   TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'rejected')),
  -- 실패 사유 분류:
  --   * 'moderation_rejected' — OpenAI safety filter 가 거부 (rejected 와 함께 set)
  --   * 'openai_timeout' / 'openai_error' — 네트워크/타임아웃/5xx
  --   * 'upload_failed' — Supabase Storage 업로드 실패
  --   * 'download_failed' — 백필 row 의 원본 URL 다운로드 실패
  --   * 'unknown' — fallback
  failure_reason  TEXT NULL,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, position)
);

COMMENT ON TABLE public.profile_photos IS
  'photo-watercolor-pipeline sprint: 사진별 변환 status / 원본 path / 변환본 URL / position '
  '정규화 테이블. profiles.photos TEXT[] 는 호환 유지 동안만 남고 다음 sprint 에서 DROP.';

COMMENT ON COLUMN public.profile_photos.position IS
  '0=main (디스커버/매치 메인 사진). 1~4=추가 사진 (10회 왕복 unlock). UNIQUE (user_id, position).';

COMMENT ON COLUMN public.profile_photos.original_path IS
  'Storage `photos` 버킷 내 원본 path (또는 백필 row 의 경우 기존 public URL). '
  '변환 성공 직후 폐기 → NULL. voice-sample-removal sprint 의 "운영상 사용처 0" 패턴 적용.';

COMMENT ON COLUMN public.profile_photos.converted_url IS
  'gpt-image-2 로 변환된 수채화 톤 사진 public URL. status=''ready'' 일 때만 NOT NULL.';

COMMENT ON COLUMN public.profile_photos.status IS
  '변환 lifecycle: pending(미시작) → processing(OpenAI 호출 중) → ready(완료) | '
  'failed(재시도 가능) | rejected(모더레이션 거부, 재시도 불가).';

-- 핫패스 인덱스: (user_id, position) — discover/match join 의 viewer-by-position 조회.
-- UNIQUE 제약이 자동 인덱스 생성하므로 별도 idx 불필요.

-- 재시도 sweep 핫패스 — status IN ('pending','failed') 후보를 빠르게 좁히기.
CREATE INDEX IF NOT EXISTS idx_profile_photos_processing
  ON public.profile_photos (user_id, updated_at)
  WHERE status IN ('pending', 'processing', 'failed');

-- RLS: 본인 SELECT + service_role 전용 INSERT/UPDATE/DELETE.
-- anon/authenticated 의 INSERT 차단 — 디스커버/매치 응답은 service_role 가 join 으로
-- 조립하므로 클라이언트 직접 INSERT 경로 자체 부재.
ALTER TABLE public.profile_photos ENABLE ROW LEVEL SECURITY;

-- 본인 행만 SELECT 가능 (profile 조회 응답에 photo_statuses 포함 시 anon key 로도
-- 동작 가능하도록 — BE 라우트는 service_role 사용하지만 admin 도구의 RLS 정합 유지).
CREATE POLICY "Users can read their own profile_photos"
  ON public.profile_photos
  FOR SELECT
  USING (auth.uid() = user_id);

-- Realtime publication 미포함 — FE 폴링 (30~60초 1회성) 충분.

-- ---------- (B) get_match_summaries_v4 ----------
--
-- v3 와 시그니처 동일 + UNLOCK_MAIN := 10 (이전 5). main_photo_unlocked 항상
-- all_photos_unlocked 와 같은 값.

CREATE OR REPLACE FUNCTION get_match_summaries_v4(
  match_ids UUID[],
  viewer_id UUID
)
RETURNS TABLE (
  match_id UUID,
  last_message_id UUID,
  last_message_preview TEXT,
  last_message_sender_id UUID,
  last_message_created_at TIMESTAMPTZ,
  last_message_audio_status TEXT,
  last_message_listened_at TIMESTAMPTZ,
  unread_count BIGINT,
  round_trip_count BIGINT,
  main_photo_unlocked BOOLEAN,
  all_photos_unlocked BOOLEAN
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- photo-watercolor-pipeline sprint: UNLOCK_MAIN 단계 폐지.
  -- main_photo_unlocked 과 all_photos_unlocked 가 항상 같은 값 (10 단일).
  -- constants/chat.ts 와 동기화 필요.
  UNLOCK_ALL  CONSTANT INTEGER := 10;
  mid UUID;
  rec RECORD;
  first_sender UUID;
  seen_a BOOLEAN;
  seen_b BOOLEAN;
  rt BIGINT;
  last_id UUID;
  last_text TEXT;
  last_sender UUID;
  last_ts TIMESTAMPTZ;
  last_status TEXT;
  last_listened TIMESTAMPTZ;
  unread BIGINT;
BEGIN
  FOREACH mid IN ARRAY match_ids LOOP
    -- 라운드트립 계산 (v3 와 동일 로직)
    first_sender := NULL;
    seen_a := FALSE;
    seen_b := FALSE;
    rt := 0;

    FOR rec IN
      SELECT sender_id
        FROM messages
       WHERE messages.match_id = mid
       ORDER BY created_at ASC
    LOOP
      IF first_sender IS NULL THEN
        first_sender := rec.sender_id;
        seen_a := TRUE;
      ELSIF rec.sender_id = first_sender THEN
        seen_a := TRUE;
      ELSE
        seen_b := TRUE;
      END IF;

      IF seen_a AND seen_b THEN
        rt := rt + 1;
        seen_a := FALSE;
        seen_b := FALSE;
      END IF;
    END LOOP;

    -- 마지막 메시지 — viewer 시점 필터 (v3 와 동일)
    SELECT id, original_text, sender_id, created_at, audio_status, listened_at
      INTO last_id, last_text, last_sender, last_ts, last_status, last_listened
      FROM messages
     WHERE messages.match_id = mid
       AND (messages.sender_id = viewer_id OR messages.audio_status = 'ready')
     ORDER BY created_at DESC
     LIMIT 1;

    -- unread (viewer 기준) — v3 와 동일
    SELECT COUNT(*) INTO unread
      FROM messages
     WHERE messages.match_id = mid
       AND messages.sender_id <> viewer_id
       AND messages.audio_status = 'ready'
       AND messages.listened_at IS NULL;

    match_id := mid;
    last_message_id := last_id;
    last_message_preview := last_text;
    last_message_sender_id := last_sender;
    last_message_created_at := last_ts;
    last_message_audio_status := last_status;
    last_message_listened_at := last_listened;
    unread_count := COALESCE(unread, 0);
    round_trip_count := rt;
    -- photo-watercolor-pipeline: 두 boolean 항상 동일 값.
    main_photo_unlocked := rt >= UNLOCK_ALL;
    all_photos_unlocked := rt >= UNLOCK_ALL;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 권한: service_role 만. PUBLIC/anon/authenticated 회수 (mig 027 의 v3 정책과 동일).
REVOKE EXECUTE ON FUNCTION get_match_summaries_v4(UUID[], UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_match_summaries_v4(UUID[], UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION get_match_summaries_v4(UUID[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_match_summaries_v4(UUID[], UUID) TO service_role;

-- ---------- (C) match_roundtrip_on_insert 트리거 함수 교체 ----------
--
-- 옛 분기 (rt>=5 시 main_at, rt>=10 시 all_at) 를 (rt>=10 시 main_at + all_at 동시
-- set) 로 통합. 단조성 가드는 변경 없음.

CREATE OR REPLACE FUNCTION match_roundtrip_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  cur_count INTEGER;
  cur_unpaired UUID;
  cur_main_at TIMESTAMPTZ;
  cur_all_at TIMESTAMPTZ;
  new_count INTEGER;
  new_unpaired UUID;
  new_main_at TIMESTAMPTZ;
  new_all_at TIMESTAMPTZ;
  now_ts TIMESTAMPTZ := now();
BEGIN
  SELECT round_trip_count,
         round_trip_unpaired_sender,
         main_photo_unlocked_at,
         all_photos_unlocked_at
    INTO cur_count, cur_unpaired, cur_main_at, cur_all_at
    FROM matches
   WHERE id = NEW.match_id
   FOR UPDATE;

  new_count := COALESCE(cur_count, 0);

  IF cur_unpaired IS NULL THEN
    new_unpaired := NEW.sender_id;
  ELSIF cur_unpaired = NEW.sender_id THEN
    new_unpaired := cur_unpaired;
  ELSE
    new_count := new_count + 1;
    new_unpaired := NULL;
  END IF;

  -- photo-watercolor-pipeline: 5 단계 폐지. 10 단일 분기.
  -- main_at / all_at 동시 set.
  IF cur_main_at IS NOT NULL THEN
    new_main_at := cur_main_at;
  ELSIF new_count >= 10 THEN
    new_main_at := now_ts;
  ELSE
    new_main_at := NULL;
  END IF;

  IF cur_all_at IS NOT NULL THEN
    new_all_at := cur_all_at;
  ELSIF new_count >= 10 THEN
    new_all_at := now_ts;
  ELSE
    new_all_at := NULL;
  END IF;

  UPDATE matches
     SET round_trip_count = new_count,
         round_trip_unpaired_sender = new_unpaired,
         main_photo_unlocked_at = new_main_at,
         all_photos_unlocked_at = new_all_at
   WHERE id = NEW.match_id;

  RETURN NEW;
END;
$$;

-- ---------- (D) 백필 ----------
--
-- 기존 profiles.photos TEXT[] 모든 row → profile_photos (status='pending') INSERT.
-- 백필 사진은 retry sweep job 이 후속 변환 처리 (jobs/retryFailedPhotoConversions.ts).
-- original_path 컬럼에는 기존 public URL 을 그대로 저장 → service 가 URL → bytes
-- download → gpt-image-2 호출 → 변환본 업로드 → status='ready' 전이.
--
-- ON CONFLICT (user_id, position) DO NOTHING — 마이그레이션 멱등성 보장 (재실행 안전).
-- fresh DB 에선 profiles.photos 가 비어있어 자연스럽게 no-op.

DO $$
DECLARE
  rec RECORD;
  photo_url TEXT;
  idx INTEGER;
  inserted_count BIGINT := 0;
BEGIN
  FOR rec IN
    SELECT id AS user_id, photos
      FROM profiles
     WHERE photos IS NOT NULL
       AND array_length(photos, 1) > 0
  LOOP
    idx := 0;
    FOREACH photo_url IN ARRAY rec.photos LOOP
      -- position 0~4 만 (MAX_PHOTOS 정합). 5장 초과 인덱스는 skip.
      IF idx < 5 THEN
        INSERT INTO profile_photos (user_id, position, original_path, status)
        VALUES (rec.user_id, idx, photo_url, 'pending')
        ON CONFLICT (user_id, position) DO NOTHING;
        inserted_count := inserted_count + 1;
      END IF;
      idx := idx + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'profile_photos backfill: % rows considered for insert (existing rows skipped via ON CONFLICT)', inserted_count;
END $$;
