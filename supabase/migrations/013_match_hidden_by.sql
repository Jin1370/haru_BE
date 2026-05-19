-- Per-user soft-hide of tombstone matches (unmatched / partner deleted).
--
-- After we surfaced tombstones in the match list (so the partner sees a
-- "매치 종료" / "탈퇴한 사용자" entry instead of having matches silently
-- vanish), users need a way to clean up the list once the relationship is
-- fully over. `hidden_by` lets each participant remove the match from their
-- own list independently — when a userId is appended to the array, the
-- match list query excludes that match for that viewer only. The other
-- participant still sees it until they also hide.
--
-- Hiding is gated to tombstone matches at the API layer (`POST /api/
-- matches/:matchId/hide` only succeeds when unmatched_at IS NOT NULL OR
-- the partner profile has deleted_at). Active matches must go through
-- block (= unmatch) first and become tombstones.
--
-- A future cron job can hard-delete matches once both participants have
-- hidden (`array_length(hidden_by, 1) = 2`) — at that point neither side
-- can reach the conversation, so we can free the row + cascade messages.

ALTER TABLE matches
  ADD COLUMN hidden_by UUID[] NOT NULL DEFAULT '{}';

-- GIN supports the contains (`@>`) lookup the API filter uses, so the
-- "exclude matches where viewer id is in hidden_by" predicate stays
-- index-backed even as the table grows.
CREATE INDEX idx_matches_hidden_by ON matches USING GIN (hidden_by);
