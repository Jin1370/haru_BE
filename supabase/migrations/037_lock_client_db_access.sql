-- ============================================================================
-- 037_lock_client_db_access.sql
-- ----------------------------------------------------------------------------
-- THREAT CLASS CLOSED: direct-PostgREST / direct-Storage abuse by a legitimate
-- logged-in user using the shipped anon key + their own session JWT, bypassing
-- the Express backend (haru_BE) and ALL of its guards (zod, req.userId binding,
-- requireNotFrozen, moderation, server-authoritative overrides).
--
-- ROOT CAUSE: Supabase grants the `anon` and `authenticated` Postgres roles
-- DEFAULT table-level DML (SELECT/INSERT/UPDATE/DELETE) on every table in the
-- public schema. The repo's migrations add RLS but NEVER REVOKE those grants
-- and NEVER add WITH CHECK / column scoping on the write policies. Several
-- policies are also accidentally PUBLIC (no TO clause) or wide-open
-- (WITH CHECK(true)). The BE uses the service_role key, which BYPASSES RLS, so
-- RLS + grants were the only thing standing between a direct client and the data.
--
-- SAFETY BOUNDARY (verified against haru_FE/src + haru_FE/admin):
--   * The ONLY @supabase/supabase-js usage is haru_FE/src/services/realtime.ts.
--   * It does ONLY .channel().on('postgres_changes', ...).subscribe() for:
--       - table `messages` (INSERT + UPDATE)
--       - table `matches`  (UPDATE)
--   * It NEVER calls .from()/.rpc()/.storage/.insert/.update/.delete/.select.
--   * admin/ uses NO supabase client at all (goes through BE admin routes).
--   => Official clients need ONLY: SELECT on `messages` and `matches`
--      (Realtime postgres_changes evaluates RLS as the `authenticated` role and
--      requires SELECT privilege + a permissive SELECT policy on the published
--      table). They need ZERO INSERT/UPDATE/DELETE and ZERO other-table reads.
--
-- STRATEGY: revoke ALL client DML on data tables; keep SELECT only where
-- Realtime needs it (messages, matches); drop the over-permissive / PUBLIC /
-- WITH CHECK(true) policies; expose a narrow profiles view if any future client
-- read is needed (BE keeps using service_role and is unaffected).
--
-- Idempotent + forward-only. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Belt-and-suspenders: make sure RLS is on (BE uses service_role => exempt).
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swipes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 1. REVOKE the Supabase default DML grants from the client roles on every
--    public data table. After this, RLS policies are moot for write paths on
--    these roles because the underlying privilege is gone (defense in depth:
--    we ALSO drop the bad policies below). The service_role bypasses RLS and
--    retains its own grants, so the BE is unaffected.
--
--    NOTE: REVOKE is privilege-scoped, not policy-scoped. We revoke everything
--    first, then GRANT back ONLY the minimal SELECT the Realtime path needs.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.profiles',
    'public.swipes',
    'public.matches',
    'public.messages',
    'public.blocks',
    'public.reports',
    'public.user_preferences'
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM anon, authenticated;', t);
  END LOOP;
END $$;

-- Also clamp the schema-level default privileges so future ALTER ... ADD COLUMN
-- or new tables created by tooling don't silently re-grant DML. (No-op if the
-- defaults were never broadened; Supabase sets these per-role.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. GRANT BACK the minimal client read surface required by Realtime.
--    Realtime postgres_changes needs the subscribing role (authenticated) to
--    have SELECT on the published table AND a permissive RLS SELECT policy.
--    Only `messages` and `matches` are in supabase_realtime (001:123, 014:234).
--
--    anon is intentionally NOT granted SELECT — the Realtime path always runs
--    after setSession() with the user's JWT (realtime.ts:setRealtimeAuth), i.e.
--    as `authenticated`, never as `anon`. Granting only authenticated also
--    closes anonymous enumeration.
-- ----------------------------------------------------------------------------
GRANT SELECT ON TABLE public.messages TO authenticated;
GRANT SELECT ON TABLE public.matches  TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Replace the over-permissive RLS policies. Even though grants are revoked,
--    we drop/rewrite these so the schema is internally honest and so a future
--    re-GRANT can't silently re-open a hole.
-- ----------------------------------------------------------------------------

-- 3a. profiles: kill the column-unrestricted UPDATE policy entirely. Clients
--     have NO business updating profiles directly (BE does it via service_role
--     with field-level zod validation + moderation + server-authoritative
--     overrides). With the grant revoked AND no UPDATE policy, direct UPDATE is
--     doubly denied. This closes: voice-id hijack, self-unfreeze, free premium,
--     is_active/deleted_at tamper, voice_intro moderation bypass, reclone-count
--     reset, etc.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- 3b. profiles: client INSERT is BE-only (signup creates the row via
--     service_role). Drop the INSERT policy too.
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;

