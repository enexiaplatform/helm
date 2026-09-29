-- ============================================================================
-- HELM Phase 7 — Management Digital Twin, and the hardening it depends on
-- ============================================================================
--
-- ADR-0023 (twin), ADR-0024 (trusted authority runtime), ADR-0025 (sensitivity,
-- scenario visibility, private helpers, decision-type tenancy).
--
--   PART 1  helm_private: the SECURITY DEFINER visibility helpers move out of the
--           API-exposed public schema; sensitivity and scenario helpers join them
--   PART 2  every Phase 6 policy re-pointed at helm_private; the public helpers dropped
--   PART 3  sensitivity classes on metrics and value nodes; clearances
--   PART 4  scenario visibility: capture by binding, explicit grants, and the
--           values, runs and steps underneath follow the scenario and the class
--   PART 5  decision types: system canonical + organization extension
--   PART 6  the trusted authority path: only the service writes verdicts,
--           requirements and approval acts; evaluations carry their evaluator;
--           an occupancy's end carries the record time it was learned
--   PART 7  helm_twin_snapshots / helm_twin_snapshot_items / the atomic save
--
-- Additive for Memoire: no Memoire table, column, policy or function is
-- touched. Every statement below is on a helm_* object, the shared-core
-- membership tables are only READ, and the pre-Phase-7 public functions
-- Memoire relies on (is_org_member, has_org_role, …) are unchanged.
-- ============================================================================

-- ====================================================================== PART 3
-- (created first: PART 1's helpers read these tables)

ALTER TABLE public.helm_value_metrics
  ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'GENERAL_MANAGEMENT'
    CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'));
ALTER TABLE public.helm_value_nodes
  ADD COLUMN IF NOT EXISTS sensitivity text
    CHECK (sensitivity IS NULL OR sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED'));

-- The shipped classes (twin-runtime METRIC_SENSITIVITY; verify:twin-schema holds them equal).
UPDATE public.helm_value_metrics SET sensitivity = 'FINANCIAL_SENSITIVE'
  WHERE org_id IS NULL AND key IN ('GrossMargin', 'GrossMarginPct', 'Cogs', 'CashImpact', 'WorkingCapital', 'UnitCost', 'Opex', 'InventoryValue', 'Ebitda');
UPDATE public.helm_value_metrics SET sensitivity = 'COMMERCIAL_CONFIDENTIAL'
  WHERE org_id IS NULL AND key IN ('AverageSellingPrice', 'OpportunityValue', 'OpportunityProbability', 'ExpectedRevenue', 'CustomerValue', 'RevenueAtRisk');
UPDATE public.helm_value_metrics SET sensitivity = 'STRATEGIC_RESTRICTED'
  WHERE org_id IS NULL AND key IN ('StrategicAlignment');

CREATE TABLE IF NOT EXISTS public.helm_sensitivity_clearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sensitivity text NOT NULL CHECK (sensitivity IN ('FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz CHECK (valid_to IS NULL OR valid_to > valid_from),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 4),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helm_sensitivity_clearances_user_idx ON public.helm_sensitivity_clearances (org_id, user_id, sensitivity);
-- Deny-all from the moment it exists; its policies follow below.
ALTER TABLE public.helm_sensitivity_clearances ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.helm_sensitivity_clearances_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_sensitivity_clearances: a clearance is a record of what was granted; it is never edited or deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'helm_sensitivity_clearances: a clearance is granted to a member of the organization';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_sensitivity_clearances_guard ON public.helm_sensitivity_clearances;
CREATE TRIGGER helm_sensitivity_clearances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_sensitivity_clearances
  FOR EACH ROW EXECUTE FUNCTION public.helm_sensitivity_clearances_guard();

ALTER TABLE public.helm_scenarios
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED'));

CREATE TABLE IF NOT EXISTS public.helm_scenario_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scenario_id uuid NOT NULL REFERENCES public.helm_scenarios(id) ON DELETE CASCADE,
  org_unit_id uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE,
  org_unit_label text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 4),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, org_unit_id)
);
ALTER TABLE public.helm_scenario_visibility ENABLE ROW LEVEL SECURITY;

-- ====================================================================== PART 1

CREATE SCHEMA IF NOT EXISTS helm_private;
REVOKE ALL ON SCHEMA helm_private FROM PUBLIC;
GRANT USAGE ON SCHEMA helm_private TO authenticated, service_role;
COMMENT ON SCHEMA helm_private IS
  'HELM helpers used inside RLS policies. Not exposed through the API: callable by the policies that need them, not by a client over REST.';

CREATE OR REPLACE FUNCTION helm_private.visible_org_units(p_org uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH RECURSIVE reach(id) AS (
    SELECT m.unit_id FROM public.org_unit_memberships m
    WHERE m.org_id = p_org AND m.user_id = auth.uid()
    UNION
    SELECT u.id FROM public.org_units u JOIN reach r ON u.parent_id = r.id
    WHERE u.org_id = p_org
  )
  SELECT id FROM reach;
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_decision(p_decision uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_decisions d
    WHERE d.id = p_decision
      AND public.is_org_member(d.org_id)
      AND (
        public.has_org_role(d.org_id, 'admin')
        OR d.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.helm_decision_visibility v
          WHERE v.decision_id = d.id
            AND v.org_unit_id IN (SELECT helm_private.visible_org_units(d.org_id))
        )
      )
  );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_revision(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_decision_revisions r
    WHERE r.id = p_revision AND helm_private.can_see_decision(r.decision_id)
  );
$fn$;

-- GENERAL_MANAGEMENT needs no clearance; admins hold every class; otherwise an
-- explicit clearance open now. Classes are compartments, not levels.
CREATE OR REPLACE FUNCTION helm_private.has_clearance(p_org uuid, p_sensitivity text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(p_sensitivity, 'GENERAL_MANAGEMENT') = 'GENERAL_MANAGEMENT'
    OR public.has_org_role(p_org, 'admin')
    OR EXISTS (
      SELECT 1 FROM public.helm_sensitivity_clearances c
      WHERE c.org_id = p_org AND c.user_id = auth.uid() AND c.sensitivity = p_sensitivity
        AND c.valid_from <= now() AND (c.valid_to IS NULL OR c.valid_to > now())
    );
$fn$;

-- A value's class: its node's declared class, else its metric's.
CREATE OR REPLACE FUNCTION helm_private.node_sensitivity(p_node uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(n.sensitivity, m.sensitivity, 'GENERAL_MANAGEMENT')
  FROM public.helm_value_nodes n JOIN public.helm_value_metrics m ON m.id = n.metric_id
  WHERE n.id = p_node;
$fn$;

-- A step is readable only when every value it carries is: its output and each input.
CREATE OR REPLACE FUNCTION helm_private.step_cleared(p_org uuid, p_output_node uuid, p_inputs jsonb)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT helm_private.has_clearance(p_org, helm_private.node_sensitivity(p_output_node))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb)) i
      WHERE NOT helm_private.has_clearance(
        p_org,
        coalesce((SELECT m.sensitivity FROM public.helm_value_metrics m
                  WHERE m.key = i->>'metricKey' AND (m.org_id IS NULL OR m.org_id = p_org)
                  ORDER BY m.org_id NULLS LAST LIMIT 1), 'GENERAL_MANAGEMENT'))
    );
