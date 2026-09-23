-- ============================================================================
-- HELM Phase 4 — Scenario Runtime & Branching Future States
--
-- STRICTLY ADDITIVE. Only helm_* objects are created or altered. No Memoire
-- table, policy, index, trigger, function or embedding is touched. Nothing is
-- dropped except a HELM CHECK constraint that is re-added wider under the same
-- name, and triggers/functions re-created idempotently.
--
-- What this adds (ADR-0019, ADR-0020):
--
--   helm_scenarios                    MIGRATED: the pre-kernel CVP table becomes
--                                     the scenario identity. New columns only;
--                                     the legacy baseline/variants/decision_id
--                                     columns are retired in the app and kept.
--   helm_scenario_revisions           a fork point + periods + a sealed set of
--                                     overrides. Immutable once SEALED.
--   helm_scenario_overrides           explicit, attributed changes. Immutable;
--                                     removable only from a DRAFT revision.
--   helm_scenario_runs                one simulation of one modelled state
--                                     (baseline or scenario). Context immutable;
--                                     completes once.
--   helm_scenario_constraint_results  feasibility results. Append-only.
--   helm_calculation_runs             + the modelled period, the scenario
--                                     revision executed, and the replay scope.
--
-- Business logic stays in code. The triggers below enforce INTEGRITY only —
-- immutability, tenancy, coherence — and never compute a business value.
-- ============================================================================

-- ------------------------------------------------------ period validation

-- A period is {start, end, grain}, half-open. Validated where it is stored as
-- JSON (a revision's or a run's list of periods).
CREATE OR REPLACE FUNCTION public.helm_valid_periods(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  item jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) = 0 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR NOT (item ? 'start' AND item ? 'end' AND item ? 'grain')
       OR (item->>'grain') NOT IN ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM')
       OR (item->>'start') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
       OR (item->>'end') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
       OR (item->>'end') <= (item->>'start') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$fn$;

-- ------------------------------------------------ scenario identity (migrated)

ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS parent_scenario_id uuid
  REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS scenario_entity_id uuid
  REFERENCES public.helm_entities(id) ON DELETE RESTRICT;
ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'DRAFT';
ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE public.helm_scenarios ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- An analytical lifecycle, deliberately not the decision lifecycle.
ALTER TABLE public.helm_scenarios DROP CONSTRAINT IF EXISTS helm_scenarios_status_check;
ALTER TABLE public.helm_scenarios ADD CONSTRAINT helm_scenarios_status_check
  CHECK (status IN ('DRAFT', 'READY', 'RUNNING', 'COMPUTED', 'ARCHIVED', 'INVALIDATED'));
ALTER TABLE public.helm_scenarios DROP CONSTRAINT IF EXISTS helm_scenarios_key_format;
ALTER TABLE public.helm_scenarios ADD CONSTRAINT helm_scenarios_key_format
  CHECK (key IS NULL OR key ~ '^[a-z0-9][a-z0-9-]{0,62}$');
-- A kernel scenario has both a key and an ontology entity; a legacy row
-- (pre-Phase-4 CVP what-if) has neither.
ALTER TABLE public.helm_scenarios DROP CONSTRAINT IF EXISTS helm_scenarios_kernel_coherent;
ALTER TABLE public.helm_scenarios ADD CONSTRAINT helm_scenarios_kernel_coherent
  CHECK ((key IS NULL) = (scenario_entity_id IS NULL));
ALTER TABLE public.helm_scenarios DROP CONSTRAINT IF EXISTS helm_scenarios_no_self_parent;
ALTER TABLE public.helm_scenarios ADD CONSTRAINT helm_scenarios_no_self_parent
  CHECK (parent_scenario_id IS NULL OR parent_scenario_id <> id);

