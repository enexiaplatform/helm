-- ============================================================================
-- HELM Phase 10 — Counterfactual Engine
-- ============================================================================
--
-- ADR-0029 (ex-post alternative worlds, anchored to the decision boundary).
--
--   PART 1  cases, worlds and reviews
--   PART 2  guards: write-once, record time stamped by the database, same-org
--           references, a boundary that is the commitment's own, an anchor known
--           at or before it, AS_KNOWN_THEN without hindsight and WITH_HINDSIGHT
--           with it (the lenses cannot be blended in storage), ESTIMATED only
--           where a scenario run stands behind the world
--   PART 3  helm_private row rules and scoped RLS (row-based: a read policy
--           never re-reads its own row by id, so INSERT … RETURNING works)
--   PART 4  grants
--   PART 5  widening: a Management Genome episode may reference a case
--
-- Scenario ≠ Counterfactual. AS_KNOWN_THEN ≠ WITH_HINDSIGHT. Nothing here
-- stores a regret, a score, a probability or a verdict; a comparison and a
-- world's causal support are derived at a lens and never stored. Nothing here
-- writes a decision, a commitment, an observation, a causal claim or an
-- authority rule.
--
-- Additive for Memoire: every statement is on a helm_* object or in
-- helm_private; the shared-core membership tables are only READ.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_counterfactual_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  -- A counterfactual reviews a decision management committed to.
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  question text NOT NULL CHECK (char_length(btrim(question)) >= 1),
  -- What differs from reality. Explicit; never proposed by HELM.
  intervention jsonb NOT NULL CHECK (
    (intervention->>'kind' = 'CHOOSE_ALTERNATIVE' AND char_length(btrim(coalesce(intervention->>'alternativeId', ''))) >= 1)
    OR (
      intervention->>'kind' = 'OVERRIDES'
      AND char_length(btrim(coalesce(intervention->>'label', ''))) >= 1
      AND jsonb_typeof(intervention->'overrides') = 'array'
      AND jsonb_array_length(intervention->'overrides') >= 1
    )
  ),
  -- The historical state the world is anchored to: a twin snapshot known at or before the boundary.
  anchor_snapshot_id uuid NOT NULL REFERENCES public.helm_twin_snapshots(id) ON DELETE RESTRICT,
  anchor_effective timestamptz NOT NULL,
  anchor_recorded timestamptz NOT NULL,
  -- The knowledge boundary management decided under: the commitment.
  boundary_effective timestamptz NOT NULL,
  boundary_recorded timestamptz NOT NULL,
  -- The metrics compared, copied from what the commitment expected to move.
  compared jsonb NOT NULL CHECK (jsonb_typeof(compared) = 'array' AND jsonb_array_length(compared) >= 1),
  scope jsonb NOT NULL,
  -- Derived from the compared metrics, plus any class the case declares — never fewer.
  sensitivity_classes text[] NOT NULL CHECK (sensitivity_classes <@ ARRAY['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED']),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  authored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  authored_by_label text NOT NULL CHECK (char_length(btrim(authored_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_counterfactual_cases_scoped CHECK (
    (scope->>'kind' = 'ANCHORED' AND jsonb_typeof(scope->'anchors') = 'array' AND jsonb_array_length(scope->'anchors') >= 1)
    OR (scope->>'kind' = 'ENTERPRISE_WIDE' AND char_length(btrim(coalesce(scope->>'justification', ''))) >= 12)
  ),
  CONSTRAINT helm_counterfactual_cases_boundary_ordered CHECK (boundary_effective <= boundary_recorded),
  -- Never today's state: the anchor was known at or before the decision boundary.
  CONSTRAINT helm_counterfactual_cases_anchored_in_the_past CHECK (anchor_recorded <= boundary_recorded)
);
CREATE INDEX IF NOT EXISTS helm_counterfactual_cases_decision_idx ON public.helm_counterfactual_cases (decision_id);

CREATE TABLE IF NOT EXISTS public.helm_counterfactual_worlds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES public.helm_counterfactual_cases(id) ON DELETE RESTRICT,
  lens text NOT NULL CHECK (lens IN ('AS_KNOWN_THEN', 'WITH_HINDSIGHT')),
  method text NOT NULL CHECK (method = 'MODEL_COUNTERFACTUAL'),
  estimability text NOT NULL CHECK (estimability IN ('ESTIMATED', 'NOT_ESTIMABLE')),
  not_estimable_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(not_estimable_reasons) = 'array'),
  -- The fork the STATE was read at: the decision's own.
  anchor_fork jsonb NOT NULL CHECK (jsonb_typeof(anchor_fork) = 'object' AND anchor_fork ? 'recordedThrough'),
  -- The lens the world's INFORMATION was read at: the boundary, or the moment of the estimate.
  knowledge_effective timestamptz NOT NULL,
  knowledge_recorded timestamptz NOT NULL,
  origin text CHECK (origin IS NULL OR origin IN ('BOUND_TO_DECISION', 'COMPUTED_FOR_CASE')),
  scenario_id uuid REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT,
  scenario_revision_id uuid REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT,
  scenario_run_id uuid REFERENCES public.helm_scenario_runs(id) ON DELETE RESTRICT,
  model jsonb,
  readings jsonb NOT NULL CHECK (jsonb_typeof(readings) = 'array'),
  moved_inputs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(moved_inputs) = 'array'),
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
  hindsight_inputs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hindsight_inputs) = 'array'),
  uncertainty jsonb NOT NULL CHECK (jsonb_typeof(uncertainty) = 'array' AND jsonb_array_length(uncertainty) >= 1),
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  fingerprint text NOT NULL CHECK (char_length(btrim(fingerprint)) >= 1),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_by_label text NOT NULL CHECK (char_length(btrim(created_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_counterfactual_worlds_knowledge_ordered CHECK (knowledge_effective <= knowledge_recorded),
  -- The two lenses cannot be blended in storage.
  CONSTRAINT helm_counterfactual_worlds_lenses_apart CHECK (
    (lens = 'AS_KNOWN_THEN' AND jsonb_array_length(hindsight_inputs) = 0)
    OR (lens = 'WITH_HINDSIGHT' AND jsonb_array_length(hindsight_inputs) >= 1)
  ),
  -- ESTIMATED means a scenario run stands behind the world; NOT_ESTIMABLE says why.
  CONSTRAINT helm_counterfactual_worlds_estimated_has_a_run CHECK (
    (estimability = 'ESTIMATED') = (scenario_run_id IS NOT NULL AND scenario_id IS NOT NULL AND origin IS NOT NULL)
  ),
  CONSTRAINT helm_counterfactual_worlds_says_why CHECK (estimability = 'ESTIMATED' OR jsonb_array_length(not_estimable_reasons) >= 1)
);
CREATE INDEX IF NOT EXISTS helm_counterfactual_worlds_case_idx ON public.helm_counterfactual_worlds (case_id, recorded_at);

-- A person's reading of a comparison, pinned to the comparison it was a review OF.
CREATE TABLE IF NOT EXISTS public.helm_counterfactual_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES public.helm_counterfactual_cases(id) ON DELETE RESTRICT,
  comparison_fingerprint text NOT NULL CHECK (char_length(btrim(comparison_fingerprint)) >= 1),
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  -- What the comparison does NOT show. Required, every review.
  limitations text NOT NULL CHECK (char_length(btrim(limitations)) >= 1),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  reviewed_by_label text NOT NULL CHECK (char_length(btrim(reviewed_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helm_counterfactual_reviews_case_idx ON public.helm_counterfactual_reviews (case_id);

-- ====================================================================== PART 2

CREATE OR REPLACE FUNCTION public.helm_counterfactual_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: counterfactual records are append-only; a later estimate is a new world and a later reading a new review', TG_TABLE_NAME;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_counterfactual_cases_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  committed timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_decisions d WHERE d.id = NEW.decision_id AND d.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_counterfactual_cases: the decision is not in this organization';
  END IF;
  SELECT c.committed_at INTO committed
  FROM public.helm_decision_commitments c
  WHERE c.id = NEW.commitment_id AND c.org_id = NEW.org_id AND c.decision_id = NEW.decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm_counterfactual_cases: the commitment does not belong to this decision';
  END IF;
  -- The boundary is the commitment''s own, not a caller''s claim about what was knowable.
  IF date_trunc('milliseconds', committed) <> date_trunc('milliseconds', NEW.boundary_recorded) THEN
    RAISE EXCEPTION 'helm_counterfactual_cases: the decision boundary is the moment of the commitment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.helm_twin_snapshots t WHERE t.id = NEW.anchor_snapshot_id AND t.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_counterfactual_cases: the anchor snapshot is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_counterfactual_worlds_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  boundary timestamptz;
  h jsonb;
BEGIN
  SELECT c.boundary_recorded INTO boundary FROM public.helm_counterfactual_cases c WHERE c.id = NEW.case_id AND c.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm_counterfactual_worlds: the case is not in this organization';
  END IF;
  IF (NEW.anchor_fork->>'recordedThrough')::timestamptz > boundary THEN
    RAISE EXCEPTION 'helm_counterfactual_worlds: the world''s state must be anchored at or before the decision boundary — never today''s state';
  END IF;
  IF NEW.lens = 'AS_KNOWN_THEN' THEN
    IF NEW.knowledge_recorded > boundary THEN
      RAISE EXCEPTION 'helm_counterfactual_worlds: AS_KNOWN_THEN is read at or before the decision boundary; it carries no hindsight';
    END IF;
  ELSE
    FOR h IN SELECT * FROM jsonb_array_elements(NEW.hindsight_inputs) LOOP
      IF (h->>'learnedAt')::timestamptz <= boundary THEN
        RAISE EXCEPTION 'helm_counterfactual_worlds: a hindsight input must be learned after the decision boundary';
      END IF;
      IF char_length(btrim(coalesce(h->>'exogeneity', ''))) < 12 THEN
        RAISE EXCEPTION 'helm_counterfactual_worlds: a hindsight input states why it does not depend on the choice';
      END IF;
    END LOOP;
  END IF;
  IF NEW.scenario_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.helm_scenario_runs r WHERE r.id = NEW.scenario_run_id AND r.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_counterfactual_worlds: the scenario run is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_counterfactual_reviews_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_counterfactual_cases c WHERE c.id = NEW.case_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_counterfactual_reviews: the case is not in this organization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.helm_counterfactual_worlds w WHERE w.case_id = NEW.case_id) THEN
    RAISE EXCEPTION 'helm_counterfactual_reviews: there is no world yet to review';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_counterfactual_cases_record ON public.helm_counterfactual_cases;
CREATE TRIGGER helm_counterfactual_cases_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_counterfactual_cases FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_record_guard();
DROP TRIGGER IF EXISTS helm_counterfactual_cases_guard ON public.helm_counterfactual_cases;
CREATE TRIGGER helm_counterfactual_cases_guard BEFORE INSERT ON public.helm_counterfactual_cases FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_cases_guard();
DROP TRIGGER IF EXISTS helm_counterfactual_worlds_record ON public.helm_counterfactual_worlds;
CREATE TRIGGER helm_counterfactual_worlds_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_counterfactual_worlds FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_record_guard();
DROP TRIGGER IF EXISTS helm_counterfactual_worlds_guard ON public.helm_counterfactual_worlds;
CREATE TRIGGER helm_counterfactual_worlds_guard BEFORE INSERT ON public.helm_counterfactual_worlds FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_worlds_guard();
DROP TRIGGER IF EXISTS helm_counterfactual_reviews_record ON public.helm_counterfactual_reviews;
CREATE TRIGGER helm_counterfactual_reviews_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_counterfactual_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_record_guard();
DROP TRIGGER IF EXISTS helm_counterfactual_reviews_guard ON public.helm_counterfactual_reviews;
CREATE TRIGGER helm_counterfactual_reviews_guard BEFORE INSERT ON public.helm_counterfactual_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_counterfactual_reviews_guard();

-- ====================================================================== PART 3

ALTER TABLE public.helm_counterfactual_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_counterfactual_worlds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_counterfactual_reviews ENABLE ROW LEVEL SECURITY;

-- A case is read whole or not at all: its unit audience, every sensitivity class
-- it carries, and the decision it reviews. Written over the row's own columns so
-- INSERT … RETURNING works.
CREATE OR REPLACE FUNCTION helm_private.counterfactual_case_row_visible(
  p_org uuid, p_decision uuid, p_visibility text, p_authored_by uuid, p_units uuid[], p_classes text[]
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND (
      public.has_org_role(p_org, 'admin')
      OR (
        (
          p_visibility = 'ORG_WIDE'
          OR p_authored_by = auth.uid()
          OR EXISTS (SELECT 1 FROM unnest(p_units) g(unit_id) WHERE g.unit_id IN (SELECT helm_private.visible_org_units(p_org)))
        )
        AND NOT EXISTS (SELECT 1 FROM unnest(p_classes) k WHERE NOT helm_private.has_clearance(p_org, k))
        AND helm_private.can_see_decision(p_decision)
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_counterfactual_case(p_case uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.counterfactual_case_row_visible(c.org_id, c.decision_id, c.visibility, c.authored_by, c.granted_unit_ids, c.sensitivity_classes)
    FROM public.helm_counterfactual_cases c WHERE c.id = p_case
  ), false);
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

DROP POLICY IF EXISTS "Scoped read counterfactual cases" ON public.helm_counterfactual_cases;
CREATE POLICY "Scoped read counterfactual cases" ON public.helm_counterfactual_cases
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.counterfactual_case_row_visible(org_id, decision_id, visibility, authored_by, granted_unit_ids, sensitivity_classes));
DROP POLICY IF EXISTS "Members open counterfactual cases" ON public.helm_counterfactual_cases;
CREATE POLICY "Members open counterfactual cases" ON public.helm_counterfactual_cases
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND authored_by = (select auth.uid())
    AND helm_private.can_see_decision(decision_id)
    AND NOT EXISTS (SELECT 1 FROM unnest(sensitivity_classes) k WHERE NOT helm_private.has_clearance(org_id, k))
  );

DROP POLICY IF EXISTS "Scoped read counterfactual worlds" ON public.helm_counterfactual_worlds;
CREATE POLICY "Scoped read counterfactual worlds" ON public.helm_counterfactual_worlds
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_counterfactual_case(case_id));
DROP POLICY IF EXISTS "Readers estimate counterfactual worlds" ON public.helm_counterfactual_worlds;
CREATE POLICY "Readers estimate counterfactual worlds" ON public.helm_counterfactual_worlds
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()) AND helm_private.can_see_counterfactual_case(case_id));

DROP POLICY IF EXISTS "Scoped read counterfactual reviews" ON public.helm_counterfactual_reviews;
CREATE POLICY "Scoped read counterfactual reviews" ON public.helm_counterfactual_reviews
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_counterfactual_case(case_id));
DROP POLICY IF EXISTS "Readers review counterfactual cases" ON public.helm_counterfactual_reviews;
CREATE POLICY "Readers review counterfactual cases" ON public.helm_counterfactual_reviews
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND reviewed_by = (select auth.uid()) AND helm_private.can_see_counterfactual_case(case_id));