$fn$;

-- Scenario visibility (ADR-0025 §3): admin ∨ creator ∨ shared unit subtree
-- ∨ bound to a decision the caller can see ∨ ORG_WIDE and bound to none.
-- Binding CAPTURES a scenario: the org-wide default stops applying.
CREATE OR REPLACE FUNCTION helm_private.can_see_scenario(p_scenario uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_scenarios s
    WHERE s.id = p_scenario
      AND public.is_org_member(s.org_id)
      AND (
        public.has_org_role(s.org_id, 'admin')
        OR s.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.helm_scenario_visibility g
          WHERE g.scenario_id = s.id AND g.org_unit_id IN (SELECT helm_private.visible_org_units(s.org_id))
        )
        OR EXISTS (
          SELECT 1 FROM public.helm_decision_alternatives a
          WHERE a.scenario_id = s.id AND helm_private.can_see_decision(a.decision_id)
        )
        OR (
          s.visibility = 'ORG_WIDE'
          AND NOT EXISTS (SELECT 1 FROM public.helm_decision_alternatives a WHERE a.scenario_id = s.id)
        )
      )
  );
$fn$;

-- A value tagged with a Scenario entity follows the scenario that entity belongs to.
CREATE OR REPLACE FUNCTION helm_private.can_see_scenario_entity(p_org uuid, p_entity uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT p_entity IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.helm_scenarios s WHERE s.org_id = p_org AND s.scenario_entity_id = p_entity)
    OR EXISTS (
      SELECT 1 FROM public.helm_scenarios s
      WHERE s.org_id = p_org AND s.scenario_entity_id = p_entity AND helm_private.can_see_scenario(s.id)
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_scenario_run(p_run uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_scenario_runs r
    WHERE r.id = p_run AND public.is_org_member(r.org_id)
      AND (r.scenario_id IS NULL OR helm_private.can_see_scenario(r.scenario_id))
  );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_calculation_run(p_run uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_calculation_runs r
    WHERE r.id = p_run AND public.is_org_member(r.org_id)
      AND helm_private.can_see_scenario_entity(r.org_id, r.scenario_entity_id)
  );
$fn$;

-- ====================================================================== PART 7 (tables, before their helper)

CREATE TABLE IF NOT EXISTS public.helm_twin_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('CURRENT', 'HISTORICAL', 'EXPECTED', 'SCENARIO', 'COMMITTED_FUTURE')),
  label text NOT NULL CHECK (char_length(btrim(label)) >= 1),
  -- The two-time lens (ADR-0014): business time and knowledge boundary, both explicit.
  effective_as_of timestamptz NOT NULL,
  recorded_through timestamptz NOT NULL,
  scope jsonb NOT NULL,
  scope_key text NOT NULL,
  periods text[] NOT NULL CHECK (cardinality(periods) >= 1),
  scenario_run_id uuid REFERENCES public.helm_scenario_runs(id) ON DELETE RESTRICT,
  commitment_id uuid REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  model jsonb NOT NULL,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  completeness text NOT NULL CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'DEGRADED', 'INVALID')),
  completeness_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_classes text[] NOT NULL,
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  item_count integer NOT NULL CHECK (item_count >= 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^tws_[0-9a-f]{16}_[0-9]+$'),
  previous_snapshot_id uuid REFERENCES public.helm_twin_snapshots(id) ON DELETE RESTRICT,
  built_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A snapshot cannot know what was recorded after it was built.
  CHECK (recorded_through <= created_at),
  CHECK ((kind = 'SCENARIO') = (scenario_run_id IS NOT NULL)),
  CHECK ((kind = 'COMMITTED_FUTURE') = (commitment_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS helm_twin_snapshots_scope_idx ON public.helm_twin_snapshots (org_id, kind, scope_key, created_at);
ALTER TABLE public.helm_twin_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.helm_twin_snapshot_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.helm_twin_snapshots(id) ON DELETE RESTRICT,
  item_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ENTITY', 'RELATIONSHIP', 'ROLE_OCCUPANCY', 'VALUE', 'CONSTRAINT', 'OBJECTIVE', 'DECISION', 'COMMITMENT', 'ACTION_INTENT', 'GOVERNANCE', 'POLICY', 'DELEGATION', 'ASSUMPTION', 'CHALLENGE', 'ATTENTION')),
  categories text[] NOT NULL,
  label text NOT NULL,
  subject_entity_id uuid,
  layer text CHECK (layer IS NULL OR layer IN ('ACTUAL', 'FORECAST', 'ESTIMATE', 'ASSUMED', 'TARGET', 'MODELLED', 'SCENARIO', 'COMMITTED_FUTURE')),
  status text NOT NULL CHECK (status IN ('KNOWN', 'UNKNOWN', 'BLOCKED', 'UNAVAILABLE')),
  state jsonb NOT NULL,
  -- A twin item always names the kernel object it came from.
  refs jsonb NOT NULL CHECK (jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) > 0),
  sensitivity text NOT NULL CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  reason text,
  ordinal integer NOT NULL,
  UNIQUE (snapshot_id, item_key)
);
CREATE INDEX IF NOT EXISTS helm_twin_snapshot_items_snapshot_idx ON public.helm_twin_snapshot_items (snapshot_id, ordinal);
ALTER TABLE public.helm_twin_snapshot_items ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION helm_private.can_see_twin_snapshot(p_snapshot uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_twin_snapshots s
    WHERE s.id = p_snapshot
      AND public.is_org_member(s.org_id)
      AND (
        public.has_org_role(s.org_id, 'admin')
        OR s.built_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM unnest(s.granted_unit_ids) g(unit_id)
          WHERE g.unit_id IN (SELECT helm_private.visible_org_units(s.org_id))
        )
      )
  );
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

