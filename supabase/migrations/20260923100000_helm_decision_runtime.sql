-- ============================================================================
-- HELM Phase 5 — Decision Intelligence & Commitment Model
--
-- STRICTLY ADDITIVE. Only helm_* objects are created or altered. No Memoire
-- table, policy, index, trigger, function or embedding is touched. Nothing is
-- dropped except HELM CHECK constraints that are re-added wider under the same
-- name, and triggers/functions re-created idempotently.
--
-- What this adds (ADR-0021):
--
--   helm_decisions                        MIGRATED: the pre-kernel decision row
--                                         gains a management question, a trigger,
--                                         a knowledge boundary, four horizons,
--                                         reversibility and the kernel lifecycle.
--                                         The legacy analysis columns are kept
--                                         and marked RETIRED.
--   helm_decision_revisions               one preparation state; immutable once
--                                         SEALED. A commitment seals one.
--   helm_decision_alternatives            MIGRATED: an alternative now REFERENCES
--                                         a scenario revision and the run that
--                                         computed its future, or says UNMODELLED.
--   helm_decision_criteria                what management said matters, and how
--                                         it is to be judged.
--   helm_decision_criterion_assessments   authored qualitative ratings. HELM
--                                         never writes one itself.
--   helm_decision_weightings              management's own weighting method.
--                                         Without a row here, no weighted view
--                                         exists — there is no default.
--   helm_decision_assumptions             MIGRATED: gains an OWNER, confidence,
--                                         criticality, scenario linkage and the
--                                         outcome learned later.
--   helm_decision_challenges              recorded disagreement.
--   helm_decision_evidence                what bears on the decision, and how.
--   helm_decision_commitments             what management chose and why. Frozen.
--   helm_decision_commitment_snapshots    the evidence manifest, by reference and
--                                         fingerprint. Never rewritten.
--   helm_actions                          MIGRATED: a kernel row is an action
--                                         INTENT bound to a commitment.
--   helm_decision_outcome_reviews         expected vs actual. Not a verdict.
--   helm_decision_events                  UNCHANGED: already append-only, and now
--                                         also the kernel decision timeline.
--
-- Business logic stays in code. The triggers below enforce INTEGRITY only —
-- immutability, tenancy, coherence — and never compute a business value, never
-- evaluate a criterion and never decide anything.
--
-- AUTHORITY IS NOT HERE. `authority_status` is written once, as NOT_EVALUATED.
-- Whether an actor was allowed to commit is Phase 6's question.
-- ============================================================================

