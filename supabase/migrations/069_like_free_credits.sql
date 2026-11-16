-- 069_like_free_credits.sql
-- 받은 인사 탭에서 무료로 연 카드의 상대가 사라져 인사가 들어가지 않으면 무료 카드를 한 장
-- 돌려준다 (사용자 결정 2026-11-16). 무료 카드는 "마지막 무료 공개 + 24시간" 타이머로만
-- 관리돼, 가장 최근에 무료로 연 카드가 아니면 돌려줄 방법이 없었다. 돌려받은 장을 따로
-- 기록하고, 인사 직후 앱이 다시 받는 받은 인사 목록에서 타이머와 상관없이 다음 카드를 연다.
-- 그 목록 조회가 받은 장을 가져가며 지우므로, 열 카드가 없으면 그대로 사라진다 — 나중에 새
-- 인사가 와서 저절로 열리면 사용자가 헷갈린다 (사용자 결정). 목록을 받지 못한 채 앱을 닫은
-- 경우에 대비해 받은 지 5분이 지난 장은 쓰지 않는다.
--
-- like_reveals.free_credit = 돌려받은 무료 카드로 연 공개. paid=true 로 기록해 24시간
-- 타이머에 잡히지 않게 하고, 이 카드도 사라지면 다시 한 장을 돌려준다.
-- like_reveals.free_refunded = 이 공개로 무료 카드를 이미 돌려줬다 (같은 카드로 두 번 안 줌).
-- 돌려줄 때 타이머는 건드리지 않는다 — 돌려받은 한 장은 덤이고, 원래 오기로 한 다음 무료
-- 카드 시각은 그대로 (사용자 결정 2026-11-16).

ALTER TABLE like_reveals ADD COLUMN IF NOT EXISTS free_credit BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE like_reveals ADD COLUMN IF NOT EXISTS free_refunded BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS like_free_credits (
  viewer_id  UUID PRIMARY KEY,
  credits    INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE like_free_credits ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE like_free_credits ENABLE ROW LEVEL SECURITY;

-- 한 장 주기. 5분이 지난 남은 장은 버리고 새로 센다.
CREATE OR REPLACE FUNCTION grant_like_free_credit(p_viewer UUID)
RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO like_free_credits (viewer_id, credits, granted_at) VALUES (p_viewer, 1, now())
  ON CONFLICT (viewer_id) DO UPDATE SET
    credits = CASE WHEN like_free_credits.granted_at > now() - interval '5 minutes'
                   THEN like_free_credits.credits + 1 ELSE 1 END,
    granted_at = now();
$$;

-- 받은 장을 모두 가져가며 지운다 — 받은 인사 목록 조회가 부르고, 그 조회에서 열 카드가 없으면
-- 그대로 사라진다. 5분이 지난 장은 0 으로 센다. 동시에 두 번 불러도 한쪽만 가져간다.
CREATE OR REPLACE FUNCTION take_like_free_credits(p_viewer UUID)
RETURNS INTEGER
LANGUAGE sql AS $$
  WITH taken AS (
    DELETE FROM like_free_credits WHERE viewer_id = p_viewer
    RETURNING CASE WHEN granted_at > now() - interval '5 minutes' THEN credits ELSE 0 END AS n
  )
  SELECT COALESCE((SELECT n FROM taken), 0);
$$;

REVOKE ALL ON FUNCTION grant_like_free_credit(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_like_free_credit(UUID) TO service_role;
REVOKE ALL ON FUNCTION take_like_free_credits(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION take_like_free_credits(UUID) TO service_role;