-- ====================================================================== PART 2

DROP POLICY IF EXISTS "Scoped read governance profiles" ON public.helm_decision_governance_profiles;
CREATE POLICY "Scoped read governance profiles" ON public.helm_decision_governance_profiles
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped classify decisions" ON public.helm_decision_governance_profiles;
CREATE POLICY "Scoped classify decisions" ON public.helm_decision_governance_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id) AND declared_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read visibility grants" ON public.helm_decision_visibility;
CREATE POLICY "Scoped read visibility grants" ON public.helm_decision_visibility
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped share decisions" ON public.helm_decision_visibility;
CREATE POLICY "Scoped share decisions" ON public.helm_decision_visibility
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id) AND granted_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read authority evaluations" ON public.helm_authority_evaluations;
CREATE POLICY "Scoped read authority evaluations" ON public.helm_authority_evaluations
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped read required approvals" ON public.helm_required_approvals;
CREATE POLICY "Scoped read required approvals" ON public.helm_required_approvals
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped read approval acts" ON public.helm_approval_acts;
CREATE POLICY "Scoped read approval acts" ON public.helm_approval_acts
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));

DROP POLICY IF EXISTS "Scoped read helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped read helm_decisions" ON public.helm_decisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(id));
DROP POLICY IF EXISTS "Scoped update helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped update helm_decisions" ON public.helm_decisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(id));
DROP POLICY IF EXISTS "Scoped delete helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped delete helm_decisions" ON public.helm_decisions
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager') AND helm_private.can_see_decision(id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions',
    'helm_decision_revisions', 'helm_decision_criteria', 'helm_decision_challenges',
    'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
    'helm_decision_outcome_reviews'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped read %s" ON public.%I FOR SELECT TO authenticated
         USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped read %s" ON public.%I FOR SELECT TO authenticated
         USING (public.is_org_member(org_id) AND helm_private.can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_revisions', 'helm_decision_criteria', 'helm_decision_challenges',
    'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
    'helm_decision_outcome_reviews'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped write %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped write %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND helm_private.can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped write %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped write %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND helm_private.can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped insert %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped insert %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND helm_private.can_see_decision(decision_id));', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped update %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped update %s" ON public.%I FOR UPDATE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND helm_private.can_see_decision(decision_id))
         WITH CHECK (public.has_org_role(org_id, ''member'') AND helm_private.can_see_decision(decision_id));', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped delete %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped delete %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''manager'') AND helm_private.can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criteria', 'helm_decision_evidence'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped remove draft %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped remove draft %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND helm_private.can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Scoped remove draft %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped remove draft %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND helm_private.can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS "Scoped seal decision revisions" ON public.helm_decision_revisions;