-- ------------------------------------------------------ decision identity

ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS management_question text;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS decision_scope text NOT NULL DEFAULT '';
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS trigger_type text;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS trigger_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS kernel_state text;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS owner_kind text;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS owner_label text;
-- The knowledge boundary the decision is framed at (the Phase 3 lenses).
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS effective_as_of timestamptz;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS recorded_through timestamptz;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS observation_policy text;
-- Four dates, four different questions — never one overloaded due_date.
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS decision_deadline date;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS expected_outcome_horizon date;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS review_date date;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS objectives jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS reversibility text NOT NULL DEFAULT 'UNASSESSED';
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS reversal_window_days integer;
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS authority_status text NOT NULL DEFAULT 'NOT_EVALUATED';
ALTER TABLE public.helm_decisions ADD COLUMN IF NOT EXISTS kernel_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.helm_decisions DROP CONSTRAINT IF EXISTS helm_decisions_kernel_state_check;
ALTER TABLE public.helm_decisions ADD CONSTRAINT helm_decisions_kernel_state_check CHECK (
  kernel_state IS NULL OR kernel_state IN
    ('DRAFT', 'INVESTIGATING', 'MODELLING', 'READY_FOR_DECISION', 'COMMITTED',
     'EXECUTING', 'COMPLETED', 'REVIEWED', 'CANCELLED')
);
ALTER TABLE public.helm_decisions DROP CONSTRAINT IF EXISTS helm_decisions_trigger_type_check;
ALTER TABLE public.helm_decisions ADD CONSTRAINT helm_decisions_trigger_type_check CHECK (
  trigger_type IS NULL OR trigger_type IN
    ('SIGNAL', 'ISSUE', 'OPPORTUNITY', 'RISK', 'PLANNED_REVIEW', 'STRATEGIC_INITIATIVE', 'EXCEPTION', 'MANUAL')
);
ALTER TABLE public.helm_decisions DROP CONSTRAINT IF EXISTS helm_decisions_reversibility_check;
ALTER TABLE public.helm_decisions ADD CONSTRAINT helm_decisions_reversibility_check CHECK (
  reversibility IN ('REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'IRREVERSIBLE', 'UNASSESSED')
);
-- Phase 5 produces exactly one value. AUTHORIZED / REQUIRES_APPROVAL /
-- ESCALATED are Phase 6's to add, with the system that can justify them.
ALTER TABLE public.helm_decisions DROP CONSTRAINT IF EXISTS helm_decisions_authority_status_check;
ALTER TABLE public.helm_decisions ADD CONSTRAINT helm_decisions_authority_status_check CHECK (
  authority_status = 'NOT_EVALUATED'
);
-- A kernel decision has a management question, a trigger, a kernel state and a
-- knowledge boundary. A legacy row (pre-Phase-5) has none of them.
ALTER TABLE public.helm_decisions DROP CONSTRAINT IF EXISTS helm_decisions_kernel_coherent;
ALTER TABLE public.helm_decisions ADD CONSTRAINT helm_decisions_kernel_coherent CHECK (
  (management_question IS NULL AND kernel_state IS NULL AND trigger_type IS NULL
   AND effective_as_of IS NULL AND recorded_through IS NULL AND observation_policy IS NULL)
  OR (management_question IS NOT NULL AND char_length(btrim(management_question)) >= 12
      AND kernel_state IS NOT NULL AND trigger_type IS NOT NULL
      AND effective_as_of IS NOT NULL AND recorded_through IS NOT NULL
      AND observation_policy IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY'))
);

CREATE INDEX IF NOT EXISTS helm_decisions_kernel_idx
  ON public.helm_decisions (org_id, kernel_state, updated_at DESC) WHERE kernel_state IS NOT NULL;

COMMENT ON COLUMN public.helm_decisions.recommendation IS
  'RETIRED (Phase 5): the pre-kernel free-text recommendation. HELM does not recommend; a kernel decision records a management commitment with its rationale.';
COMMENT ON COLUMN public.helm_decisions.decided_alternative_id IS
  'RETIRED (Phase 5): kernel decisions record the chosen alternative on helm_decision_commitments, where it is immutable.';
COMMENT ON COLUMN public.helm_decisions.decision_rationale IS
  'RETIRED (Phase 5): kernel rationale is structured and references criteria, deltas, assumptions and evidence.';
COMMENT ON COLUMN public.helm_decisions.expected_metrics IS
  'RETIRED (Phase 5): kernel expected outcomes reference the chosen future state''s value nodes.';
COMMENT ON COLUMN public.helm_decisions.status IS
  'RETIRED for kernel rows (Phase 5): pending_approval / approved / rejected are AUTHORITY states and have no kernel equivalent. Kernel rows use kernel_state.';
COMMENT ON COLUMN public.helm_decisions.approved_by IS
  'RETIRED (Phase 5): committing is not approving. Authority arrives in Phase 6.';

-- The framing of a committed decision is part of the record; the question
-- management answered does not change afterwards.
CREATE OR REPLACE FUNCTION public.helm_decisions_kernel_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kernel_state IS NOT NULL AND NEW.kernel_state <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_decisions: a decision is created as DRAFT';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.kernel_state IS NULL THEN
    RETURN NEW; -- legacy row: its own (retired) rules
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'helm_decisions: decision identity is immutable';
  END IF;

  IF OLD.kernel_state IN ('COMMITTED', 'EXECUTING', 'COMPLETED', 'REVIEWED') AND (
       NEW.management_question IS DISTINCT FROM OLD.management_question
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.context IS DISTINCT FROM OLD.context
    OR NEW.problem IS DISTINCT FROM OLD.problem
    OR NEW.decision_scope IS DISTINCT FROM OLD.decision_scope
    OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
    OR NEW.effective_as_of IS DISTINCT FROM OLD.effective_as_of
    OR NEW.recorded_through IS DISTINCT FROM OLD.recorded_through
    OR NEW.observation_policy IS DISTINCT FROM OLD.observation_policy
    OR NEW.owner_label IS DISTINCT FROM OLD.owner_label
  ) THEN
    RAISE EXCEPTION 'helm_decisions: the framing of a committed decision does not change';
  END IF;

  IF NEW.kernel_state <> OLD.kernel_state AND NOT (
       (OLD.kernel_state = 'DRAFT'              AND NEW.kernel_state IN ('INVESTIGATING', 'MODELLING', 'CANCELLED'))
    OR (OLD.kernel_state = 'INVESTIGATING'      AND NEW.kernel_state IN ('MODELLING', 'READY_FOR_DECISION', 'DRAFT', 'CANCELLED'))
    OR (OLD.kernel_state = 'MODELLING'          AND NEW.kernel_state IN ('READY_FOR_DECISION', 'INVESTIGATING', 'CANCELLED'))
    OR (OLD.kernel_state = 'READY_FOR_DECISION' AND NEW.kernel_state IN ('COMMITTED', 'MODELLING', 'INVESTIGATING', 'CANCELLED'))
    OR (OLD.kernel_state = 'COMMITTED'          AND NEW.kernel_state IN ('EXECUTING', 'COMPLETED', 'REVIEWED'))
    OR (OLD.kernel_state = 'EXECUTING'          AND NEW.kernel_state IN ('COMPLETED', 'REVIEWED'))
    OR (OLD.kernel_state = 'COMPLETED'          AND NEW.kernel_state = 'REVIEWED')
  ) THEN
    RAISE EXCEPTION 'helm_decisions: a % decision cannot become %', OLD.kernel_state, NEW.kernel_state;
  END IF;
  IF OLD.kernel_state IN ('REVIEWED', 'CANCELLED') AND NEW.kernel_state <> OLD.kernel_state THEN
    RAISE EXCEPTION 'helm_decisions: % is terminal', OLD.kernel_state;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decisions_kernel_guard ON public.helm_decisions;
CREATE TRIGGER helm_decisions_kernel_guard BEFORE INSERT OR UPDATE ON public.helm_decisions
  FOR EACH ROW EXECUTE FUNCTION public.helm_decisions_kernel_guard();

-- --------------------------------------------------------------- revisions

CREATE TABLE IF NOT EXISTS public.helm_decision_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- RESTRICT throughout: a decision with history cannot be deleted from under it.
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'SEALED')),
  reason text NOT NULL CHECK (reason IN ('OPENED', 'REVISED', 'RECONSIDERED')),
  based_on_revision_id uuid REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  -- Set when this revision exists because an earlier commitment was reconsidered.
  reconsiders_commitment_id uuid,
  reconsideration_reason text,

  effective_as_of timestamptz NOT NULL,
  recorded_through timestamptz NOT NULL,
  observation_policy text NOT NULL
    CHECK (observation_policy IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY')),

  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,

  CONSTRAINT helm_decision_revisions_number_unique UNIQUE (decision_id, revision_number),
  CONSTRAINT helm_decision_revisions_sealed_coherent CHECK (
    (state = 'DRAFT' AND sealed_at IS NULL) OR (state = 'SEALED' AND sealed_at IS NOT NULL)
  ),
  CONSTRAINT helm_decision_revisions_reconsideration_coherent CHECK (
    (reason = 'RECONSIDERED') = (reconsiders_commitment_id IS NOT NULL)
  )
);

