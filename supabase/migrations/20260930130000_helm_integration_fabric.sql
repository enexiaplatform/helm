-- ============================================================================
-- HELM — Integration Fabric
-- ============================================================================
--
-- ADR-0030 (source-agnostic integration: the source system owns the fact).
--
--   PART 1  sync ledger and dry-run writeback ledger
--   PART 2  guards: write-once, record time stamped by the database, a blocked
--           run does not move the checkpoint, a dry run derives from an action
--           intent of the commitment it names, DRY_RUN is the only mode, and a
--           request is unique on its idempotency key
--   PART 3  row rules and scoped RLS (a write request is read by whoever can see
--           the decision it derives from; row-based, so INSERT … RETURNING works)
--   PART 4  grants
--
-- Checkpoints are DERIVED from the ledger (the latest run that was not blocked
-- or failed); nothing here is updated in place. Nothing here writes a Memoire
-- object, and v1 has no live writeback: mode is pinned to DRY_RUN.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_integration_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  connector text NOT NULL CHECK (char_length(btrim(connector)) >= 1),
  cursor_before text,
  cursor_after text,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'PARTIAL', 'BLOCKED_BY_DRIFT', 'FAILED')),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  drift jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(drift) = 'array'),
  quarantined jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quarantined) = 'array'),
  ingestion_event_id uuid REFERENCES public.helm_ingestion_events(id) ON DELETE RESTRICT,
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- HELM never guesses at a changed source: a blocked or failed run leaves the checkpoint where it was.
  CONSTRAINT helm_integration_syncs_checkpoint_holds CHECK (
    outcome NOT IN ('BLOCKED_BY_DRIFT', 'FAILED') OR cursor_after IS NOT DISTINCT FROM cursor_before
  ),
  CONSTRAINT helm_integration_syncs_success_is_clean CHECK (
    outcome <> 'SUCCEEDED' OR jsonb_array_length(quarantined) = 0
  )
);
CREATE INDEX IF NOT EXISTS helm_integration_syncs_lookup_idx ON public.helm_integration_syncs (org_id, system, connector, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.helm_writeback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  -- There is no request without an explicit execution intent.
  action_intent_id uuid NOT NULL REFERENCES public.helm_actions(id) ON DELETE RESTRICT,
  target_system text NOT NULL CHECK (target_system IN ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  operation text NOT NULL CHECK (char_length(btrim(operation)) >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (char_length(btrim(payload_hash)) >= 1),
  idempotency_key text NOT NULL CHECK (char_length(btrim(idempotency_key)) >= 1),
  -- v1 sends nothing. A live mode is a separate, explicitly authorized decision and a later migration.
  mode text NOT NULL CHECK (mode = 'DRY_RUN'),
  outcome text NOT NULL CHECK (outcome IN ('WOULD_WRITE', 'REFUSED')),
  refusal_reason text,
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipt) = 'object'),
  governance_state text NOT NULL CHECK (char_length(btrim(governance_state)) >= 1),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_writeback_requests_unique_key UNIQUE (org_id, idempotency_key),
  CONSTRAINT helm_writeback_requests_refusal_says_why CHECK (
    (outcome = 'REFUSED' AND char_length(btrim(coalesce(refusal_reason, ''))) >= 1)
    OR (outcome = 'WOULD_WRITE' AND refusal_reason IS NULL)
  ),
  -- A dry run records what would have been sent, and that nothing was.
  CONSTRAINT helm_writeback_requests_nothing_sent CHECK (
    outcome <> 'WOULD_WRITE' OR (receipt->>'sent' = 'false' AND receipt ? 'endpoint')
  ),
  -- Only a commitment the governance state permits to be executed: recorded with the state it was judged in.
  CONSTRAINT helm_writeback_requests_governed CHECK (
    outcome <> 'WOULD_WRITE' OR governance_state IN ('AUTHORIZED', 'APPROVED')
  )
);
CREATE INDEX IF NOT EXISTS helm_writeback_requests_commitment_idx ON public.helm_writeback_requests (commitment_id);

-- ====================================================================== PART 2

CREATE OR REPLACE FUNCTION public.helm_integration_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: integration records are append-only; a later sync or dispatch is a new record', TG_TABLE_NAME;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_writeback_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.helm_decision_commitments c
    WHERE c.id = NEW.commitment_id AND c.org_id = NEW.org_id AND c.decision_id = NEW.decision_id
  ) THEN
    RAISE EXCEPTION 'helm_writeback_requests: the commitment is not this decision''s, or not in this organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.helm_actions a
    WHERE a.id = NEW.action_intent_id AND a.org_id = NEW.org_id AND a.commitment_id = NEW.commitment_id
  ) THEN
    RAISE EXCEPTION 'helm_writeback_requests: a write derives only from an action intent of this commitment';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_integration_syncs_record ON public.helm_integration_syncs;
CREATE TRIGGER helm_integration_syncs_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_integration_syncs FOR EACH ROW EXECUTE FUNCTION public.helm_integration_record_guard();
DROP TRIGGER IF EXISTS helm_writeback_requests_record ON public.helm_writeback_requests;
CREATE TRIGGER helm_writeback_requests_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_writeback_requests FOR EACH ROW EXECUTE FUNCTION public.helm_integration_record_guard();
DROP TRIGGER IF EXISTS helm_writeback_requests_guard ON public.helm_writeback_requests;
CREATE TRIGGER helm_writeback_requests_guard BEFORE INSERT ON public.helm_writeback_requests FOR EACH ROW EXECUTE FUNCTION public.helm_writeback_requests_guard();

-- ====================================================================== PART 3

ALTER TABLE public.helm_integration_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_writeback_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read integration syncs" ON public.helm_integration_syncs;
CREATE POLICY "Members read integration syncs" ON public.helm_integration_syncs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
DROP POLICY IF EXISTS "Managers record integration syncs" ON public.helm_integration_syncs;
CREATE POLICY "Managers record integration syncs" ON public.helm_integration_syncs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'manager') AND started_by = (select auth.uid()));

-- A write request is read by whoever can see the decision it derives from: visibility, never authority.
DROP POLICY IF EXISTS "Scoped read writeback requests" ON public.helm_writeback_requests;
CREATE POLICY "Scoped read writeback requests" ON public.helm_writeback_requests
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Members dispatch dry-run writebacks" ON public.helm_writeback_requests;
CREATE POLICY "Members dispatch dry-run writebacks" ON public.helm_writeback_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND requested_by = (select auth.uid()) AND helm_private.can_see_decision(decision_id));

-- ====================================================================== PART 4

REVOKE ALL ON TABLE public.helm_integration_syncs, public.helm_writeback_requests FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE public.helm_integration_syncs, public.helm_writeback_requests TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.helm_integration_syncs, public.helm_writeback_requests FROM authenticated;
GRANT ALL ON TABLE public.helm_integration_syncs, public.helm_writeback_requests TO service_role;

REVOKE ALL ON FUNCTION public.helm_integration_record_guard(), public.helm_writeback_requests_guard() FROM PUBLIC, anon;
