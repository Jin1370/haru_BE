-- Soft-delete tombstone for deleted accounts.
--
-- The /api/auth/account DELETE endpoint switches from cascade-delete to
-- anonymize-in-place: the auth.users row stays alive but with a randomized
-- email/password (so the user can never log back in), and the profiles row
-- has its PII fields cleared while `deleted_at` is stamped. This preserves
-- referential integrity for matches/messages so the partner can still see
-- the conversation history with a "탈퇴한 사용자" tombstone label, instead
-- of having matches silently vanish.
--
-- The partial index supports the matches/discover side filters that need to
-- detect tombstones cheaply ("WHERE deleted_at IS NOT NULL").

ALTER TABLE profiles
  ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE INDEX idx_profiles_deleted_at
  ON profiles(deleted_at)
  WHERE deleted_at IS NOT NULL;