-- One open revision at a time per decision.
CREATE UNIQUE INDEX IF NOT EXISTS helm_decision_revisions_one_draft_idx
  ON public.helm_decision_revisions (decision_id) WHERE state = 'DRAFT';
CREATE INDEX IF NOT EXISTS helm_decision_revisions_org_idx
  ON public.helm_decision_revisions (org_id, decision_id, revision_number);

CREATE OR REPLACE FUNCTION public.helm_decision_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  d record;
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_decision_revisions: a decision revision is history and is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT org_id, kernel_state INTO d FROM public.helm_decisions WHERE id = NEW.decision_id;
    IF d IS NULL OR d.org_id <> NEW.org_id THEN
      RAISE EXCEPTION 'helm_decision_revisions: decision not found in this organization';
    END IF;
    IF d.kernel_state IS NULL THEN
      RAISE EXCEPTION 'helm_decision_revisions: a pre-kernel decision has no revisions';
    END IF;
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_decision_revisions: a revision is created as DRAFT';
    END IF;
    IF NEW.based_on_revision_id IS NOT NULL THEN
      SELECT * INTO r FROM public.helm_decision_revisions WHERE id = NEW.based_on_revision_id;
      IF r IS NULL OR r.decision_id <> NEW.decision_id THEN
        RAISE EXCEPTION 'helm_decision_revisions: based_on must be a revision of the same decision';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a sealed revision never changes; a draft may only be sealed.
  IF OLD.state = 'SEALED' THEN
    RAISE EXCEPTION 'helm_decision_revisions: a sealed revision is immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.decision_id <> OLD.decision_id
     OR NEW.revision_number <> OLD.revision_number OR NEW.reason <> OLD.reason
     OR NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id
     OR NEW.reconsiders_commitment_id IS DISTINCT FROM OLD.reconsiders_commitment_id
     OR NEW.effective_as_of <> OLD.effective_as_of
     OR NEW.recorded_through <> OLD.recorded_through
     OR NEW.observation_policy <> OLD.observation_policy
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'helm_decision_revisions: only sealing may change a draft revision';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_revisions_guard ON public.helm_decision_revisions;
CREATE TRIGGER helm_decision_revisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_revisions
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_revisions_guard();

-- ----------------------------------------------------- draft-only helper

