-- ============================================================================
-- HELM Phase 3 — Value Propagation
--
-- STRICTLY ADDITIVE. Only helm_*-prefixed objects. No Memoire table, policy,
-- index, trigger or function is altered or dropped. Re-running is a no-op.
--
-- Three tables and one widened CHECK:
--
--   helm_calculations       governance metadata for every executable definition
--   helm_calculation_runs   one execution of the model, with its full context
--   helm_calculation_steps  the append-only trace: one row per value position
--
-- WHAT IS NOT HERE, deliberately:
--
--   * No executable code. helm_calculations stores the human-readable
--     expression and the declared inputs; the implementation is a typed pure
--     function in packages/propagation-engine. There is nothing here for an
--     interpreter to run, because there is no interpreter (§13, ADR-0017 §1).
--   * No formula evaluation in a trigger. Business logic in a trigger is
--     invisible to tests, impossible to version and impossible to explain, so
--     no trigger computes a value (§28). The triggers below only enforce
--     integrity the schema cannot express.
--
-- GENERATED FILE -- produced by scripts/generate-calculation-migration.mjs from
-- packages/propagation-engine/src/meridianValueModelV1.ts. Do not hand-edit the
-- seed section.
-- ============================================================================

-- --------------------------------------------------- provenance subject kinds
-- Widening a CHECK on a HELM-owned table so calculation runs and steps can use
-- the same provenance mechanism as entities and observations.

ALTER TABLE public.helm_provenance DROP CONSTRAINT IF EXISTS helm_provenance_subject_kind_check;
ALTER TABLE public.helm_provenance ADD CONSTRAINT helm_provenance_subject_kind_check
  CHECK (subject_kind IN
    ('entity', 'relationship', 'entity_version',
     'value_node', 'value_link', 'value_observation',
     'calculation_run', 'calculation_step'));

-- ------------------------------------------------- calculation definitions