CREATE POLICY "Scoped seal decision revisions" ON public.helm_decision_revisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id));

DROP POLICY IF EXISTS "Scoped resolve decision challenges" ON public.helm_decision_challenges;
CREATE POLICY "Scoped resolve decision challenges" ON public.helm_decision_challenges
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_decision(decision_id));

DROP POLICY IF EXISTS "Scoped read decision events" ON public.helm_decision_events;
CREATE POLICY "Scoped read decision events" ON public.helm_decision_events
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped append decision events" ON public.helm_decision_events;
CREATE POLICY "Scoped append decision events" ON public.helm_decision_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member')
    AND helm_private.can_see_decision(decision_id)
    AND actor_id = (select auth.uid())
  );

-- Verdicts, requirements and approval acts are written by the trusted authority
-- service only (service_role, from the helm-authority edge function). A client
-- can ask for an evaluation; it can no longer record one (ADR-0024). These three
-- client-write policies are the last references to the public helpers.
DROP POLICY IF EXISTS "Scoped record authority evaluations" ON public.helm_authority_evaluations;
DROP POLICY IF EXISTS "Scoped record required approvals" ON public.helm_required_approvals;
DROP POLICY IF EXISTS "Approvers record their own acts" ON public.helm_approval_acts;

-- Nothing references the public helpers any more.
DROP FUNCTION IF EXISTS public.helm_can_see_revision(uuid);
DROP FUNCTION IF EXISTS public.helm_can_see_decision(uuid);
DROP FUNCTION IF EXISTS public.helm_visible_org_units(uuid);

-- ====================================================================== PART 3 (RLS)

ALTER TABLE public.helm_sensitivity_clearances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read own or administer clearances" ON public.helm_sensitivity_clearances;
CREATE POLICY "Read own or administer clearances" ON public.helm_sensitivity_clearances
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND (user_id = (select auth.uid()) OR public.has_org_role(org_id, 'admin')));
DROP POLICY IF EXISTS "Admins grant clearances" ON public.helm_sensitivity_clearances;
CREATE POLICY "Admins grant clearances" ON public.helm_sensitivity_clearances
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'admin') AND granted_by = (select auth.uid()));

-- ====================================================================== PART 4

ALTER TABLE public.helm_scenario_visibility ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Scoped read scenario visibility" ON public.helm_scenario_visibility;
CREATE POLICY "Scoped read scenario visibility" ON public.helm_scenario_visibility
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario(scenario_id));
DROP POLICY IF EXISTS "Scoped share scenarios" ON public.helm_scenario_visibility;
CREATE POLICY "Scoped share scenarios" ON public.helm_scenario_visibility
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(scenario_id) AND granted_by = (select auth.uid()));