-- One place that answers "may this revision still be changed?". Used by every
-- guard below, so sealing a revision freezes the whole basis at once rather
-- than table by table.
CREATE OR REPLACE FUNCTION public.helm_decision_revision_is_draft(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT COALESCE((SELECT state = 'DRAFT' FROM public.helm_decision_revisions WHERE id = p_revision), false);
$fn$;

-- --------------------------------------------------- alternatives (migrated)

ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS revision_id uuid
  REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS scenario_id uuid
  REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS scenario_revision_id uuid
  REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS scenario_run_id uuid
  REFERENCES public.helm_scenario_runs(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS unmodelled_reason text;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS created_by uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.helm_decision_alternatives ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.helm_decision_alternatives DROP CONSTRAINT IF EXISTS helm_decision_alternatives_status_check;
ALTER TABLE public.helm_decision_alternatives ADD CONSTRAINT helm_decision_alternatives_status_check CHECK (
  status IS NULL OR status IN ('MODELLED', 'UNMODELLED', 'WITHDRAWN')
);
-- A kernel alternative belongs to a revision and has a status; a legacy row has
-- neither. A MODELLED one carries its scenario future; anything else says why
-- it does not, rather than carrying invented economics.
ALTER TABLE public.helm_decision_alternatives DROP CONSTRAINT IF EXISTS helm_decision_alternatives_kernel_coherent;
ALTER TABLE public.helm_decision_alternatives ADD CONSTRAINT helm_decision_alternatives_kernel_coherent CHECK (
  (revision_id IS NULL AND status IS NULL)
  OR (revision_id IS NOT NULL AND status = 'MODELLED'
      AND scenario_id IS NOT NULL AND scenario_revision_id IS NOT NULL AND scenario_run_id IS NOT NULL
      AND unmodelled_reason IS NULL)
  OR (revision_id IS NOT NULL AND status IN ('UNMODELLED', 'WITHDRAWN')
      AND scenario_run_id IS NULL AND unmodelled_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS helm_decision_alternatives_revision_idx
  ON public.helm_decision_alternatives (revision_id, sort) WHERE revision_id IS NOT NULL;

COMMENT ON COLUMN public.helm_decision_alternatives.financial_lines IS
  'RETIRED (Phase 5): a kernel alternative carries no economics of its own. Its consequences are the scenario future state it references.';
COMMENT ON COLUMN public.helm_decision_alternatives.is_recommended IS
  'RETIRED (Phase 5): HELM does not recommend an alternative. The chosen one is recorded on helm_decision_commitments by a person.';

CREATE OR REPLACE FUNCTION public.helm_decision_alternatives_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
  run record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.revision_id IS NOT NULL AND NOT public.helm_decision_revision_is_draft(OLD.revision_id) THEN
      RAISE EXCEPTION 'helm_decision_alternatives: an alternative of a sealed revision is history and is not deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.revision_id IS NULL THEN
    RETURN NEW; -- legacy row: its own (retired) rules
  END IF;

  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_alternatives: revision not found for this decision and organization';
  END IF;
  IF rev.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'helm_decision_alternatives: a sealed revision is immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.decision_id <> OLD.decision_id OR NEW.revision_id <> OLD.revision_id) THEN
    RAISE EXCEPTION 'helm_decision_alternatives: an alternative does not move between decisions or revisions';
  END IF;

  -- A bound alternative must reference a COMPLETED simulation of the scenario
  -- revision it names, in this organization. An alternative with no computed
  -- future is UNMODELLED, never an alternative with zeros.
  IF NEW.scenario_run_id IS NOT NULL THEN
    SELECT org_id, scenario_id, revision_id, status INTO run
      FROM public.helm_scenario_runs WHERE id = NEW.scenario_run_id;
    IF run IS NULL OR run.org_id <> NEW.org_id THEN
      RAISE EXCEPTION 'helm_decision_alternatives: scenario simulation not found in this organization';
    END IF;
    IF run.scenario_id IS DISTINCT FROM NEW.scenario_id
       OR run.revision_id IS DISTINCT FROM NEW.scenario_revision_id THEN
      RAISE EXCEPTION 'helm_decision_alternatives: the simulation does not belong to the scenario revision named';
    END IF;
    IF run.status = 'RUNNING' THEN
      RAISE EXCEPTION 'helm_decision_alternatives: an alternative binds a completed simulation, not one still running';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_alternatives_guard ON public.helm_decision_alternatives;
CREATE TRIGGER helm_decision_alternatives_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_alternatives
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_alternatives_guard();

-- ---------------------------------------------------------------- criteria

CREATE TABLE IF NOT EXISTS public.helm_decision_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  style text NOT NULL CHECK (style IN
    ('HARD_CONSTRAINT', 'TARGET', 'PREFERENCE', 'QUALITATIVE', 'OPTIONAL_WEIGHTED')),
  required boolean NOT NULL DEFAULT false,
  metric_key text,
  subject_hint text,
  -- Exact canonical decimal, as text: a float would round the line management drew.
  threshold text CHECK (threshold IS NULL OR threshold ~ '^-?[0-9]+(\.[0-9]+)?$'),
  unit_type text CHECK (unit_type IS NULL OR unit_type IN
    ('currency', 'percentage', 'ratio', 'units', 'count', 'days', 'hours', 'capacity', 'score', 'index')),
  direction text NOT NULL DEFAULT 'NONE'
    CHECK (direction IN ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'NONE')),
  -- Only ever management's own number. There is no default weight.
  weight text CHECK (weight IS NULL OR weight ~ '^-?[0-9]+(\.[0-9]+)?$'),
  author_kind text NOT NULL CHECK (author_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'POLICY')),
  author_label text NOT NULL CHECK (char_length(btrim(author_label)) >= 1),
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A criterion nobody can justify is not a criterion.
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  -- True when the threshold is seeded demonstration policy, not a real one.
  demo_policy boolean NOT NULL DEFAULT false,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_decision_criteria_key_unique UNIQUE (revision_id, key),
  CONSTRAINT helm_decision_criteria_line_coherent CHECK (
    style NOT IN ('HARD_CONSTRAINT', 'TARGET') OR threshold IS NOT NULL
  ),
  CONSTRAINT helm_decision_criteria_weight_coherent CHECK (
    (style = 'OPTIONAL_WEIGHTED') = (weight IS NOT NULL)
  ),
  CONSTRAINT helm_decision_criteria_measured_coherent CHECK (
    style = 'QUALITATIVE' OR metric_key IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS helm_decision_criteria_revision_idx
  ON public.helm_decision_criteria (revision_id, sort);

CREATE TABLE IF NOT EXISTS public.helm_decision_criterion_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  criterion_id uuid NOT NULL REFERENCES public.helm_decision_criteria(id) ON DELETE RESTRICT,
  alternative_id uuid NOT NULL REFERENCES public.helm_decision_alternatives(id) ON DELETE RESTRICT,
  rating text NOT NULL CHECK (rating IN
    ('STRONG_SUPPORT', 'SUPPORT', 'NEUTRAL', 'CONCERN', 'STRONG_CONCERN')),
  -- A qualitative rating without a reason is an opinion with no author.
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  author_kind text NOT NULL CHECK (author_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'POLICY')),
  author_label text NOT NULL CHECK (char_length(btrim(author_label)) >= 1),
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_decision_assessments_once UNIQUE (criterion_id, alternative_id)
);

-- Management's own weighting method. Without a row here there is no weighted
-- view at all: HELM never invents a way to add criteria together.
CREATE TABLE IF NOT EXISTS public.helm_decision_weightings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (char_length(btrim(method)) >= 8),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  author_kind text NOT NULL CHECK (author_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'POLICY')),
  author_label text NOT NULL CHECK (char_length(btrim(author_label)) >= 1),
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_decision_weightings_once UNIQUE (revision_id)
);

