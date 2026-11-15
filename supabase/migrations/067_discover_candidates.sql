-- 067_discover_pool.sql
-- 탐색·받은 좋아요 후보 점수를 DB 안에서 계산한다. 예전엔 서버가 최근 가입 200명만 가져와
-- 점수를 매겨, 오래된 가입자는 점수와 무관하게 후보에 들지 못했다 (prod 한국어 사용자 기준
-- 노출 가능 200명 중 81명). 이제 노출 가능한 사람 전원이 대상이다.
--
-- discover_score: 주어진 사람들의 점수 (높을수록 먼저). 탐색과 받은 좋아요가 같이 쓴다.
--   관심사 겹침 1개당 10 (최대 30) / 사진 3장+ 15 / 가입 7일 이내 10 /
--   최근 접속 (KST 오늘·어제 20, 7일 이내 10 — daily_active_users) /
--   쌍 jitter 0~15 — 두 id 를 정렬해 해시하므로 A→B 와 B→A 가 같다. 관심사 겹침도
--   대칭이라 점수가 '거리' 처럼 작동해, 서로의 상위에 함께 뜨는 쌍이 생긴다.
-- discover_pool: 탐색 후보 전원 + 점수 + 나에게 인사했는지(liked_you) + 내가 넘긴 사람이면
--   넘긴 시각(passed_at). 인사한 사람은 점수 가산 없이 표시만 한다 — 서버가 플레이리스트당 칸 수를
--   제한해 섞는다. 넘긴 사람(passed_at 있음)은 '다시 보기' 후보 — 대기 기간(3일 × 2^(넘긴 횟수-1))이
--   지난 사람만(최대 3번까지) 돌려주고, score 는 넘긴 횟수 × 10 만큼 깎아 준다. 서버는 이 score 순으로 채운다.
--   인사한(like) 사람은 다시 보여주지 않는다.

-- 넘긴 횟수 — 다시 보기 카드를 또 넘길 때마다 +1 (자정 정리). 다시 나올 때까지의 대기 기간을
-- 3일 × 2^(횟수-1) 로 늘리고(3 → 6 → 12 → 24일…), 다시 보기 순서에서 횟수 × 10 점 감점한다 —
-- 상위권 카드는 금방 돌아와 새 카드가 모자랄 때 질을 받치되, 같은 사람이 반복될수록 드물게 나온다.
-- 다시 보기는 한 사람당 최대 3번 (넘긴 횟수 4 이상이면 다시 나오지 않는다).
ALTER TABLE swipes ADD COLUMN IF NOT EXISTS pass_count INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION discover_score(p_user UUID, p_ids UUID[])
RETURNS TABLE (id UUID, score NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH viewer AS (
    SELECT COALESCE(interests, '{}') AS interests FROM profiles WHERE profiles.id = p_user
  ),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS d)
  SELECT
    p.id,
    LEAST(10 * cardinality(ARRAY(
      SELECT unnest(COALESCE(p.interests, '{}')) INTERSECT SELECT unnest(v.interests)
    )), 30)
    + CASE WHEN ph.n >= 3 THEN 15 ELSE 0 END
    + CASE WHEN p.created_at > now() - interval '7 days' THEN 10 ELSE 0 END
    + CASE
        WHEN act.last_day >= t.d - 1 THEN 20
        WHEN act.last_day >= t.d - 6 THEN 10
        ELSE 0
      END
    + ((hashtext(LEAST(p.id, p_user)::text || GREATEST(p.id, p_user)::text)::bigint % 1500 + 1500) % 1500) / 100.0
  FROM profiles p
  CROSS JOIN viewer v
  CROSS JOIN today t
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM profile_photos pp
    WHERE pp.user_id = p.id AND pp.status = 'ready' AND pp.converted_url IS NOT NULL
  ) ph ON true
  LEFT JOIN LATERAL (
    SELECT max(d.day) AS last_day FROM daily_active_users d WHERE d.user_id = p.id
  ) act ON true
  WHERE p.id = ANY (p_ids)