-- ====================================================================== PART 4

REVOKE ALL ON TABLE
  public.helm_counterfactual_cases, public.helm_counterfactual_worlds, public.helm_counterfactual_reviews
FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE
  public.helm_counterfactual_cases, public.helm_counterfactual_worlds, public.helm_counterfactual_reviews
TO authenticated;
-- Supabase's default privileges grant UPDATE and DELETE on every new public table.
-- RLS would match no row, but an append-only record should not carry the privilege at all.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.helm_counterfactual_cases, public.helm_counterfactual_worlds, public.helm_counterfactual_reviews
FROM authenticated;
GRANT ALL ON TABLE
  public.helm_counterfactual_cases, public.helm_counterfactual_worlds, public.helm_counterfactual_reviews
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_counterfactual_record_guard(), public.helm_counterfactual_cases_guard(),
  public.helm_counterfactual_worlds_guard(), public.helm_counterfactual_reviews_guard()
FROM PUBLIC, anon;

-- ====================================================================== PART 5

-- A Management Genome episode may reference a counterfactual case (ADR-0029 §9):
-- beside, never inside, how management decided and what happened.
ALTER TABLE public.helm_genome_episode_refs DROP CONSTRAINT IF EXISTS helm_genome_episode_refs_role_check;
ALTER TABLE public.helm_genome_episode_refs ADD CONSTRAINT helm_genome_episode_refs_role_check
  CHECK (role IN ('SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'CAUSAL_CONTEXT', 'GOVERNANCE_EVALUATION', 'OUTCOME_REVIEW', 'COUNTERFACTUAL_CASE'));

-- A referenced case must review the episode's own decision and carry only classes
-- the episode already carries: an episode is read whole, so it can reference only
-- what its readers may read.
CREATE OR REPLACE FUNCTION public.helm_genome_episode_refs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  ep_decision uuid;
  ep_classes text[];
  cf_decision uuid;
  cf_classes text[];
BEGIN
  SELECT e.decision_id, e.sensitivity_classes INTO ep_decision, ep_classes
  FROM public.helm_genome_episodes e WHERE e.id = NEW.episode_id AND e.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm_genome_episode_refs: the episode is not in this organization';
  END IF;
  IF NEW.role = 'COUNTERFACTUAL_CASE' THEN
    IF NEW.ref->>'kind' <> 'COUNTERFACTUAL_CASE' THEN
      RAISE EXCEPTION 'helm_genome_episode_refs: a COUNTERFACTUAL_CASE role takes a counterfactual case';
    END IF;
    SELECT c.decision_id, c.sensitivity_classes INTO cf_decision, cf_classes
    FROM public.helm_counterfactual_cases c WHERE c.id::text = NEW.ref->>'id' AND c.org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm_genome_episode_refs: the counterfactual case is not in this organization';
    END IF;
    IF cf_decision <> ep_decision THEN
      RAISE EXCEPTION 'helm_genome_episode_refs: the counterfactual case reviews another decision';
    END IF;
    IF NOT (cf_classes <@ ep_classes) THEN
      RAISE EXCEPTION 'helm_genome_episode_refs: the counterfactual case carries a class the episode does not; an episode is read whole';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.helm_genome_episode_refs_guard() FROM PUBLIC, anon;