-- ------------------------------------------------- assumptions (migrated)

ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS revision_id uuid
  REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS owner_kind text;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS owner_label text;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS owner_user_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '';
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS rationale text NOT NULL DEFAULT '';
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS confidence numeric;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS criticality text;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS scenario_revision_id uuid
  REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS scenario_override_id uuid
  REFERENCES public.helm_scenario_overrides(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS alternative_ids uuid[]
  NOT NULL DEFAULT ARRAY[]::uuid[];
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS outcome_note text;
ALTER TABLE public.helm_decision_assumptions ADD COLUMN IF NOT EXISTS created_by uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.helm_decision_assumptions DROP CONSTRAINT IF EXISTS helm_decision_assumptions_owner_kind_check;
ALTER TABLE public.helm_decision_assumptions ADD CONSTRAINT helm_decision_assumptions_owner_kind_check CHECK (
  owner_kind IS NULL OR owner_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'SYSTEM_MODEL')
);
ALTER TABLE public.helm_decision_assumptions DROP CONSTRAINT IF EXISTS helm_decision_assumptions_criticality_check;
ALTER TABLE public.helm_decision_assumptions ADD CONSTRAINT helm_decision_assumptions_criticality_check CHECK (
  criticality IS NULL OR criticality IN ('CRITICAL', 'MATERIAL', 'MINOR')
);
ALTER TABLE public.helm_decision_assumptions DROP CONSTRAINT IF EXISTS helm_decision_assumptions_outcome_check;
ALTER TABLE public.helm_decision_assumptions ADD CONSTRAINT helm_decision_assumptions_outcome_check CHECK (
  outcome IS NULL OR outcome IN ('PENDING', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'DISPROVED', 'UNKNOWN')
);
ALTER TABLE public.helm_decision_assumptions DROP CONSTRAINT IF EXISTS helm_decision_assumptions_confidence_check;
ALTER TABLE public.helm_decision_assumptions ADD CONSTRAINT helm_decision_assumptions_confidence_check CHECK (
  confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
);
-- A kernel assumption belongs to a revision and has a criticality and an
-- outcome; a legacy row has neither. An owner is NOT required here — an
-- unowned assumption is a readiness GAP management should see, not a row the
-- database refuses to store.
ALTER TABLE public.helm_decision_assumptions DROP CONSTRAINT IF EXISTS helm_decision_assumptions_kernel_coherent;
ALTER TABLE public.helm_decision_assumptions ADD CONSTRAINT helm_decision_assumptions_kernel_coherent CHECK (
  (revision_id IS NULL AND criticality IS NULL AND outcome IS NULL)
  OR (revision_id IS NOT NULL AND criticality IS NOT NULL AND outcome IS NOT NULL
      AND (owner_label IS NULL) = (owner_kind IS NULL))
);

CREATE INDEX IF NOT EXISTS helm_decision_assumptions_revision_idx
  ON public.helm_decision_assumptions (revision_id) WHERE revision_id IS NOT NULL;

COMMENT ON COLUMN public.helm_decision_assumptions.sensitivity IS
  'RETIRED (Phase 5): kernel assumptions use criticality (CRITICAL / MATERIAL / MINOR) and carry an owner and a confidence.';
COMMENT ON COLUMN public.helm_decision_assumptions.validated IS
  'RETIRED (Phase 5): kernel assumptions record outcome (CONFIRMED / PARTIALLY_CONFIRMED / DISPROVED / UNKNOWN) with a note.';

-- A sealed revision's assumptions are frozen, with ONE exception: the outcome
-- is learned after the fact, so it and its note may still be written. Nothing
-- else about the assumption may change — what management believed at the time
-- is the record.
CREATE OR REPLACE FUNCTION public.helm_decision_assumptions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.revision_id IS NOT NULL AND NOT public.helm_decision_revision_is_draft(OLD.revision_id) THEN
      RAISE EXCEPTION 'helm_decision_assumptions: an assumption of a sealed revision is history and is not deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.revision_id IS NULL THEN
    RETURN NEW; -- legacy row
  END IF;

  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_assumptions: revision not found for this decision and organization';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF rev.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_decision_assumptions: a sealed revision is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF rev.state = 'SEALED' AND (
       NEW.statement IS DISTINCT FROM OLD.statement
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.owner_label IS DISTINCT FROM OLD.owner_label
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.rationale IS DISTINCT FROM OLD.rationale
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.criticality IS DISTINCT FROM OLD.criticality
    OR NEW.scenario_revision_id IS DISTINCT FROM OLD.scenario_revision_id
    OR NEW.scenario_override_id IS DISTINCT FROM OLD.scenario_override_id
    OR NEW.alternative_ids IS DISTINCT FROM OLD.alternative_ids
  ) THEN
    RAISE EXCEPTION 'helm_decision_assumptions: only the outcome of a sealed revision''s assumption may be written';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_assumptions_guard ON public.helm_decision_assumptions;
CREATE TRIGGER helm_decision_assumptions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_assumptions
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_assumptions_guard();

-- -------------------------------------------------------------- challenges