DROP POLICY IF EXISTS "Members read helm_scenarios" ON public.helm_scenarios;
DROP POLICY IF EXISTS "Scoped read helm_scenarios" ON public.helm_scenarios;
CREATE POLICY "Scoped read helm_scenarios" ON public.helm_scenarios
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario(id));
DROP POLICY IF EXISTS "Members update helm_scenarios" ON public.helm_scenarios;
DROP POLICY IF EXISTS "Scoped update helm_scenarios" ON public.helm_scenarios;
CREATE POLICY "Scoped update helm_scenarios" ON public.helm_scenarios
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(id));

DROP POLICY IF EXISTS "Members read scenario revisions" ON public.helm_scenario_revisions;
DROP POLICY IF EXISTS "Scoped read scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Scoped read scenario revisions" ON public.helm_scenario_revisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario(scenario_id));
DROP POLICY IF EXISTS "Members create scenario revisions" ON public.helm_scenario_revisions;
DROP POLICY IF EXISTS "Scoped create scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Scoped create scenario revisions" ON public.helm_scenario_revisions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()) AND helm_private.can_see_scenario(scenario_id));
DROP POLICY IF EXISTS "Members seal scenario revisions" ON public.helm_scenario_revisions;
DROP POLICY IF EXISTS "Scoped seal scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Scoped seal scenario revisions" ON public.helm_scenario_revisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(scenario_id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(scenario_id));

DROP POLICY IF EXISTS "Members read scenario overrides" ON public.helm_scenario_overrides;
DROP POLICY IF EXISTS "Scoped read scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Scoped read scenario overrides" ON public.helm_scenario_overrides
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario(scenario_id));
DROP POLICY IF EXISTS "Members add scenario overrides" ON public.helm_scenario_overrides;
DROP POLICY IF EXISTS "Scoped add scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Scoped add scenario overrides" ON public.helm_scenario_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()) AND helm_private.can_see_scenario(scenario_id));
DROP POLICY IF EXISTS "Members remove draft scenario overrides" ON public.helm_scenario_overrides;
DROP POLICY IF EXISTS "Scoped remove draft scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Scoped remove draft scenario overrides" ON public.helm_scenario_overrides
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'member') AND helm_private.can_see_scenario(scenario_id));

DROP POLICY IF EXISTS "Members read scenario runs" ON public.helm_scenario_runs;
DROP POLICY IF EXISTS "Scoped read scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Scoped read scenario runs" ON public.helm_scenario_runs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario_run(id));
DROP POLICY IF EXISTS "Members start scenario runs" ON public.helm_scenario_runs;
DROP POLICY IF EXISTS "Scoped start scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Scoped start scenario runs" ON public.helm_scenario_runs
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND created_by = (select auth.uid())
    AND (scenario_id IS NULL OR helm_private.can_see_scenario(scenario_id))
  );

DROP POLICY IF EXISTS "Members read constraint results" ON public.helm_scenario_constraint_results;
DROP POLICY IF EXISTS "Scoped read constraint results" ON public.helm_scenario_constraint_results;
CREATE POLICY "Scoped read constraint results" ON public.helm_scenario_constraint_results
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_scenario_run(scenario_run_id));

-- Values follow their scenario and their class; runs and steps likewise.
DROP POLICY IF EXISTS helm_value_observations_read ON public.helm_value_observations;
DROP POLICY IF EXISTS "Scoped read value observations" ON public.helm_value_observations;
CREATE POLICY "Scoped read value observations" ON public.helm_value_observations
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(org_id)
    AND helm_private.has_clearance(org_id, helm_private.node_sensitivity(node_id))
    AND helm_private.can_see_scenario_entity(org_id, scenario_entity_id)
  );

DROP POLICY IF EXISTS helm_calculation_runs_read ON public.helm_calculation_runs;
DROP POLICY IF EXISTS "Scoped read calculation runs" ON public.helm_calculation_runs;
CREATE POLICY "Scoped read calculation runs" ON public.helm_calculation_runs
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.can_see_scenario_entity(org_id, scenario_entity_id));

DROP POLICY IF EXISTS helm_calculation_steps_read ON public.helm_calculation_steps;
DROP POLICY IF EXISTS "Scoped read calculation steps" ON public.helm_calculation_steps;
CREATE POLICY "Scoped read calculation steps" ON public.helm_calculation_steps
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(org_id)
    AND helm_private.can_see_calculation_run(run_id)
    AND helm_private.step_cleared(org_id, output_node_id, inputs)
  );