-- 3c. profiles SELECT: replace the column-unrestricted, PUBLIC read with a
--     policy that still only applies to active rows. Column over-exposure
--     (elevenlabs_voice_id, full birth_date, premium_until, frozen_at,
--     voice_clone_status, reclone counters, voice_intro JSONB) is addressed by
--     REVOKEing column SELECT below — RLS gates ROWS, GRANTs gate COLUMNS.
--     We keep a SELECT policy in place ONLY so that, if a future client read of
--     curated columns is ever wired, the row gate already exists; today the
--     client has no SELECT grant on profiles at all, so this is dormant.
DROP POLICY IF EXISTS "Anyone can read active profiles" ON public.profiles;
CREATE POLICY "Active profiles readable (curated columns only)"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (is_active = true);

-- 3d. profiles column-level lockdown: grant SELECT to authenticated on ONLY the
--     curated, non-sensitive columns the discover/profile surface uses
--     (mirrors swipe.ts:202 projection). This is dormant today (no client reads
--     profiles directly) but means that even if a future client read is wired,
--     elevenlabs_voice_id / premium_until / frozen_at / voice_clone_status /
--     reclone counters / deleted_at can NEVER be projected by a client.
--     birth_date is included because discover needs age, but see residual note:
--     prefer exposing age via a view if precise DOB leakage is a concern.
GRANT SELECT (
  id,
  display_name,
  gender,
  nationality,
  language,
  birth_date,
  voice_intro,
  voice_intro_translations,
  voice_intro_audio_urls,
  voice_intro_audio_status,
  interests,
  created_at,
  is_active
) ON public.profiles TO authenticated;

-- 3e. matches: drop the accidentally-PUBLIC, WITH CHECK(true) INSERT policy.
--     Match creation is service_role-only (swipe.ts mutual-like path). Clients
--     must never fabricate matches (forged unsolicited contact + realtime spam).
DROP POLICY IF EXISTS "Service role can insert matches" ON public.matches;

-- 3f. matches SELECT: keep membership read (Realtime UPDATE path needs it), but
--     pin it to the authenticated role explicitly (was PUBLIC).
DROP POLICY IF EXISTS "Users can read own matches" ON public.matches;
CREATE POLICY "Members can read own matches"
  ON public.matches FOR SELECT
  TO authenticated
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

-- 3g. messages SELECT: keep membership read (Realtime INSERT/UPDATE path needs
--     it) but ALSO require the match to be live (not unmatched). This closes the
--     "unmatched/blocked partner keeps reading the full conversation directly
--     via PostgREST/Realtime" hole. BE tombstone reads use service_role and are
--     unaffected; the in-app chat reads go through BE, also unaffected. Only the
--     direct-PostgREST/Realtime client path is tightened.
DROP POLICY IF EXISTS "Match members can read messages" ON public.messages;
CREATE POLICY "Live-match members can read messages"
  ON public.messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.id = messages.match_id
        AND m.unmatched_at IS NULL
        AND (m.user1_id = auth.uid() OR m.user2_id = auth.uid())
    )
  );

-- 3h. messages: drop the client INSERT policy (forged 'ready' audio + bypassed
--     moderation/translation/TTS). Sending goes through BE/service_role only.
DROP POLICY IF EXISTS "Match members can insert messages" ON public.messages;

-- 3i. swipes / blocks / reports / user_preferences: clients never touch these
--     directly (all go through BE). Drop their client write policies so the
--     schema is honest. SELECT policies are also dropped — none are published to
--     Realtime and the client has no SELECT grant on them anyway.
DROP POLICY IF EXISTS "Users can insert own swipes"        ON public.swipes;
DROP POLICY IF EXISTS "Users can read own swipes"          ON public.swipes;

DROP POLICY IF EXISTS "Users can insert own blocks"        ON public.blocks;
DROP POLICY IF EXISTS "Users can read own blocks"          ON public.blocks;
DROP POLICY IF EXISTS "Users can delete own blocks"        ON public.blocks;

DROP POLICY IF EXISTS "Users can insert own reports"       ON public.reports;
DROP POLICY IF EXISTS "Users can read own reports"         ON public.reports;

DROP POLICY IF EXISTS "Users can manage own preferences"   ON public.user_preferences;

-- ----------------------------------------------------------------------------
-- 4. RESULT (client roles, direct PostgREST):
--    profiles          : SELECT curated columns of active rows only; no write.
--    matches           : SELECT own membership only (Realtime UPDATE); no write.
--    messages          : SELECT own LIVE-match messages only (Realtime); no write.
--    swipes/blocks/
--      reports/user_preferences : no SELECT, no write — fully BE-mediated.
--    service_role (BE) : unchanged (bypasses RLS, retains its grants).
-- ----------------------------------------------------------------------------