CREATE UNIQUE INDEX IF NOT EXISTS helm_scenarios_org_key_idx
  ON public.helm_scenarios (org_id, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS helm_scenarios_parent_idx
  ON public.helm_scenarios (parent_scenario_id) WHERE parent_scenario_id IS NOT NULL;

COMMENT ON COLUMN public.helm_scenarios.baseline IS
  'RETIRED (Phase 4): the pre-kernel CVP what-if baseline. Kernel scenarios leave it empty.';
COMMENT ON COLUMN public.helm_scenarios.variants IS
  'RETIRED (Phase 4): pre-kernel CVP variants. Kernel scenarios use helm_scenario_revisions.';
COMMENT ON COLUMN public.helm_scenarios.decision_id IS
  'RETIRED (Phase 4): decisions will link to scenario revisions and runs (Phase 5).';

-- Identity is immutable and the lifecycle only moves along allowed edges;
-- ARCHIVED and INVALIDATED are terminal.
CREATE OR REPLACE FUNCTION public.helm_scenarios_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  parent_org uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_scenario_id IS NOT NULL THEN
      SELECT org_id INTO parent_org FROM public.helm_scenarios WHERE id = NEW.parent_scenario_id;
      IF parent_org IS NULL OR parent_org <> NEW.org_id THEN
        RAISE EXCEPTION 'helm_scenarios: parent scenario not found in this organization';
      END IF;
    END IF;
    IF NEW.key IS NOT NULL AND NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_scenarios: a scenario is created as DRAFT';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.key IS NULL THEN
    RETURN NEW; -- legacy row: its own (retired) rules
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.scenario_entity_id IS DISTINCT FROM OLD.scenario_entity_id
     OR NEW.parent_scenario_id IS DISTINCT FROM OLD.parent_scenario_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'helm_scenarios: scenario identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT'    AND NEW.status IN ('READY', 'RUNNING', 'ARCHIVED', 'INVALIDATED'))
    OR (OLD.status = 'READY'    AND NEW.status IN ('DRAFT', 'RUNNING', 'ARCHIVED', 'INVALIDATED'))
    OR (OLD.status = 'RUNNING'  AND NEW.status IN ('COMPUTED', 'READY', 'INVALIDATED'))
    OR (OLD.status = 'COMPUTED' AND NEW.status IN ('DRAFT', 'READY', 'RUNNING', 'ARCHIVED', 'INVALIDATED'))
  ) THEN
    RAISE EXCEPTION 'helm_scenarios: a % scenario cannot become %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('ARCHIVED', 'INVALIDATED') THEN
    RAISE EXCEPTION 'helm_scenarios: % is terminal', OLD.status;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_scenarios_guard ON public.helm_scenarios;
CREATE TRIGGER helm_scenarios_guard BEFORE INSERT OR UPDATE ON public.helm_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.helm_scenarios_guard();

-- --------------------------------------------------------------- revisions

CREATE TABLE IF NOT EXISTS public.helm_scenario_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- RESTRICT throughout: a scenario with history cannot be deleted from under it.
  scenario_id uuid NOT NULL REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'SEALED')),
  reason text NOT NULL CHECK (reason IN ('CREATED', 'EDITED', 'REBASED')),
  based_on_revision_id uuid REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT,
  -- The parent scenario's revision this one inherits from, PINNED.
  parent_revision_id uuid REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT,

  -- The fork point: the baseline as known at this business/knowledge boundary.
  effective_as_of timestamptz NOT NULL,
  recorded_through timestamptz NOT NULL,
  observation_policy text NOT NULL
    CHECK (observation_policy IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY')),
  periods jsonb NOT NULL CHECK (public.helm_valid_periods(periods)),

  -- Fixed at sealing.
  model_ref jsonb,
  fingerprint text,
  sealed_at timestamptz,

  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_scenario_revisions_number_unique UNIQUE (scenario_id, revision_number),
  CONSTRAINT helm_scenario_revisions_sealed_coherent CHECK (
    (state = 'DRAFT' AND sealed_at IS NULL AND fingerprint IS NULL AND model_ref IS NULL)
    OR (state = 'SEALED' AND sealed_at IS NOT NULL AND fingerprint IS NOT NULL AND model_ref IS NOT NULL)
  )
);