$$;

CREATE OR REPLACE FUNCTION discover_pool(
  p_user UUID,
  p_slot TEXT,
  p_exclude UUID[]
)
RETURNS TABLE (id UUID, score NUMERIC, liked_you BOOLEAN, passed_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH viewer AS (
    SELECT COALESCE(language, '') AS language FROM profiles WHERE profiles.id = p_user
  ),
  -- 내 기록만 인덱스로 먼저 뽑는다 — 후보마다 swipes 를 찾게 두면 swipes 전체를 훑는다
  -- (prod 실측 118ms → 13ms).
  excluded AS MATERIALIZED (
    -- 인사한 사람만 뺀다. 넘긴 사람은 아래 passes 로 '다시 보기' 후보가 되고, 다시보기
    -- (reset_at)로 풀에 돌아온 사람은 새 후보로 본다.
    SELECT s.swiped_id AS id FROM swipes s
    WHERE s.swiper_id = p_user AND s.reset_at IS NULL AND s.direction <> 'pass'
    UNION SELECT b.blocked_id FROM blocks b WHERE b.blocker_id = p_user
    UNION SELECT b.blocker_id FROM blocks b WHERE b.blocked_id = p_user
    -- 아직 pass 처리 전인 플레이리스트에 든 사람 / 받은 인사 탭에서 이미 연 사람.
    UNION SELECT i.candidate_id FROM discover_playlist_items i WHERE i.user_id = p_user
    UNION SELECT r.liker_id FROM like_reveals r WHERE r.viewer_id = p_user
    UNION SELECT unnest(COALESCE(p_exclude, '{}'))
  ),
  passes AS MATERIALIZED (
    SELECT s.swiped_id AS id, s.created_at, s.pass_count FROM swipes s
    WHERE s.swiper_id = p_user AND s.reset_at IS NULL AND s.direction = 'pass'
  ),
  likers AS MATERIALIZED (
    SELECT s.swiper_id AS id FROM swipes s WHERE s.swiped_id = p_user AND s.direction = 'like'
  ),
  eligible AS MATERIALIZED (
    SELECT p.id
    FROM profiles p
    CROSS JOIN viewer v
    WHERE p.id <> p_user
      AND p.is_active
      AND p.frozen_at IS NULL
      AND COALESCE(p.language, '') <> ''
      AND (v.language = '' OR p.language <> v.language)
      -- 보이스 한마디가 내 언어로 없으면 무음 카드라 노출하지 않는다 (차별점 1).
      AND COALESCE(p.voice_intro_audio_urls ->> p_slot, '') <> ''
      AND p.id NOT IN (SELECT e.id FROM excluded e WHERE e.id IS NOT NULL)
      -- 넘긴 사람은 대기 기간이 지나야 다시 나오고, 다시 보기는 최대 3번 (처음 본 것 포함 4번 넘기면 끝).
      AND NOT EXISTS (
        SELECT 1 FROM passes ps
        WHERE ps.id = p.id
          AND (ps.pass_count > 3 OR ps.created_at > now() - interval '3 days' * power(2, ps.pass_count - 1))
      )
      AND EXISTS (
        SELECT 1 FROM profile_photos pp
        WHERE pp.user_id = p.id AND pp.status = 'ready' AND pp.converted_url IS NOT NULL
      )
  )
  SELECT s.id, s.score - 10 * COALESCE(ps.pass_count, 0), s.id IN (SELECT l.id FROM likers l) AS liked_you,
    ps.created_at AS passed_at
  FROM discover_score(p_user, ARRAY(SELECT id FROM eligible)) s
  LEFT JOIN passes ps ON ps.id = s.id
  ORDER BY 2 DESC, 1
$$;

REVOKE ALL ON FUNCTION discover_score(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_score(UUID, UUID[]) TO service_role;
REVOKE ALL ON FUNCTION discover_pool(UUID, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_pool(UUID, TEXT, UUID[]) TO service_role;
