-- 059: 별사탕(유료화) — 원장 + 받은 좋아요 공개 기록 + 스와이프 출처/다시보기 + 블러 사진.
-- 정책 원문: _workspace/monetization/decisions.md. 런타임 게이트는 env MONETIZATION_ENABLED
-- (OFF 여도 스키마는 쓰인다 — swipes.source/reset_at 은 항상 기록).

-- ── 1. 별사탕 원장 ────────────────────────────────────────────────
-- 잔액 = SUM(delta). 충전(+)·사용(-)을 한 줄씩 기록하고 수정하지 않는다.
-- paid: 결제로 산 별사탕(true) / 광고·환급(false). 환불 계산과 資金決済法
-- 미사용 잔액 산정에 유료분만 필요해서 구분한다. 사용은 무료분부터 차감.
-- ref: 외부 거래 ID (AdMob transaction_id / 스토어 거래 ID) — 같은 보상·구매가
-- 웹훅 재시도로 두 번 들어와도 (kind, ref) 유니크로 한 번만 지급된다.
CREATE TABLE IF NOT EXISTS star_ledger (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL,
  delta      INTEGER NOT NULL CHECK (delta <> 0),
  paid       BOOLEAN NOT NULL,
  kind       TEXT NOT NULL
    CHECK (kind IN ('ad', 'purchase', 'like', 'card_reset', 'like_reveal', 'refund')),
  ref        TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_star_ledger_kind_ref
  ON star_ledger (kind, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_star_ledger_user
  ON star_ledger (user_id, created_at);

-- 정책 0 = anon/authenticated deny, service_role 전용.
ALTER TABLE star_ledger ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION star_balance(p_user UUID)
RETURNS TABLE (free INTEGER, paid INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(delta) FILTER (WHERE NOT l.paid), 0)::INTEGER,
         COALESCE(SUM(delta) FILTER (WHERE l.paid), 0)::INTEGER
  FROM star_ledger l
  WHERE l.user_id = p_user;
$$;

-- 잔액 확인 + 차감을 한 트랜잭션에서. 사용자별 advisory lock 으로 동시 요청이
-- 같은 잔액을 두 번 쓰지 못하게 한다. 부족하면 'insufficient_stars' 예외.
-- 무료분부터 차감하고 모자란 만큼 유료분에서 뺀다 (줄이 최대 2개).
CREATE OR REPLACE FUNCTION spend_stars(p_user UUID, p_amount INTEGER, p_kind TEXT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_free INTEGER;
  v_paid INTEGER;
  v_from_free INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('stars:' || p_user::TEXT));

  SELECT b.free, b.paid INTO v_free, v_paid FROM star_balance(p_user) b;
  IF v_free + v_paid < p_amount THEN
    RAISE EXCEPTION 'insufficient_stars';
  END IF;

  v_from_free := LEAST(GREATEST(v_free, 0), p_amount);
  IF v_from_free > 0 THEN
    INSERT INTO star_ledger (user_id, delta, paid, kind) VALUES (p_user, -v_from_free, false, p_kind);
  END IF;
  IF p_amount - v_from_free > 0 THEN
    INSERT INTO star_ledger (user_id, delta, paid, kind)
    VALUES (p_user, -(p_amount - v_from_free), true, p_kind);
  END IF;

  RETURN v_free + v_paid - p_amount;
END;
$$;

REVOKE ALL ON FUNCTION star_balance(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION spend_stars(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION star_balance(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION spend_stars(UUID, INTEGER, TEXT) TO service_role;

-- ── 2. 받은 좋아요 공개 기록 ──────────────────────────────────────
-- 무료 공개는 마지막 무료 공개(paid=false) 후 24시간마다 1명.
CREATE TABLE IF NOT EXISTS like_reveals (
  viewer_id   UUID NOT NULL,
  liker_id    UUID NOT NULL,
  paid        BOOLEAN NOT NULL,
  revealed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, liker_id)
);

CREATE INDEX IF NOT EXISTS idx_like_reveals_free
  ON like_reveals (viewer_id, revealed_at DESC) WHERE NOT paid;

ALTER TABLE like_reveals ENABLE ROW LEVEL SECURITY;

-- ── 3. 스와이프 출처 + 다시보기 ───────────────────────────────────
-- source: discover(탐색 탭, 카드 한도 대상) / likes(받은 좋아요 탭, 카드·좋아요 면제)
--         / recycled(다시보기로 돌아온 카드를 좋아요 — 카드 한도 제외, 좋아요는 차감).
-- reset_at: 다시보기로 풀에 되돌린 pass. 예전엔 DELETE 했지만, 다시 넘길 때
-- 새 카드로 세지 않으려면 "이미 본 사람" 이라는 기록이 남아 있어야 한다.
-- 기존 행은 출처를 알 수 없어 discover 로 둔다 (오늘 카드 수에만 영향).
ALTER TABLE swipes
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'discover'
    CHECK (source IN ('discover', 'likes', 'recycled')),
  ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_swipes_cards_today
  ON swipes (swiper_id, created_at) WHERE source = 'discover';

-- ── 4. 블러 사진 ─────────────────────────────────────────────────
-- 받은 좋아요 미공개 카드 / 탐색 한도 초과 카드에 원본 URL 대신 내려주는 블러본.
-- 처음 필요할 때 만들어 저장 (services/photoBlur.ts).
ALTER TABLE profile_photos
  ADD COLUMN IF NOT EXISTS blurred_url TEXT NULL;