-- One draft at a time per scenario.
CREATE UNIQUE INDEX IF NOT EXISTS helm_scenario_revisions_one_draft_idx
  ON public.helm_scenario_revisions (scenario_id) WHERE state = 'DRAFT';
CREATE INDEX IF NOT EXISTS helm_scenario_revisions_org_idx
  ON public.helm_scenario_revisions (org_id, scenario_id, revision_number);

CREATE OR REPLACE FUNCTION public.helm_scenario_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s_org uuid;
  s_parent uuid;
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_scenario_revisions: revisions are history and are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT org_id, parent_scenario_id INTO s_org, s_parent
      FROM public.helm_scenarios WHERE id = NEW.scenario_id;
    IF s_org IS NULL OR s_org <> NEW.org_id THEN
      RAISE EXCEPTION 'helm_scenario_revisions: scenario not found in this organization';
    END IF;
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'helm_scenario_revisions: a revision is created as DRAFT';
    END IF;
    IF NEW.based_on_revision_id IS NOT NULL THEN
      SELECT * INTO r FROM public.helm_scenario_revisions WHERE id = NEW.based_on_revision_id;
      IF r IS NULL OR r.scenario_id <> NEW.scenario_id THEN
        RAISE EXCEPTION 'helm_scenario_revisions: based_on must be a revision of the same scenario';
      END IF;
    END IF;
    IF NEW.parent_revision_id IS NOT NULL THEN
      SELECT * INTO r FROM public.helm_scenario_revisions WHERE id = NEW.parent_revision_id;
      IF r IS NULL OR r.org_id <> NEW.org_id OR r.scenario_id IS DISTINCT FROM s_parent
         OR r.state <> 'SEALED' THEN
        RAISE EXCEPTION 'helm_scenario_revisions: a pinned parent revision must be a sealed revision of the parent scenario';
      END IF;
    ELSIF s_parent IS NOT NULL THEN
      RAISE EXCEPTION 'helm_scenario_revisions: a child scenario''s revision must pin a parent revision';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a sealed revision never changes; a draft may only be sealed.
  IF OLD.state = 'SEALED' THEN
    RAISE EXCEPTION 'helm_scenario_revisions: a sealed revision is immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.scenario_id <> OLD.scenario_id
     OR NEW.revision_number <> OLD.revision_number OR NEW.reason <> OLD.reason
     OR NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id
     OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
     OR NEW.effective_as_of <> OLD.effective_as_of
     OR NEW.recorded_through <> OLD.recorded_through
     OR NEW.observation_policy <> OLD.observation_policy
     OR NEW.periods <> OLD.periods
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'helm_scenario_revisions: only sealing may change a draft revision';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_scenario_revisions_guard ON public.helm_scenario_revisions;
CREATE TRIGGER helm_scenario_revisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_scenario_revisions
  FOR EACH ROW EXECUTE FUNCTION public.helm_scenario_revisions_guard();

-- --------------------------------------------------------------- overrides