CREATE TABLE IF NOT EXISTS public.helm_decision_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (target_kind IN ('ASSUMPTION', 'CRITERION', 'ALTERNATIVE', 'CONTEXT')),
  target_id uuid,
  author_kind text NOT NULL CHECK (author_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'POLICY')),
  author_label text NOT NULL CHECK (char_length(btrim(author_label)) >= 1),
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  concern text NOT NULL CHECK (char_length(btrim(concern)) >= 8),
  evidence_id uuid,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'RESOLVED', 'ACCEPTED_RISK', 'REJECTED')),
  resolution text,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  raised_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_decision_challenges_resolution_coherent CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status <> 'OPEN' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT helm_decision_challenges_target_coherent CHECK (
    (target_kind = 'CONTEXT') OR target_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS helm_decision_challenges_revision_idx
  ON public.helm_decision_challenges (revision_id, raised_at);

-- ---------------------------------------------------------------- evidence

CREATE TABLE IF NOT EXISTS public.helm_decision_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN
    ('SCENARIO_FUTURE_STATE', 'SOURCE_OBSERVATION', 'CALCULATION', 'CUSTOMER_COMMUNICATION',
     'MARKET_SIGNAL', 'SUPPLIER_COMMITMENT', 'POLICY', 'HISTORICAL_DECISION',
     'MANAGEMENT_JUDGEMENT', 'EXTERNAL_DOCUMENT')),
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  detail text NOT NULL DEFAULT '',
  -- Evidence is a RELATIONSHIP, not an attachment: it always says what it bears
  -- on and how.
  relation text NOT NULL CHECK (relation IN ('SUPPORT', 'CHALLENGE', 'CONTEXTUALIZE', 'INVALIDATE')),
  target_kind text NOT NULL CHECK (target_kind IN ('ASSUMPTION', 'CRITERION', 'ALTERNATIVE', 'CONTEXT')),
  target_id uuid,
  source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 1 AND 64),
  source_ref text,
  -- The two Phase 3 lenses: when it was true, and when HELM learned it.
  effective_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  author_kind text CHECK (author_kind IS NULL OR author_kind IN ('PERSON', 'ROLE', 'FUNCTION', 'POLICY')),
  author_label text,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_decision_evidence_target_coherent CHECK (
    (target_kind = 'CONTEXT') OR target_id IS NOT NULL
  ),
  CONSTRAINT helm_decision_evidence_author_coherent CHECK (
    (author_kind IS NULL) = (author_label IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS helm_decision_evidence_revision_idx
  ON public.helm_decision_evidence (revision_id, created_at);

ALTER TABLE public.helm_decision_challenges DROP CONSTRAINT IF EXISTS helm_decision_challenges_evidence_fk;
ALTER TABLE public.helm_decision_challenges
  ADD CONSTRAINT helm_decision_challenges_evidence_fk
  FOREIGN KEY (evidence_id) REFERENCES public.helm_decision_evidence(id) ON DELETE RESTRICT;

-- Criteria, assessments, weightings, challenges and evidence all freeze with
-- their revision. Evidence is the ONE exception: it may still be recorded
-- after a commitment — it simply never joins the frozen manifest.
CREATE OR REPLACE FUNCTION public.helm_decision_basis_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
  target_revision uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public.helm_decision_revision_is_draft(OLD.revision_id) THEN
      RAISE EXCEPTION '%: part of a sealed revision is history and is not deleted', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;

  target_revision := NEW.revision_id;
  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = target_revision;
  IF rev IS NULL OR rev.org_id <> NEW.org_id THEN
    RAISE EXCEPTION '%: decision revision not found in this organization', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'helm_decision_evidence' THEN
    -- Recorded whenever it arrives; the manifest is what freezes.
    RETURN NEW;
  END IF;

  IF rev.state <> 'DRAFT' THEN
    RAISE EXCEPTION '%: a sealed revision is immutable', TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.revision_id <> OLD.revision_id THEN
    RAISE EXCEPTION '%: a row does not move between decision revisions', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_criteria_guard ON public.helm_decision_criteria;
CREATE TRIGGER helm_decision_criteria_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_criteria
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_basis_guard();

DROP TRIGGER IF EXISTS helm_decision_assessments_guard ON public.helm_decision_criterion_assessments;
CREATE TRIGGER helm_decision_assessments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_criterion_assessments
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_basis_guard();

DROP TRIGGER IF EXISTS helm_decision_weightings_guard ON public.helm_decision_weightings;
CREATE TRIGGER helm_decision_weightings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_weightings
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_basis_guard();

DROP TRIGGER IF EXISTS helm_decision_evidence_guard ON public.helm_decision_evidence;
CREATE TRIGGER helm_decision_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_evidence
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_basis_guard();

-- A challenge is raised on a draft and resolved once. Resolving it after the
-- commitment is allowed — an OPEN challenge management decided over may still
-- be answered later — but the concern and its author never change.
CREATE OR REPLACE FUNCTION public.helm_decision_challenges_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_decision_challenges: a recorded disagreement is history and is never deleted';
  END IF;

  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_challenges: revision not found for this decision and organization';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF rev.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_decision_challenges: a sealed revision is immutable';
    END IF;
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'helm_decision_challenges: a challenge is raised OPEN';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'helm_decision_challenges: that challenge is already %', OLD.status;
  END IF;
  IF NEW.revision_id <> OLD.revision_id OR NEW.target_kind <> OLD.target_kind
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.author_label <> OLD.author_label OR NEW.concern <> OLD.concern
     OR NEW.raised_at <> OLD.raised_at THEN
    RAISE EXCEPTION 'helm_decision_challenges: only resolving may change a challenge';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_challenges_guard ON public.helm_decision_challenges;
CREATE TRIGGER helm_decision_challenges_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_challenges
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_challenges_guard();

-- ------------------------------------------------- commitment and snapshot

-- The frozen evidence manifest: exactly what was on the table when management
-- committed, by reference and by fingerprint. Write-once.
CREATE TABLE IF NOT EXISTS public.helm_decision_commitment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  effective_as_of timestamptz NOT NULL,
  recorded_through timestamptz NOT NULL,
  observation_policy text NOT NULL
    CHECK (observation_policy IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY')),
  model_ref jsonb,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(alternatives) = 'array'),
  criterion_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  assumption_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  challenge_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  evidence_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  criterion_evaluations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(criterion_evaluations) = 'array'),
  open_challenges uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  fingerprint text NOT NULL CHECK (char_length(fingerprint) >= 8)
);

CREATE INDEX IF NOT EXISTS helm_decision_snapshots_revision_idx
  ON public.helm_decision_commitment_snapshots (revision_id);