-- ====================================================================== PART 5

-- System canonical types (org_id NULL) and organization extensions, keyed so an
-- organization's type can never shadow a system one and two organizations'
-- types never collide.
--
-- The two foreign keys onto helm_decision_types(key) are SUPERSEDED, not
-- removed: a foreign key cannot say "a system type, or one of this row's own
-- organization's", so the reference moves to helm_decision_type_ref_guard
-- below (tenancy-aware), and each table gains the key-format constraint the
-- registry itself enforces.
ALTER TABLE public.helm_decision_governance_profiles DROP CONSTRAINT IF EXISTS helm_decision_governance_profiles_decision_type_key_fkey;
ALTER TABLE public.helm_decision_governance_profiles DROP CONSTRAINT IF EXISTS helm_decision_governance_profiles_decision_type_key_format;
ALTER TABLE public.helm_decision_governance_profiles
  ADD CONSTRAINT helm_decision_governance_profiles_decision_type_key_format
  CHECK (decision_type_key IS NULL OR decision_type_key ~ '^[A-Z][A-Z_]{1,62}$');
ALTER TABLE public.helm_authority_evaluations DROP CONSTRAINT IF EXISTS helm_authority_evaluations_decision_type_key_fkey;
ALTER TABLE public.helm_authority_evaluations DROP CONSTRAINT IF EXISTS helm_authority_evaluations_decision_type_key_format;
ALTER TABLE public.helm_authority_evaluations
  ADD CONSTRAINT helm_authority_evaluations_decision_type_key_format
  CHECK (decision_type_key IS NULL OR decision_type_key ~ '^[A-Z][A-Z_]{1,62}$');
ALTER TABLE public.helm_decision_types ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.helm_decision_types DROP CONSTRAINT IF EXISTS helm_decision_types_pkey;
ALTER TABLE public.helm_decision_types ADD CONSTRAINT helm_decision_types_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS helm_decision_types_system_key ON public.helm_decision_types (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS helm_decision_types_org_key ON public.helm_decision_types (org_id, key) WHERE org_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.helm_decision_types_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_decision_types: a decision type is registry data; it is never edited or deleted';
  END IF;
  IF NEW.org_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.helm_decision_types t WHERE t.org_id IS NULL AND t.key = NEW.key) THEN
    RAISE EXCEPTION 'helm_decision_types: % is a HELM system type; an organization extends the registry, it does not redefine it', NEW.key;
  END IF;
  IF NEW.org_id IS NULL AND EXISTS (SELECT 1 FROM public.helm_decision_types t WHERE t.org_id IS NOT NULL AND t.key = NEW.key) THEN
    RAISE EXCEPTION 'helm_decision_types: an organization already registered %; a system type would make it ambiguous', NEW.key;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_decision_types_guard ON public.helm_decision_types;
CREATE TRIGGER helm_decision_types_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_types
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_types_guard();

-- What a profile or an evaluation names must be a system type or one of its own organization's.
CREATE OR REPLACE FUNCTION public.helm_decision_type_ref_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.decision_type_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.helm_decision_types t
    WHERE t.key = NEW.decision_type_key AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
  ) THEN
    RAISE EXCEPTION '%: % is neither a HELM decision type nor one of this organization''s', TG_TABLE_NAME, NEW.decision_type_key;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_decision_type_ref_guard ON public.helm_decision_governance_profiles;
CREATE TRIGGER helm_decision_type_ref_guard
  BEFORE INSERT ON public.helm_decision_governance_profiles
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_type_ref_guard();
DROP TRIGGER IF EXISTS helm_decision_type_ref_guard ON public.helm_authority_evaluations;
CREATE TRIGGER helm_decision_type_ref_guard
  BEFORE INSERT ON public.helm_authority_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_type_ref_guard();

-- ====================================================================== PART 6

-- The client-write policies were dropped in PART 2; the table privileges go too.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.helm_authority_evaluations, public.helm_required_approvals, public.helm_approval_acts FROM authenticated;

ALTER TABLE public.helm_authority_evaluations
  ADD COLUMN IF NOT EXISTS evaluator jsonb NOT NULL
    DEFAULT '{"kind": "TRUSTED_SERVICE", "host": "edge:helm-authority", "consequenceCheck": {"status": "NOT_CHECKED", "runIds": [], "checkedSteps": 0, "checkedInputs": 0}}'::jsonb
    CHECK (evaluator->>'kind' = 'TRUSTED_SERVICE');