-- Governance, not logic. Every column here answers a question a manager is
-- entitled to ask about a number: who owns this formula, why does it exist,
-- when did it take effect, what does it depend on, and how well does the model
-- claim to represent reality.
CREATE TABLE IF NOT EXISTS public.helm_calculations (
  -- 'calc_expected_revenue@1.0.0' -- readable and deterministic, so the code
  -- registry and these rows can be diffed without a mapping table.
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  -- NULL = shipped by HELM. Organizations add their own without a migration.
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  -- A meaning change is a NEW VERSION, never an edit: a trace from last quarter
  -- must still resolve the formula that actually produced its numbers (§62).
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) >= 20),
  -- Not optional. A management calculation nobody can justify is not a
  -- calculation, it is anonymous magic (§63).
  rationale text NOT NULL CHECK (char_length(rationale) >= 20),
  owner text NOT NULL CHECK (char_length(owner) >= 2),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED')),
  effective_from date NOT NULL,

  output_metric_id text NOT NULL REFERENCES public.helm_value_metrics(id) ON DELETE RESTRICT,
  output_unit text NOT NULL CHECK (output_unit IN
    ('currency', 'percentage', 'ratio', 'units', 'count',
     'days', 'hours', 'capacity', 'score', 'index')),
  -- Which entity-type categories this calculation may produce output for.
  -- NULL = any. A deal-level margin formula must not quietly run on an
  -- enterprise subject and present the result as a consolidation.
  scope_compatibility text[],

  -- How well the MODEL represents reality, independent of input quality.
  -- inventory_requirement@1.0.0 is demand with no stock policy at all, so it
  -- declares less than 1: the arithmetic is exact, the model is crude.
  definition_confidence numeric NOT NULL
    CHECK (definition_confidence >= 0 AND definition_confidence <= 1),

  -- Human-readable formula, shown in traces. NEVER EVALUATED. There is no
  -- expression evaluator in HELM and this column is not a back door to one.
  expression text NOT NULL CHECK (char_length(expression) >= 1),
  -- The declared inputs, as data: name, metric, binding, unit, preference,
  -- horizon. Enough to answer "what does this depend on?" in SQL.
  inputs jsonb NOT NULL DEFAULT '[]'::jsonb,

  is_system boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A calculation with no inputs is a constant, and a business constant belongs
  -- in an ASSUMPTION observation where it can be owned and reviewed (§20).
  CONSTRAINT helm_calculations_has_inputs CHECK (jsonb_array_length(inputs) > 0),
  -- An empty scope list would mean the calculation can run on nothing.
  CONSTRAINT helm_calculations_scope_nonempty CHECK (
    scope_compatibility IS NULL OR array_length(scope_compatibility, 1) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS helm_calculations_system_key_idx
  ON public.helm_calculations (key, version) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS helm_calculations_org_key_idx
  ON public.helm_calculations (org_id, key, version) WHERE org_id IS NOT NULL;
-- At most one ACTIVE row per key per tenant: two live definitions of the same
-- calculation would make "which formula is in force?" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS helm_calculations_one_active_system_idx
  ON public.helm_calculations (key) WHERE org_id IS NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS helm_calculations_one_active_org_idx
  ON public.helm_calculations (org_id, key) WHERE org_id IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS helm_calculations_output_idx
  ON public.helm_calculations (output_metric_id) WHERE status = 'ACTIVE';

-- ------------------------------------------------------------ calculation runs

-- One execution of the model. The context is recorded in full because a run
-- that cannot be reproduced cannot be defended, and a manager who asks "what
-- was this based on?" is asking about exactly these columns (§59).
CREATE TABLE IF NOT EXISTS public.helm_calculation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  trigger_type text NOT NULL
    CHECK (trigger_type IN ('MANUAL', 'SOURCE_CHANGE', 'SCENARIO', 'SYSTEM', 'REPLAY')),

  -- The lens the run looked through. as_of selects inputs; it is NOT part of a
  -- step's input fingerprint, because the clock moving is not an input changing.
  as_of timestamptz NOT NULL,
  horizon text CHECK (horizon IS NULL OR horizon IN
    ('current', 'month', 'quarter', 'year', 'lifetime')),
  preference text NOT NULL
    CHECK (preference IN ('BASELINE', 'ACTUALS_FIRST', 'SCENARIO', 'ASSUMPTION_ONLY')),
  -- Present exactly when this run computes a scenario rather than reality.
  scenario_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  root_node_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  engine_version text NOT NULL,

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  replay_of_run_id uuid REFERENCES public.helm_calculation_runs(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- A scenario run must name its scenario; a baseline run must not have one.
  CONSTRAINT helm_calculation_runs_scenario_coherent CHECK (
    (preference = 'SCENARIO' AND scenario_entity_id IS NOT NULL)
    OR (preference <> 'SCENARIO' AND scenario_entity_id IS NULL)
  ),
  CONSTRAINT helm_calculation_runs_finished CHECK (
    (status = 'RUNNING' AND completed_at IS NULL) OR status <> 'RUNNING'
  )
);

CREATE INDEX IF NOT EXISTS helm_calculation_runs_org_idx
  ON public.helm_calculation_runs (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS helm_calculation_runs_scenario_idx
  ON public.helm_calculation_runs (org_id, scenario_entity_id)
  WHERE scenario_entity_id IS NOT NULL;

-- ----------------------------------------------------------- calculation steps

-- The trace. One row per value position the run touched, including the ones it
-- could NOT compute: a step that says why it was blocked is worth more than a
-- silent absence, because a manager can act on the former (§48, §49).
--
-- APPEND-ONLY. There is no UPDATE and no DELETE policy. A recorded derivation
-- is history; rewriting it would destroy the only defensible account of how a
-- number came to exist (§51).
CREATE TABLE IF NOT EXISTS public.helm_calculation_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.helm_calculation_runs(id) ON DELETE CASCADE,
  -- Deterministic execution order within the run.
  sequence integer NOT NULL CHECK (sequence >= 0),

  -- Recorded as text rather than as a foreign key to helm_calculations: the
  -- trace must survive a definition being retired, and it records what RAN,
  -- not what is registered now.
  calculation_key text NOT NULL,
  calculation_version text NOT NULL CHECK (calculation_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),

  output_node_id uuid NOT NULL REFERENCES public.helm_value_nodes(id) ON DELETE CASCADE,
  output_metric_id text NOT NULL REFERENCES public.helm_value_metrics(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN
    ('CALCULATED', 'UNCHANGED', 'BLOCKED', 'FAILED', 'SKIPPED')),

  -- The exact decimal, as text. Not a float: 8.4 must come back as 8.4, and
  -- 2687699999.999938 must not be rounded into a tidier lie (ADR-0016).
  output_value text,
  output_unit text CHECK (output_unit IS NULL OR output_unit IN
    ('currency', 'percentage', 'ratio', 'units', 'count',
     'days', 'hours', 'capacity', 'score', 'index')),
  output_currency text CHECK (output_currency IS NULL OR char_length(output_currency) = 3),
  output_observation_id uuid REFERENCES public.helm_value_observations(id) ON DELETE SET NULL,
  -- The formula with the real numbers substituted in.
  rendered_expression text,
  -- Every input as it was actually used: name, metric, observation id, exact
  -- value, unit, source system. This is what makes "which number did it use?"
  -- answerable years later.
  inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  input_fingerprint text,
  error_code text,
  error_message text,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  -- A calculated step has a value, the observation it wrote, and the formula
  -- rendered with real numbers. Anything less is not auditable.
  CONSTRAINT helm_calculation_steps_calculated_complete CHECK (
    status <> 'CALCULATED'
    OR (output_value IS NOT NULL
        AND output_unit IS NOT NULL
        AND output_observation_id IS NOT NULL
        AND rendered_expression IS NOT NULL
        AND input_fingerprint IS NOT NULL)
  ),
  -- A step that did not run must say why, in terms a manager can act on.
  CONSTRAINT helm_calculation_steps_failure_explained CHECK (
    status NOT IN ('BLOCKED', 'FAILED')
    OR (error_code IS NOT NULL AND char_length(error_message) >= 20)
  ),
  CONSTRAINT helm_calculation_steps_currency_coherent CHECK (
    (output_unit = 'currency' AND output_currency IS NOT NULL)
    OR (output_unit IS DISTINCT FROM 'currency' AND output_currency IS NULL)
  ),
  CONSTRAINT helm_calculation_steps_unique_sequence UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS helm_calculation_steps_run_idx
  ON public.helm_calculation_steps (run_id, sequence);
CREATE INDEX IF NOT EXISTS helm_calculation_steps_node_idx
  ON public.helm_calculation_steps (org_id, output_node_id, recorded_at DESC);
-- The entry point for explain(): from an observation to the step that made it.
CREATE UNIQUE INDEX IF NOT EXISTS helm_calculation_steps_output_obs_idx
  ON public.helm_calculation_steps (output_observation_id)
  WHERE output_observation_id IS NOT NULL;

-- ------------------------------------------ observations may now be derived

-- Phase 2 required calculation_run_id to be NULL, because nothing derived
-- anything. Phase 3 replaces that with the rule that actually matters: a run id
-- belongs on a DERIVED or SCENARIO observation and on nothing else. An ACTUAL
-- that claimed to have been calculated would be a category error.
ALTER TABLE public.helm_value_observations
  DROP CONSTRAINT IF EXISTS helm_value_obs_no_calculation;

ALTER TABLE public.helm_value_observations
  DROP CONSTRAINT IF EXISTS helm_value_obs_calculation_coherent;
ALTER TABLE public.helm_value_observations
  ADD CONSTRAINT helm_value_obs_calculation_coherent CHECK (
    calculation_run_id IS NULL OR observation_type IN ('DERIVED', 'SCENARIO')
  );

-- The column was reserved in Phase 2 without a target. Now it has one.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'helm_value_obs_calculation_run_fk'
      AND conrelid = 'public.helm_value_observations'::regclass
  ) THEN
    ALTER TABLE public.helm_value_observations
      ADD CONSTRAINT helm_value_obs_calculation_run_fk
      FOREIGN KEY (calculation_run_id)
      REFERENCES public.helm_calculation_runs(id) ON DELETE SET NULL;
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS helm_value_obs_calculation_idx
  ON public.helm_value_observations (org_id, calculation_run_id)
  WHERE calculation_run_id IS NOT NULL;

-- ------------------------------------------ integrity (defence in depth)

-- RLS and column CHECKs cannot compare a step against the run and node it
-- belongs to. This trigger does, and it computes nothing: it only refuses rows
-- that would make a trace incoherent. Business formulas stay in code (§28).
CREATE OR REPLACE FUNCTION public.helm_calculation_step_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  r public.helm_calculation_runs;
  n public.helm_value_nodes;
BEGIN
  SELECT * INTO r FROM public.helm_calculation_runs WHERE id = NEW.run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'calculation run % does not exist', NEW.run_id;
  END IF;
  IF r.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'step org % does not match run org %', NEW.org_id, r.org_id;
  END IF;

  SELECT * INTO n FROM public.helm_value_nodes WHERE id = NEW.output_node_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'value node % does not exist', NEW.output_node_id;
  END IF;
  IF n.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'step org % does not match value node org %', NEW.org_id, n.org_id;
  END IF;

  -- The step must write to the metric the node actually carries, or the trace
  -- would describe a derivation that did not happen.
  IF n.metric_id <> NEW.output_metric_id THEN
    RAISE EXCEPTION
      'step claims metric % but value node % carries %',
      NEW.output_metric_id, NEW.output_node_id, n.metric_id;
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.helm_calculation_step_integrity() FROM anon, public;

DROP TRIGGER IF EXISTS helm_calculation_steps_integrity_trg ON public.helm_calculation_steps;
CREATE TRIGGER helm_calculation_steps_integrity_trg
  BEFORE INSERT OR UPDATE ON public.helm_calculation_steps
  FOR EACH ROW EXECUTE FUNCTION public.helm_calculation_step_integrity();

-- A run's scenario must be a Scenario entity in the same organization.
CREATE OR REPLACE FUNCTION public.helm_calculation_run_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  other_org uuid;
  type_key text;
BEGIN
  IF NEW.scenario_entity_id IS NOT NULL THEN
    -- helm_entities stores the type by id ('et_scenario'); the readable key
    -- lives in the registry table, so the check joins rather than assuming.
    SELECT e.org_id, t.key INTO other_org, type_key
      FROM public.helm_entities e
      JOIN public.helm_entity_types t ON t.id = e.entity_type_id
      WHERE e.id = NEW.scenario_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calculation run scenario entity % does not exist', NEW.scenario_entity_id;
    END IF;
    IF other_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'run org % cannot reference scenario in org %', NEW.org_id, other_org;
    END IF;
    IF type_key <> 'Scenario' THEN
      RAISE EXCEPTION 'a calculation run scenario must be a Scenario entity, got %', type_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.helm_calculation_run_integrity() FROM anon, public;

DROP TRIGGER IF EXISTS helm_calculation_runs_integrity_trg ON public.helm_calculation_runs;
CREATE TRIGGER helm_calculation_runs_integrity_trg
  BEFORE INSERT OR UPDATE ON public.helm_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION public.helm_calculation_run_integrity();

DROP TRIGGER IF EXISTS helm_calculations_updated_at ON public.helm_calculations;
CREATE TRIGGER helm_calculations_updated_at BEFORE UPDATE ON public.helm_calculations
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

-- ------------------------------------------------------------------------ RLS

ALTER TABLE public.helm_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_calculation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_calculation_steps ENABLE ROW LEVEL SECURITY;

-- Shipped calculations are readable by any authenticated user; a tenant's own
-- definitions only by that tenant. Changing a calculation is an admin act,
-- because it changes what every number downstream of it means.
DROP POLICY IF EXISTS helm_calculations_read ON public.helm_calculations;
CREATE POLICY helm_calculations_read ON public.helm_calculations
  FOR SELECT TO authenticated
  USING (org_id IS NULL OR public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_calculations_insert ON public.helm_calculations;
CREATE POLICY helm_calculations_insert ON public.helm_calculations
  FOR INSERT TO authenticated
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_calculations_update ON public.helm_calculations;
CREATE POLICY helm_calculations_update ON public.helm_calculations
  FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'))
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_calculations_delete ON public.helm_calculations;
CREATE POLICY helm_calculations_delete ON public.helm_calculations
  FOR DELETE TO authenticated
  USING (org_id IS NOT NULL AND is_system = false AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_calculation_runs_read ON public.helm_calculation_runs;
CREATE POLICY helm_calculation_runs_read ON public.helm_calculation_runs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_calculation_runs_insert ON public.helm_calculation_runs;
CREATE POLICY helm_calculation_runs_insert ON public.helm_calculation_runs
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

-- A run may be completed (status and completed_at set); it may not be rewritten
-- into a different run, which is why there is no DELETE policy.
DROP POLICY IF EXISTS helm_calculation_runs_update ON public.helm_calculation_runs;
CREATE POLICY helm_calculation_runs_update ON public.helm_calculation_runs
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

-- Steps are append-only: no UPDATE policy, no DELETE policy. The same guarantee
-- as helm_value_observations and helm_decision_events.
DROP POLICY IF EXISTS helm_calculation_steps_read ON public.helm_calculation_steps;
CREATE POLICY helm_calculation_steps_read ON public.helm_calculation_steps
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_calculation_steps_insert ON public.helm_calculation_steps;
CREATE POLICY helm_calculation_steps_insert ON public.helm_calculation_steps
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

-- --------------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_calculations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helm_calculation_runs TO authenticated;
GRANT SELECT, INSERT ON public.helm_calculation_steps TO authenticated;

-- ============================================================================
-- SEED: Meridian Pharma Value Model v1 (org_id IS NULL, is_system = true)
--
-- Generated from packages/propagation-engine/src/meridianValueModelV1.ts.
-- Metadata only -- no executable code. Idempotent.
-- ============================================================================

INSERT INTO public.helm_calculations
  (id, org_id, key, version, name, description, rationale, owner, status,
   effective_from, output_metric_id, output_unit, scope_compatibility,
   definition_confidence, expression, inputs, is_system, metadata)
VALUES
  ('calc_expected_revenue@1.0.0', NULL, 'expected_revenue', '1.0.0', 'Expected Revenue', 'Probability-weighted revenue from an opportunity.', 'Commercial commitments are uncertain. Weighting the opportunity value by its probability gives the revenue the business can plan against, rather than the best case it can hope for.', 'Country GM Vietnam', 'ACTIVE', '2026-10-01', 'vm_expectedrevenue', 'currency', ARRAY['commercial', 'market']::text[], 1, 'opportunity_value × opportunity_probability', '[{"name":"opportunity_value","metricKey":"OpportunityValue","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"The full value of the opportunity, before probability weighting."},{"name":"opportunity_probability","metricKey":"OpportunityProbability","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"ratio","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Likelihood the opportunity closes, as a ratio between 0 and 1."}]'::jsonb, true, '{}'::jsonb),
  ('calc_demand_quantity@1.0.0', NULL, 'demand_quantity', '1.0.0', 'Demand Quantity', 'Probability-weighted expected unit demand implied by expected revenue.', 'Expected revenue has to become physical demand before supply can be planned. Dividing by the average selling price converts money into units. The result is deliberately fractional: 8.4 units is the expected value across outcomes, not a shipment. Rounding to a whole number is a commercial commitment decision, not a calculation, so this model does not do it.', 'Country GM Vietnam', 'ACTIVE', '2026-10-01', 'vm_demandquantity', 'units', ARRAY['commercial', 'market']::text[], 0.9, 'expected_revenue ÷ average_selling_price', '[{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue for this opportunity."},{"name":"average_selling_price","metricKey":"AverageSellingPrice","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"required":true,"expectUnit":"currency","preference":"ASSUMPTION_ONLY","horizon":"current","allowCrossPeriod":false,"description":"Management assumption for realised price per unit of the product sold."}]'::jsonb, true, '{}'::jsonb),
  ('calc_inventory_requirement@1.0.0', NULL, 'inventory_requirement', '1.0.0', 'Inventory Requirement', 'Units of stock needed to serve expected demand.', 'MODEL v1: the requirement equals total demand exactly. There is no safety stock, no service-level buffer and no lead-time cover, because none of those policies is modelled yet. The arithmetic is trivial and honest; the confidence reflects that the MODEL is crude, not that the number is uncertain. Demand from EVERY opportunity selling the product is summed, which is what makes the pressure on a shared stock position a number rather than an observation about the graph.', 'Country GM Vietnam', 'ACTIVE', '2026-10-01', 'vm_inventoryrequirement', 'units', ARRAY['operations', 'commercial', 'resource']::text[], 0.8, 'Σ demand_quantity  (v1: no safety stock policy)', '[{"name":"demand_quantity","metricKey":"DemandQuantity","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"in","aggregate":true},"required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Expected unit demand from the opportunities selling this product."}]'::jsonb, true, '{}'::jsonb),
  ('calc_inventory_gap@1.0.0', NULL, 'inventory_gap', '1.0.0', 'Inventory Gap', 'Units of demand that cannot be served from available own stock.', 'The gap measures requirement against stock the business already controls. Distributor-held stock is deliberately excluded: reallocating it is a commercial decision with its own consequences, not automatic availability. Floored at zero, because surplus stock is a working-capital question, not a negative gap.', 'Country GM Vietnam', 'ACTIVE', '2026-10-01', 'vm_inventorygap', 'units', ARRAY['operations', 'commercial', 'resource']::text[], 0.9, 'max(inventory_requirement − available_inventory, 0)', '[{"name":"inventory_requirement","metricKey":"InventoryRequirement","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Units needed to serve expected demand for this product."},{"name":"available_inventory","metricKey":"AvailableInventory","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"POSITIONS","direction":"in","subjectFilter":{"attribute":"ownership","equals":"own"},"aggregate":true},"required":true,"expectUnit":"units","preference":"ACTUALS_FIRST","horizon":"current","allowCrossPeriod":false,"description":"Units on hand at positions the business owns outright."}]'::jsonb, true, '{}'::jsonb),
  ('calc_working_capital@1.0.0', NULL, 'working_capital', '1.0.0', 'Working Capital Requirement', 'Capital tied up by holding the required inventory.', 'Inventory is capital before it is service. Valuing the requirement at unit cost shows what serving this demand ties up, which is the number that competes with every other use of cash. v1 values at cost and ignores payment terms. This is working capital for ONE product; the entity-level position a finance team reports is an aggregate across products that v1 deliberately does not attempt, which is why the calculation refuses to run on a finance subject rather than producing a number that looks like a balance-sheet figure and is not one.', 'Finance Director Vietnam', 'ACTIVE', '2026-10-01', 'vm_workingcapital', 'currency', ARRAY['operations', 'commercial', 'resource']::text[], 0.85, 'inventory_requirement × unit_cost', '[{"name":"inventory_requirement","metricKey":"InventoryRequirement","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Units of stock the business needs to hold."},{"name":"unit_cost","metricKey":"UnitCost","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Landed cost of one unit of the product."}]'::jsonb, true, '{}'::jsonb),
  ('calc_cogs@1.0.0', NULL, 'cogs', '1.0.0', 'Cost of Goods Sold', 'Product cost of the units expected to be sold.', 'Separated from working capital on purpose: the same unit cost drives both, but COGS follows what is sold while working capital follows what is held. Keeping them as distinct calculations means a change in stock policy moves one and not the other.', 'Finance Director Vietnam', 'ACTIVE', '2026-10-01', 'vm_cogs', 'currency', ARRAY['commercial', 'market']::text[], 0.95, 'demand_quantity × unit_cost', '[{"name":"demand_quantity","metricKey":"DemandQuantity","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Expected units sold under this opportunity."},{"name":"unit_cost","metricKey":"UnitCost","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Landed cost of one unit of the product being sold."}]'::jsonb, true, '{}'::jsonb),
  ('calc_gross_margin@1.0.0', NULL, 'gross_margin', '1.0.0', 'Gross Margin', 'Expected revenue less product cost and incremental fulfilment cost.', 'Margin is what survives after the cost of the goods and the cost of getting them there. Fulfilment cost is optional because most opportunities carry none; when expediting is on the table it becomes the visible price of protecting the deal. Deal-level only: an enterprise margin is a consolidation, not this formula summed.', 'Finance Director Vietnam', 'ACTIVE', '2026-10-01', 'vm_grossmargin', 'currency', ARRAY['commercial', 'market']::text[], 0.9, 'expected_revenue − cogs − fulfilment_cost', '[{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue for this opportunity."},{"name":"cogs","metricKey":"Cogs","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Product cost of the units expected to be sold."},{"name":"fulfilment_cost","metricKey":"Opex","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"INCURS","direction":"out"},"required":false,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Incremental operating cost of fulfilling this opportunity, if any."}]'::jsonb, true, '{}'::jsonb),
  ('calc_gross_margin_pct@1.0.0', NULL, 'gross_margin_pct', '1.0.0', 'Gross Margin %', 'Gross margin as a percentage of expected revenue.', 'The percentage is what management steers by and what objectives are written against. Derived from the currency figures rather than stated separately, so the two can never disagree.', 'Finance Director Vietnam', 'ACTIVE', '2026-10-01', 'vm_grossmarginpct', 'percentage', ARRAY['commercial', 'market']::text[], 1, 'gross_margin ÷ expected_revenue × 100', '[{"name":"gross_margin","metricKey":"GrossMargin","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Gross margin in currency for this subject."},{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue the margin is measured against."}]'::jsonb, true, '{}'::jsonb),
  ('calc_cash_impact@1.0.0', NULL, 'cash_impact', '1.0.0', 'Cash Impact', 'Net cash effect of serving this demand over the horizon.', 'MODEL v1, deliberately simple: margin earned less capital tied up. It ignores payment terms, collection timing and tax. It is stated as a v1 cash model rather than dressed up as a cash-flow statement, because a model that looks more sophisticated than it is would be trusted more than it deserves.', 'Finance Director Vietnam', 'ACTIVE', '2026-10-01', 'vm_cashimpact', 'currency', ARRAY['commercial', 'market']::text[], 0.7, 'gross_margin − working_capital  (v1: ignores payment terms and timing)', '[{"name":"gross_margin","metricKey":"GrossMargin","binding":{"kind":"SAME_SUBJECT"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Gross margin expected from this opportunity."},{"name":"working_capital","metricKey":"WorkingCapital","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Capital tied up holding the inventory this demand requires."}]'::jsonb, true, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
