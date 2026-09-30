-- ============================================================================
-- HELM — read policies that do not re-read their own row (Phase 6/7 fix)
-- ============================================================================
--
-- Found by the Phase 8 live proof. A SELECT policy of the form
--
--     USING (… AND helm_private.can_see_x(id))
--
-- where can_see_x() looks the row up again BY ID cannot see a row inserted in
-- the same statement: the STABLE helper reads the statement's snapshot. Postgres
-- applies SELECT policies to INSERT … RETURNING, so every client write that
-- reads its own record back — supabase-js .insert().select(), and
-- helm_save_twin_snapshot — is refused, even for an org admin. Four tables had
-- the pattern: helm_decisions, helm_scenarios, helm_scenario_runs,
-- helm_twin_snapshots. Confirmed live in a rolled-back check before this fix.
--
-- The fix keeps the SAME rules. Each is written once over the row's own
-- columns (…_row_visible); the by-id helpers become wrappers over it, so every
-- other policy that references an EXISTING row by id is unchanged in meaning.
-- The twin tables also lose Supabase's default UPDATE/DELETE privileges.
--
-- Additive: CREATE OR REPLACE of helm_private functions, policy replacement,
-- privilege revocation. Nothing of Memoire's is touched.
-- ============================================================================

-- ---------------------------------------------------------------- decisions

CREATE OR REPLACE FUNCTION helm_private.decision_row_visible(p_org uuid, p_decision uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND (
      public.has_org_role(p_org, 'admin')
      OR p_created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.helm_decision_visibility v
        WHERE v.decision_id = p_decision
          AND v.org_unit_id IN (SELECT helm_private.visible_org_units(p_org))
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_decision(p_decision uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.decision_row_visible(d.org_id, d.id, d.created_by) FROM public.helm_decisions d WHERE d.id = p_decision
  ), false);
$fn$;

-- ---------------------------------------------------------------- scenarios

-- ADR-0025 §3: admin ∨ creator ∨ shared unit subtree ∨ bound to a decision the
-- caller can see ∨ ORG_WIDE and bound to none. Binding captures a scenario.
CREATE OR REPLACE FUNCTION helm_private.scenario_row_visible(p_org uuid, p_scenario uuid, p_created_by uuid, p_visibility text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND (
      public.has_org_role(p_org, 'admin')
      OR p_created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.helm_scenario_visibility g
        WHERE g.scenario_id = p_scenario AND g.org_unit_id IN (SELECT helm_private.visible_org_units(p_org))
      )
      OR EXISTS (
        SELECT 1 FROM public.helm_decision_alternatives a
        WHERE a.scenario_id = p_scenario AND helm_private.can_see_decision(a.decision_id)
      )
      OR (
        p_visibility = 'ORG_WIDE'
        AND NOT EXISTS (SELECT 1 FROM public.helm_decision_alternatives a WHERE a.scenario_id = p_scenario)
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_scenario(p_scenario uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.scenario_row_visible(s.org_id, s.id, s.created_by, s.visibility) FROM public.helm_scenarios s WHERE s.id = p_scenario
  ), false);
$fn$;

CREATE OR REPLACE FUNCTION helm_private.scenario_run_row_visible(p_org uuid, p_scenario uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org) AND (p_scenario IS NULL OR helm_private.can_see_scenario(p_scenario));
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_scenario_run(p_run uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.scenario_run_row_visible(r.org_id, r.scenario_id) FROM public.helm_scenario_runs r WHERE r.id = p_run
  ), false);
$fn$;

-- ---------------------------------------------------------------- twin

CREATE OR REPLACE FUNCTION helm_private.twin_snapshot_row_visible(p_org uuid, p_built_by uuid, p_units uuid[])
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND (
      public.has_org_role(p_org, 'admin')
      OR p_built_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM unnest(p_units) g(unit_id)
        WHERE g.unit_id IN (SELECT helm_private.visible_org_units(p_org))
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_twin_snapshot(p_snapshot uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.twin_snapshot_row_visible(s.org_id, s.built_by, s.granted_unit_ids) FROM public.helm_twin_snapshots s WHERE s.id = p_snapshot
  ), false);
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

-- ---------------------------------------------------------------- the four read policies

DROP POLICY IF EXISTS "Scoped read helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped read helm_decisions" ON public.helm_decisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.decision_row_visible(org_id, id, created_by));

DROP POLICY IF EXISTS "Scoped read helm_scenarios" ON public.helm_scenarios;
CREATE POLICY "Scoped read helm_scenarios" ON public.helm_scenarios
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.scenario_row_visible(org_id, id, created_by, visibility));

DROP POLICY IF EXISTS "Scoped read scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Scoped read scenario runs" ON public.helm_scenario_runs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.scenario_run_row_visible(org_id, scenario_id));

DROP POLICY IF EXISTS "Scoped read twin snapshots" ON public.helm_twin_snapshots;
CREATE POLICY "Scoped read twin snapshots" ON public.helm_twin_snapshots
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.twin_snapshot_row_visible(org_id, built_by, granted_unit_ids));

-- Snapshots and their manifests are write-once; clients never held a policy to
-- change them, and now hold no privilege to either.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.helm_twin_snapshots, public.helm_twin_snapshot_items FROM authenticated;