CREATE TABLE IF NOT EXISTS public.helm_scenario_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scenario_id uuid NOT NULL REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT,
  -- STRUCTURAL_OVERRIDE is defined in code and deliberately NOT storable:
  -- executing a structural change is deferred, and a row that could hold one
  -- would suggest otherwise.
  override_type text NOT NULL CHECK (override_type IN ('VALUE_OVERRIDE', 'ASSUMPTION_OVERRIDE')),
  target_node_id uuid NOT NULL REFERENCES public.helm_value_nodes(id) ON DELETE RESTRICT,
  metric_key text NOT NULL,
  subject_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('SET', 'ADD')),
  -- Exact canonical decimal, as text: a float would round the assumption.
  value text NOT NULL CHECK (value ~ '^-?[0-9]+(\.[0-9]+)?$'),
  unit_type text NOT NULL CHECK (unit_type IN
    ('currency', 'percentage', 'ratio', 'units', 'count', 'days', 'hours', 'capacity', 'score', 'index')),
  currency text CHECK (currency IS NULL OR char_length(currency) = 3),
  -- NULL period = every period of the revision.
  period_start timestamptz,
  period_end timestamptz,
  period_grain text CHECK (period_grain IS NULL OR period_grain IN
    ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM')),
  provenance_kind text NOT NULL CHECK (provenance_kind IN
    ('MANAGEMENT_ASSUMPTION', 'MODEL_ASSUMPTION', 'USER_OVERRIDE', 'SYSTEM_GENERATED', 'EXTERNAL_SIGNAL')),
  source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 1 AND 64),
  -- A scenario assumption nobody can explain is not one.
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_scenario_overrides_period_coherent CHECK (
    (period_start IS NULL AND period_end IS NULL AND period_grain IS NULL)
    OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_grain IS NOT NULL
        AND period_end > period_start)
  ),
  CONSTRAINT helm_scenario_overrides_currency_coherent CHECK (
    (unit_type = 'currency') = (currency IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS helm_scenario_overrides_revision_idx
  ON public.helm_scenario_overrides (revision_id, target_node_id);

CREATE OR REPLACE FUNCTION public.helm_scenario_overrides_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
  node_org uuid;
  node_metric text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'helm_scenario_overrides: an override is immutable; remove it from a draft and add another';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT state INTO rev FROM public.helm_scenario_revisions WHERE id = OLD.revision_id;
    IF rev.state IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'helm_scenario_overrides: overrides of a sealed revision cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO rev FROM public.helm_scenario_revisions WHERE id = NEW.revision_id;
  IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.scenario_id <> NEW.scenario_id THEN
    RAISE EXCEPTION 'helm_scenario_overrides: revision not found for this scenario and organization';
  END IF;
  IF rev.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'helm_scenario_overrides: a sealed revision is immutable';
  END IF;

  SELECT n.org_id, m.key INTO node_org, node_metric
    FROM public.helm_value_nodes n JOIN public.helm_value_metrics m ON m.id = n.metric_id
   WHERE n.id = NEW.target_node_id;
  IF node_org IS NULL OR node_org <> NEW.org_id THEN
    RAISE EXCEPTION 'helm_scenario_overrides: target value node not found in this organization';
  END IF;
  IF node_metric <> NEW.metric_key THEN
    RAISE EXCEPTION 'helm_scenario_overrides: metric_key does not match the target node';
  END IF;

  -- One target, one assumption per revision: a whole-horizon override
  -- overlaps every period-specific one.
  IF EXISTS (
    SELECT 1 FROM public.helm_scenario_overrides o
     WHERE o.revision_id = NEW.revision_id AND o.target_node_id = NEW.target_node_id
       AND (o.period_start IS NULL OR NEW.period_start IS NULL
            OR (o.period_start = NEW.period_start AND o.period_end = NEW.period_end))
  ) THEN
    RAISE EXCEPTION 'helm_scenario_overrides: this revision already overrides that target for that period';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_scenario_overrides_guard ON public.helm_scenario_overrides;
CREATE TRIGGER helm_scenario_overrides_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_scenario_overrides
  FOR EACH ROW EXECUTE FUNCTION public.helm_scenario_overrides_guard();

-- -------------------------------------------------------------- simulations

CREATE TABLE IF NOT EXISTS public.helm_scenario_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  state_kind text NOT NULL CHECK (state_kind IN ('BASELINE', 'SCENARIO')),
  scenario_id uuid REFERENCES public.helm_scenarios(id) ON DELETE RESTRICT,
  revision_id uuid REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('EXECUTE', 'REPLAY')),
  replay_of_run_id uuid REFERENCES public.helm_scenario_runs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  completeness text CHECK (completeness IS NULL OR completeness IN ('COMPLETE', 'PARTIAL', 'INVALID')),

  -- The exact boundary executed.
  effective_as_of timestamptz NOT NULL,
  recorded_through timestamptz NOT NULL,
  observation_policy text NOT NULL
    CHECK (observation_policy IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'ASSUMPTION_ONLY')),
  periods jsonb NOT NULL CHECK (public.helm_valid_periods(periods)),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) >= 8),
  model_ref jsonb NOT NULL,
  -- [{ "period": {start,end,grain}, "calculationRunId": uuid }], one per period.
  period_runs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(period_runs) = 'array'),

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,

  CONSTRAINT helm_scenario_runs_kind_coherent CHECK (
    (state_kind = 'BASELINE' AND scenario_id IS NULL AND revision_id IS NULL)
    OR (state_kind = 'SCENARIO' AND scenario_id IS NOT NULL AND revision_id IS NOT NULL)
  ),
  CONSTRAINT helm_scenario_runs_completion_coherent CHECK (
    (status = 'RUNNING' AND completed_at IS NULL AND completeness IS NULL)
    OR (status <> 'RUNNING' AND completed_at IS NOT NULL AND completeness IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS helm_scenario_runs_scenario_idx
  ON public.helm_scenario_runs (org_id, scenario_id, started_at DESC);
CREATE INDEX IF NOT EXISTS helm_scenario_runs_revision_idx
  ON public.helm_scenario_runs (revision_id) WHERE revision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.helm_scenario_runs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
  item jsonb;
  calc record;
  i integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_scenario_runs: a simulation is history and is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RUNNING' OR jsonb_array_length(NEW.period_runs) <> 0 THEN
      RAISE EXCEPTION 'helm_scenario_runs: a simulation starts RUNNING with no period runs';
    END IF;
    IF NEW.state_kind = 'SCENARIO' THEN
      SELECT * INTO rev FROM public.helm_scenario_revisions WHERE id = NEW.revision_id;
      IF rev IS NULL OR rev.org_id <> NEW.org_id OR rev.scenario_id <> NEW.scenario_id THEN
        RAISE EXCEPTION 'helm_scenario_runs: revision not found for this scenario and organization';
      END IF;
      IF rev.state <> 'SEALED' THEN
        RAISE EXCEPTION 'helm_scenario_runs: only a sealed revision can be simulated';
      END IF;
      -- The run executes its revision's boundary, exactly.
      IF rev.effective_as_of <> NEW.effective_as_of OR rev.recorded_through <> NEW.recorded_through
         OR rev.observation_policy <> NEW.observation_policy THEN
        RAISE EXCEPTION 'helm_scenario_runs: a scenario run must use its revision''s fork point';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only a RUNNING simulation changes, and only by appending period
  -- runs and completing. Its context never changes.
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'helm_scenario_runs: a completed simulation is immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.state_kind <> OLD.state_kind
     OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.kind <> OLD.kind OR NEW.replay_of_run_id IS DISTINCT FROM OLD.replay_of_run_id
     OR NEW.effective_as_of <> OLD.effective_as_of OR NEW.recorded_through <> OLD.recorded_through
     OR NEW.observation_policy <> OLD.observation_policy OR NEW.periods <> OLD.periods
     OR NEW.fingerprint <> OLD.fingerprint OR NEW.model_ref <> OLD.model_ref
     OR NEW.started_at <> OLD.started_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'helm_scenario_runs: a simulation''s context is immutable';
  END IF;
  IF jsonb_array_length(NEW.period_runs) < jsonb_array_length(OLD.period_runs) THEN
    RAISE EXCEPTION 'helm_scenario_runs: period runs are append-only';
  END IF;
  FOR i IN 0 .. jsonb_array_length(OLD.period_runs) - 1 LOOP
    IF NEW.period_runs->i <> OLD.period_runs->i THEN
      RAISE EXCEPTION 'helm_scenario_runs: period runs are append-only';
    END IF;
  END LOOP;
  -- Each appended period run must be a calculation run of this organization
  -- that executed THIS revision (or none, for a baseline).
  FOR i IN jsonb_array_length(OLD.period_runs) .. jsonb_array_length(NEW.period_runs) - 1 LOOP
    item := NEW.period_runs->i;
    SELECT org_id, scenario_revision_id INTO calc
      FROM public.helm_calculation_runs WHERE id = (item->>'calculationRunId')::uuid;
    IF calc IS NULL OR calc.org_id <> NEW.org_id
       OR calc.scenario_revision_id IS DISTINCT FROM NEW.revision_id THEN
      RAISE EXCEPTION 'helm_scenario_runs: a period run must be a calculation run of this simulation''s revision';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_scenario_runs_guard ON public.helm_scenario_runs;
CREATE TRIGGER helm_scenario_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_scenario_runs
  FOR EACH ROW EXECUTE FUNCTION public.helm_scenario_runs_guard();

-- ------------------------------------------------------ constraint results

CREATE TABLE IF NOT EXISTS public.helm_scenario_constraint_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scenario_run_id uuid NOT NULL REFERENCES public.helm_scenario_runs(id) ON DELETE RESTRICT,
  constraint_key text NOT NULL CHECK (char_length(constraint_key) BETWEEN 1 AND 120),
  constraint_version text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INVENTORY', 'CAPACITY', 'CASH', 'POLICY', 'DELIVERY_TIMING')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  period_grain text NOT NULL CHECK (period_grain IN ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM')),
  status text NOT NULL CHECK (status IN ('SATISFIED', 'BREACHED', 'UNKNOWN')),
  threshold text,
  actual text,
  breach_amount text,
  unit_type text,
  severity text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  explanation text NOT NULL CHECK (char_length(explanation) >= 1),
  evaluated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_scenario_constraint_results_once UNIQUE (scenario_run_id, constraint_key, period_start),
  CONSTRAINT helm_scenario_constraint_results_breach_coherent CHECK (
    (status = 'BREACHED') = (breach_amount IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.helm_scenario_constraint_results_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  run record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_scenario_constraint_results: results are append-only';
  END IF;
  SELECT org_id, status INTO run FROM public.helm_scenario_runs WHERE id = NEW.scenario_run_id;
  IF run IS NULL OR run.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'helm_scenario_constraint_results: simulation not found in this organization';
  END IF;
  IF run.status = 'RUNNING' THEN
    RAISE EXCEPTION 'helm_scenario_constraint_results: a simulation is judged after it completes';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_scenario_constraint_results_guard ON public.helm_scenario_constraint_results;
CREATE TRIGGER helm_scenario_constraint_results_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_scenario_constraint_results
  FOR EACH ROW EXECUTE FUNCTION public.helm_scenario_constraint_results_guard();

-- ---------------------------------------------------- calculation runs: period

ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS period_end timestamptz;
ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS period_grain text;
ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS scenario_revision_id uuid
  REFERENCES public.helm_scenario_revisions(id) ON DELETE RESTRICT;
-- What the run started from, so a replay re-plans the same scope.
ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS root_metric_keys text[]
  NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE public.helm_calculation_runs ADD COLUMN IF NOT EXISTS subject_entity_ids uuid[]
  NOT NULL DEFAULT ARRAY[]::uuid[];

ALTER TABLE public.helm_calculation_runs DROP CONSTRAINT IF EXISTS helm_calculation_runs_period_coherent;
ALTER TABLE public.helm_calculation_runs ADD CONSTRAINT helm_calculation_runs_period_coherent CHECK (
  (period_start IS NULL AND period_end IS NULL AND period_grain IS NULL)
  OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start
      AND period_grain IN ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM'))
);

-- WIDENED: a scenario entity is present for the legacy SCENARIO policy, OR
-- for a run that executed a scenario revision under a source policy. A
-- baseline run has neither.
ALTER TABLE public.helm_calculation_runs DROP CONSTRAINT IF EXISTS helm_calculation_runs_scenario_coherent;
ALTER TABLE public.helm_calculation_runs ADD CONSTRAINT helm_calculation_runs_scenario_coherent CHECK (
  (preference = 'SCENARIO' AND scenario_entity_id IS NOT NULL AND scenario_revision_id IS NULL)
  OR (preference <> 'SCENARIO' AND scenario_revision_id IS NOT NULL AND scenario_entity_id IS NOT NULL)
  OR (preference <> 'SCENARIO' AND scenario_revision_id IS NULL AND scenario_entity_id IS NULL)
);

CREATE INDEX IF NOT EXISTS helm_calculation_runs_revision_idx
  ON public.helm_calculation_runs (scenario_revision_id) WHERE scenario_revision_id IS NOT NULL;

-- ---------------------------------------------------------------------- RLS

ALTER TABLE public.helm_scenario_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_scenario_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_scenario_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_scenario_constraint_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Members read scenario revisions" ON public.helm_scenario_revisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
DROP POLICY IF EXISTS "Members create scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Members create scenario revisions" ON public.helm_scenario_revisions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()));
-- UPDATE exists only to seal a draft; the guard refuses anything else.
DROP POLICY IF EXISTS "Members seal scenario revisions" ON public.helm_scenario_revisions;
CREATE POLICY "Members seal scenario revisions" ON public.helm_scenario_revisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS "Members read scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Members read scenario overrides" ON public.helm_scenario_overrides
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
DROP POLICY IF EXISTS "Members add scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Members add scenario overrides" ON public.helm_scenario_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()));
-- DELETE exists only for a DRAFT revision's overrides; the guard refuses the rest.
DROP POLICY IF EXISTS "Members remove draft scenario overrides" ON public.helm_scenario_overrides;
CREATE POLICY "Members remove draft scenario overrides" ON public.helm_scenario_overrides
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS "Members read scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Members read scenario runs" ON public.helm_scenario_runs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
DROP POLICY IF EXISTS "Members start scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Members start scenario runs" ON public.helm_scenario_runs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND created_by = (select auth.uid()));
DROP POLICY IF EXISTS "Members complete scenario runs" ON public.helm_scenario_runs;
CREATE POLICY "Members complete scenario runs" ON public.helm_scenario_runs
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS "Members read constraint results" ON public.helm_scenario_constraint_results;
CREATE POLICY "Members read constraint results" ON public.helm_scenario_constraint_results
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
DROP POLICY IF EXISTS "Members record constraint results" ON public.helm_scenario_constraint_results;
CREATE POLICY "Members record constraint results" ON public.helm_scenario_constraint_results
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

-- -------------------------------------------------------------------- grants

REVOKE ALL ON TABLE
  public.helm_scenario_revisions, public.helm_scenario_overrides,
  public.helm_scenario_runs, public.helm_scenario_constraint_results
FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.helm_scenario_revisions, public.helm_scenario_overrides,
  public.helm_scenario_runs, public.helm_scenario_constraint_results
TO authenticated;
GRANT ALL ON TABLE
  public.helm_scenario_revisions, public.helm_scenario_overrides,
  public.helm_scenario_runs, public.helm_scenario_constraint_results
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_valid_periods(jsonb), public.helm_scenarios_guard(),
  public.helm_scenario_revisions_guard(), public.helm_scenario_overrides_guard(),
  public.helm_scenario_runs_guard(), public.helm_scenario_constraint_results_guard()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_valid_periods(jsonb) TO authenticated, service_role;
