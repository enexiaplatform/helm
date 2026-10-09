-- Memoire → HELM, live (ADR-0034).
--
-- HELM keeps its reading of a user's Memoire opportunities current while HELM is
-- open: a Supabase Realtime notice that an opportunity changed wakes HELM, which
-- re-reads through the governed ingestion pipeline (it never applies the notice).
--
-- This adds `public.opportunities` to the `supabase_realtime` publication — the
-- ONE statement HELM is allowed to make about a Memoire-owned table, and an
-- additive one: it changes no column, constraint, trigger, policy, grant or row
-- of the table, and Memoire behaves exactly as before. Realtime applies the
-- table's own SELECT policy to every subscriber, so a user hears only their own
-- opportunities. Reversible with
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.opportunities;
-- which also changes nothing in Memoire.
--
-- Idempotent: a second application finds the table already published.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'opportunities'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.opportunities;
  END IF;
END
$$;