-- The approver of an act written by the service is the verified caller, and is
-- a member of the organization; every Phase 6 seat and delegation check stands.
CREATE OR REPLACE FUNCTION public.helm_approval_acts_member_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.approver_user_id) THEN
    RAISE EXCEPTION 'helm_approval_acts: the approver is a member of the organization';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_approval_acts_member_guard ON public.helm_approval_acts;
CREATE TRIGGER helm_approval_acts_member_guard
  BEFORE INSERT ON public.helm_approval_acts
  FOR EACH ROW EXECUTE FUNCTION public.helm_approval_acts_member_guard();

-- An occupancy's end carries the RECORD time it was learned.
ALTER TABLE public.helm_role_occupancies ADD COLUMN IF NOT EXISTS ended_at timestamptz;

CREATE OR REPLACE FUNCTION public.helm_role_occupancies_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_role_occupancies: who held a role, and when, is history and is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.helm_entities e
      WHERE e.id = NEW.role_id AND e.org_id = NEW.org_id AND e.entity_type_id = 'et_role'
    ) THEN
      RAISE EXCEPTION 'helm_role_occupancies: an occupancy names a Role entity of this organization';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'helm_role_occupancies: an occupancy is recorded unended; its end is recorded when it happens';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the only change is ending an open occupancy, once — stamped with when HELM learned it.
  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'helm_role_occupancies: that occupancy has already ended; its history is not rewritten';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.role_id <> OLD.role_id OR NEW.user_id <> OLD.user_id
     OR NEW.kind <> OLD.kind OR NEW.valid_from <> OLD.valid_from OR NEW.basis <> OLD.basis
     OR NEW.recorded_at <> OLD.recorded_at OR NEW.person_label <> OLD.person_label THEN
    RAISE EXCEPTION 'helm_role_occupancies: only the end of an occupancy may be recorded';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END;
$fn$;

-- ====================================================================== PART 7

CREATE OR REPLACE FUNCTION public.helm_twin_snapshots_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  prev record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_twin_snapshots: a snapshot is immutable; a correction is a new snapshot';
  END IF;
  IF NEW.previous_snapshot_id IS NOT NULL THEN
    SELECT * INTO prev FROM public.helm_twin_snapshots WHERE id = NEW.previous_snapshot_id;
    IF prev IS NULL OR prev.org_id <> NEW.org_id THEN
      RAISE EXCEPTION 'helm_twin_snapshots: the previous snapshot is not in this organization';
    END IF;
    IF prev.kind <> 'CURRENT' OR NEW.kind <> 'CURRENT' OR prev.scope_key <> NEW.scope_key THEN
      RAISE EXCEPTION 'helm_twin_snapshots: only a CURRENT snapshot follows a CURRENT snapshot of the same scope';
    END IF;
    IF prev.recorded_through > NEW.recorded_through THEN
      RAISE EXCEPTION 'helm_twin_snapshots: current state only moves forward in knowledge';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_twin_snapshots_guard ON public.helm_twin_snapshots;
CREATE TRIGGER helm_twin_snapshots_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_twin_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.helm_twin_snapshots_guard();

CREATE OR REPLACE FUNCTION public.helm_twin_snapshot_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_twin_snapshot_items: a manifest item is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.helm_twin_snapshots s WHERE s.id = NEW.snapshot_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_twin_snapshot_items: the snapshot is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_twin_snapshot_items_guard ON public.helm_twin_snapshot_items;
CREATE TRIGGER helm_twin_snapshot_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_twin_snapshot_items
  FOR EACH ROW EXECUTE FUNCTION public.helm_twin_snapshot_items_guard();

-- At commit: the manifest is exactly as long as the header says, and the
-- header's sensitivity label is the union of its items' classes.
CREATE OR REPLACE FUNCTION public.helm_twin_snapshot_complete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
  classes text[];
BEGIN
  SELECT count(*), coalesce(array_agg(DISTINCT sensitivity ORDER BY sensitivity), '{}') INTO n, classes
  FROM public.helm_twin_snapshot_items WHERE snapshot_id = NEW.id;
  IF n <> NEW.item_count THEN
    RAISE EXCEPTION 'helm_twin_snapshots: the manifest holds % items, the header claims %', n, NEW.item_count;
  END IF;
  IF classes <> (SELECT coalesce(array_agg(c ORDER BY c), '{}') FROM unnest(NEW.sensitivity_classes) c) THEN
    RAISE EXCEPTION 'helm_twin_snapshots: the sensitivity label is derived from the items and does not match them';
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_twin_snapshot_complete_guard ON public.helm_twin_snapshots;
CREATE CONSTRAINT TRIGGER helm_twin_snapshot_complete_guard
  AFTER INSERT ON public.helm_twin_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.helm_twin_snapshot_complete_guard();