CREATE TABLE IF NOT EXISTS public.helm_decision_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_decision_revisions(id) ON DELETE RESTRICT,
  chosen_alternative_id uuid NOT NULL
    REFERENCES public.helm_decision_alternatives(id) ON DELETE RESTRICT,
  -- HELM never authors a commitment. The value says who did.
  authorship text NOT NULL CHECK (authorship IN ('MANAGEMENT_AUTHORED', 'MANAGEMENT_AUTHORED_DEMO')),
  committed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  committed_by_label text NOT NULL CHECK (char_length(btrim(committed_by_label)) >= 1),
  committed_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL DEFAULT '',
  -- Structured reasons, each pointing at what justifies it.
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rationale) = 'array'),
  accepted_trade_offs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(accepted_trade_offs) = 'array'),
  expected_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(expected_outcomes) = 'array'),
  review_triggers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_triggers) = 'array'),
  -- Phase 5 writes exactly one value here.
  authority_status text NOT NULL DEFAULT 'NOT_EVALUATED' CHECK (authority_status = 'NOT_EVALUATED'),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) >= 8),
  snapshot_id uuid NOT NULL
    REFERENCES public.helm_decision_commitment_snapshots(id) ON DELETE RESTRICT,

  -- A revision is committed ONCE. Reconsidering creates a new revision.
  CONSTRAINT helm_decision_commitments_once UNIQUE (revision_id),
  CONSTRAINT helm_decision_commitments_reasoned CHECK (jsonb_array_length(rationale) >= 1)
);

CREATE INDEX IF NOT EXISTS helm_decision_commitments_decision_idx
  ON public.helm_decision_commitments (org_id, decision_id, committed_at);

ALTER TABLE public.helm_decision_revisions DROP CONSTRAINT IF EXISTS helm_decision_revisions_reconsiders_fk;
ALTER TABLE public.helm_decision_revisions
  ADD CONSTRAINT helm_decision_revisions_reconsiders_fk
  FOREIGN KEY (reconsiders_commitment_id)
  REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT;

-- A commitment and its manifest are write-once. Correcting one means a new
-- revision and a new commitment; historical management truth is not edited.
CREATE OR REPLACE FUNCTION public.helm_decision_commitments_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
  alt record;
  snap record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_decision_commitments: a commitment is what management decided; it is never edited or deleted';
  END IF;

  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_commitments: revision not found for this decision and organization';
  END IF;

  SELECT * INTO alt FROM public.helm_decision_alternatives WHERE id = NEW.chosen_alternative_id;
  IF alt IS NULL OR alt.org_id <> NEW.org_id OR alt.revision_id IS DISTINCT FROM NEW.revision_id THEN
    RAISE EXCEPTION 'helm_decision_commitments: the chosen alternative is not on this revision';
  END IF;
  IF alt.status = 'WITHDRAWN' THEN
    RAISE EXCEPTION 'helm_decision_commitments: a withdrawn alternative cannot be the one chosen';
  END IF;

  SELECT * INTO snap FROM public.helm_decision_commitment_snapshots WHERE id = NEW.snapshot_id;
  IF snap IS NULL OR snap.org_id <> NEW.org_id OR snap.revision_id <> NEW.revision_id THEN
    RAISE EXCEPTION 'helm_decision_commitments: the evidence manifest does not belong to this revision';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_commitments_guard ON public.helm_decision_commitments;
CREATE TRIGGER helm_decision_commitments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_commitments
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_commitments_guard();

CREATE OR REPLACE FUNCTION public.helm_decision_snapshots_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_decision_commitment_snapshots: the evidence manifest is frozen; a later forecast never rewrites what management saw';
  END IF;
  SELECT * INTO rev FROM public.helm_decision_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_commitment_snapshots: revision not found for this decision and organization';
  END IF;
  -- The manifest records the revision's own knowledge boundary, exactly.
  IF NEW.effective_as_of <> rev.effective_as_of
     OR NEW.recorded_through <> rev.recorded_through
     OR NEW.observation_policy <> rev.observation_policy THEN
    RAISE EXCEPTION 'helm_decision_commitment_snapshots: the manifest must record its revision''s knowledge boundary';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_snapshots_guard ON public.helm_decision_commitment_snapshots;
CREATE TRIGGER helm_decision_snapshots_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_commitment_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_snapshots_guard();

-- ------------------------------------------------ action intents (migrated)

ALTER TABLE public.helm_actions ADD COLUMN IF NOT EXISTS commitment_id uuid
  REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_actions ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';
ALTER TABLE public.helm_actions ADD COLUMN IF NOT EXISTS target_system text;
ALTER TABLE public.helm_actions ADD COLUMN IF NOT EXISTS handoff_ref text;

ALTER TABLE public.helm_actions DROP CONSTRAINT IF EXISTS helm_actions_status_check;
ALTER TABLE public.helm_actions ADD CONSTRAINT helm_actions_status_check CHECK (
  status IN ('open', 'done', 'cancelled', 'INTENDED', 'IN_PROGRESS', 'DONE', 'CANCELLED')
);
-- A kernel action INTENT is bound to a commitment, names the system that will
-- do the work, and uses the kernel vocabulary. A legacy action does none of
-- those. HELM records the intent; Memoire and the ERP remain the systems of
-- execution.
ALTER TABLE public.helm_actions DROP CONSTRAINT IF EXISTS helm_actions_kernel_coherent;
ALTER TABLE public.helm_actions ADD CONSTRAINT helm_actions_kernel_coherent CHECK (
  (commitment_id IS NULL AND target_system IS NULL AND status IN ('open', 'done', 'cancelled'))
  OR (commitment_id IS NOT NULL AND target_system IS NOT NULL
      AND status IN ('INTENDED', 'IN_PROGRESS', 'DONE', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS helm_actions_commitment_idx
  ON public.helm_actions (commitment_id, created_at) WHERE commitment_id IS NOT NULL;

COMMENT ON COLUMN public.helm_actions.writeback IS
  'Pre-kernel Memoire write-back record. Phase 5 writes nothing outward: handoff_ref stays NULL until a connector claims an intent.';

-- ---------------------------------------------------------- outcome review

CREATE TABLE IF NOT EXISTS public.helm_decision_outcome_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_label text NOT NULL CHECK (char_length(btrim(reviewed_by_label)) >= 1),
  variances jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variances) = 'array'),
  assumption_results jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(assumption_results) = 'array'),
  notes text NOT NULL DEFAULT '',
  statement text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS helm_decision_outcome_reviews_decision_idx
  ON public.helm_decision_outcome_reviews (org_id, decision_id, reviewed_at);