-- One call, one transaction: the header and its manifest, or neither. SECURITY
-- INVOKER — it writes under the caller's own RLS and grants nothing.
CREATE OR REPLACE FUNCTION public.helm_save_twin_snapshot(p_header jsonb, p_items jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.helm_twin_snapshots (
    org_id, kind, label, effective_as_of, recorded_through, scope, scope_key, periods, scenario_run_id, commitment_id,
    model, source_references, completeness, completeness_reasons, sensitivity_classes, granted_unit_ids, item_count,
    fingerprint, previous_snapshot_id, built_by, created_at
  ) VALUES (
    (p_header->>'org_id')::uuid, p_header->>'kind', p_header->>'label', (p_header->>'effective_as_of')::timestamptz,
    (p_header->>'recorded_through')::timestamptz, p_header->'scope', p_header->>'scope_key',
    ARRAY(SELECT jsonb_array_elements_text(p_header->'periods')),
    nullif(p_header->>'scenario_run_id', '')::uuid, nullif(p_header->>'commitment_id', '')::uuid,
    p_header->'model', coalesce(p_header->'source_references', '[]'::jsonb), p_header->>'completeness',
    coalesce(p_header->'completeness_reasons', '[]'::jsonb),
    ARRAY(SELECT jsonb_array_elements_text(p_header->'sensitivity_classes')),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_header->'granted_unit_ids', '[]'::jsonb))::uuid),
    (p_header->>'item_count')::integer, p_header->>'fingerprint', nullif(p_header->>'previous_snapshot_id', '')::uuid,
    auth.uid(), coalesce((p_header->>'created_at')::timestamptz, now())
  )
  RETURNING id INTO new_id;

  INSERT INTO public.helm_twin_snapshot_items (
    org_id, snapshot_id, item_key, kind, categories, label, subject_entity_id, layer, status, state, refs, sensitivity, reason, ordinal
  )
  SELECT
    (p_header->>'org_id')::uuid, new_id, i->>'key', i->>'kind', ARRAY(SELECT jsonb_array_elements_text(i->'categories')),
    i->>'label', nullif(i->>'subjectEntityId', '')::uuid, i->>'layer', i->>'status', i->'state', i->'refs',
    i->>'sensitivity', i->>'reason', (ord - 1)::integer
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(i, ord);

  RETURN new_id;
END;
$fn$;

ALTER TABLE public.helm_twin_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_twin_snapshot_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Scoped read twin snapshots" ON public.helm_twin_snapshots;
CREATE POLICY "Scoped read twin snapshots" ON public.helm_twin_snapshots
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_twin_snapshot(id));
DROP POLICY IF EXISTS "Members build twin snapshots" ON public.helm_twin_snapshots;
CREATE POLICY "Members build twin snapshots" ON public.helm_twin_snapshots
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND built_by = (select auth.uid()));

-- An item is read where its snapshot is read AND its own class is cleared.
DROP POLICY IF EXISTS "Scoped read twin items" ON public.helm_twin_snapshot_items;
CREATE POLICY "Scoped read twin items" ON public.helm_twin_snapshot_items
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(org_id)
    AND helm_private.can_see_twin_snapshot(snapshot_id)
    AND helm_private.has_clearance(org_id, sensitivity)
  );
DROP POLICY IF EXISTS "Builders write twin items" ON public.helm_twin_snapshot_items;
CREATE POLICY "Builders write twin items" ON public.helm_twin_snapshot_items
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member')
    AND EXISTS (SELECT 1 FROM public.helm_twin_snapshots s WHERE s.id = snapshot_id AND s.built_by = (select auth.uid()))
  );

-- ------------------------------------------------------------------ grants

REVOKE ALL ON TABLE
  public.helm_twin_snapshots, public.helm_twin_snapshot_items, public.helm_sensitivity_clearances, public.helm_scenario_visibility
FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE
  public.helm_twin_snapshots, public.helm_twin_snapshot_items, public.helm_sensitivity_clearances, public.helm_scenario_visibility
TO authenticated;
GRANT ALL ON TABLE
  public.helm_twin_snapshots, public.helm_twin_snapshot_items, public.helm_sensitivity_clearances, public.helm_scenario_visibility
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_sensitivity_clearances_guard(), public.helm_decision_types_guard(), public.helm_decision_type_ref_guard(),
  public.helm_approval_acts_member_guard(), public.helm_twin_snapshots_guard(), public.helm_twin_snapshot_items_guard(),
  public.helm_twin_snapshot_complete_guard(), public.helm_save_twin_snapshot(jsonb, jsonb)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_save_twin_snapshot(jsonb, jsonb) TO authenticated, service_role;