-- A review is what was observed at a moment. It is never edited: a later look
-- is a later review.
CREATE OR REPLACE FUNCTION public.helm_decision_outcome_reviews_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_decision_outcome_reviews: a review is append-only; a later look is a later review';
  END IF;
  SELECT * INTO c FROM public.helm_decision_commitments WHERE id = NEW.commitment_id;
  IF c IS NULL OR c.org_id <> NEW.org_id OR c.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_decision_outcome_reviews: commitment not found for this decision and organization';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_outcome_reviews_guard ON public.helm_decision_outcome_reviews;
CREATE TRIGGER helm_decision_outcome_reviews_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_outcome_reviews
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_outcome_reviews_guard();

-- ---------------------------------------------------------------------- RLS

ALTER TABLE public.helm_decision_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_criterion_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_weightings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_commitment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_outcome_reviews ENABLE ROW LEVEL SECURITY;

-- Phase 5 PREPARATION ACCESS, not authority governance. Any organization
-- member may read a decision, prepare one and commit one; Phase 6 replaces
-- this with decision rights, approval chains and escalation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_revisions', 'helm_decision_criteria',
    'helm_decision_criterion_assessments', 'helm_decision_weightings',
    'helm_decision_challenges', 'helm_decision_evidence',
    'helm_decision_commitments', 'helm_decision_commitment_snapshots',
    'helm_decision_outcome_reviews'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Members read %s" ON public.%I
         FOR SELECT TO authenticated USING (public.is_org_member(org_id));', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Members write %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Members write %s" ON public.%I
         FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, ''member''));', t, t);
  END LOOP;
END;
$$;

-- UPDATE exists only where a guard allows one: sealing a revision, resolving a
-- challenge. Everything else the guards refuse.
DROP POLICY IF EXISTS "Members seal decision revisions" ON public.helm_decision_revisions;
CREATE POLICY "Members seal decision revisions" ON public.helm_decision_revisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS "Members resolve decision challenges" ON public.helm_decision_challenges;
CREATE POLICY "Members resolve decision challenges" ON public.helm_decision_challenges
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

-- DELETE exists only for a DRAFT revision's parts; the guards refuse the rest.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_criteria', 'helm_decision_criterion_assessments',
    'helm_decision_weightings', 'helm_decision_evidence'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members remove draft %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Members remove draft %s" ON public.%I
         FOR DELETE TO authenticated USING (public.has_org_role(org_id, ''member''));', t, t);
  END LOOP;
END;
$$;

-- -------------------------------------------------------------------- grants

REVOKE ALL ON TABLE
  public.helm_decision_revisions, public.helm_decision_criteria,
  public.helm_decision_criterion_assessments, public.helm_decision_weightings,
  public.helm_decision_challenges, public.helm_decision_evidence,
  public.helm_decision_commitments, public.helm_decision_commitment_snapshots,
  public.helm_decision_outcome_reviews
FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.helm_decision_revisions, public.helm_decision_criteria,
  public.helm_decision_criterion_assessments, public.helm_decision_weightings,
  public.helm_decision_challenges, public.helm_decision_evidence,
  public.helm_decision_commitments, public.helm_decision_commitment_snapshots,
  public.helm_decision_outcome_reviews
TO authenticated;
GRANT ALL ON TABLE
  public.helm_decision_revisions, public.helm_decision_criteria,
  public.helm_decision_criterion_assessments, public.helm_decision_weightings,
  public.helm_decision_challenges, public.helm_decision_evidence,
  public.helm_decision_commitments, public.helm_decision_commitment_snapshots,
  public.helm_decision_outcome_reviews
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_decisions_kernel_guard(), public.helm_decision_revisions_guard(),
  public.helm_decision_revision_is_draft(uuid), public.helm_decision_alternatives_guard(),
  public.helm_decision_assumptions_guard(), public.helm_decision_basis_guard(),
  public.helm_decision_challenges_guard(), public.helm_decision_commitments_guard(),
  public.helm_decision_snapshots_guard(), public.helm_decision_outcome_reviews_guard()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_decision_revision_is_draft(uuid) TO authenticated, service_role;

-- ---------------------------------------------------- the decision timeline

-- helm_decision_events is UNCHANGED as a table: it has been append-only since
-- Phase 1 (SELECT and INSERT policies only, and the absence of UPDATE/DELETE
-- policies is the guarantee). Phase 5 adopts it as the kernel decision
-- timeline and takes the same RLS fix Phase 2 and Phase 4 applied elsewhere:
-- auth.uid() hoisted out of the per-row check.
DROP POLICY IF EXISTS "Members append decision events" ON public.helm_decision_events;
CREATE POLICY "Members append decision events" ON public.helm_decision_events
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND actor_id = (select auth.uid()));
