-- ============================================================================
-- HELM Phase 2 — Enterprise Value Graph
--
-- STRICTLY ADDITIVE. Only helm_*-prefixed objects. No Memoire table, policy,
-- index, trigger or function is altered or dropped. Re-running is a no-op.
--
-- The ontology (Phase 1) holds nouns; this holds quantities. Value nodes
-- REFERENCE helm_entities by foreign key and never duplicate them (ADR-0007,
-- ADR-0015).
--
-- Why these are separate tables rather than more helm_entities rows: an entity
-- has one current state with a superseding version chain, while a value node
-- has MANY CONCURRENT observations -- an actual, a forecast, a target and
-- several scenario values, all true at once, none superseding another. That is
-- a different model of truth, not a different table layout.
--
-- Phase 2 represents value. It does not move it: there is no formula column,
-- no calculation engine, and nothing recomputes when an input changes. That is
-- Phase 3, and verify:value-graph asserts the absence.
--
-- GENERATED FILE -- produced by scripts/generate-value-graph-migration.mjs from
-- packages/value-graph/src/seed.ts. Do not hand-edit the seed section.
-- ============================================================================

-- --------------------------------------------------- provenance subject kinds
-- Widening a CHECK on a HELM-owned, empty table so the value graph can reuse
-- the Phase 1 provenance mechanism instead of inventing a second source model.

ALTER TABLE public.helm_provenance DROP CONSTRAINT IF EXISTS helm_provenance_subject_kind_check;
ALTER TABLE public.helm_provenance ADD CONSTRAINT helm_provenance_subject_kind_check
  CHECK (subject_kind IN
    ('entity', 'relationship', 'entity_version',
     'value_node', 'value_link', 'value_observation'));

-- ------------------------------------------------------- metric definitions

CREATE TABLE IF NOT EXISTS public.helm_value_metrics (
  -- Readable deterministic id ('vm_grossmarginpct'), matching the Phase 1
  -- registry convention so fixtures and adapters agree without coordinating.
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 160),
  -- NULL = shipped by HELM. Organizations add their own without a migration.
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Za-z0-9]*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) >= 20),

  -- Enterprise value is multi-dimensional. These dimensions reinforce,
  -- compete with and constrain one another; HELM must never collapse them.
  dimension text NOT NULL CHECK (dimension IN
    ('FINANCIAL', 'COMMERCIAL', 'CUSTOMER', 'OPERATIONAL', 'CAPITAL',
     'RISK', 'STRATEGIC', 'RESOURCE', 'RESILIENCE')),

  -- A number without its unit is not a fact. 'percentage' is 0..100 and
  -- 'ratio' is 0..1 -- deliberately distinct so the two cannot be confused.
  unit_type text NOT NULL CHECK (unit_type IN
    ('currency', 'percentage', 'ratio', 'units', 'count',
     'days', 'hours', 'capacity', 'score', 'index')),
  default_currency text CHECK (default_currency IS NULL OR char_length(default_currency) = 3),
  data_type text NOT NULL DEFAULT 'numeric'
    CHECK (data_type IN ('numeric', 'ordinal', 'categorical')),

  -- Revenue sums; gross margin percentage does not. Encoded so a future
  -- aggregation engine cannot silently do the wrong thing.
  aggregation text NOT NULL CHECK (aggregation IN
    ('SUM', 'AVERAGE', 'WEIGHTED_AVERAGE', 'MIN', 'MAX', 'LAST',
     'NON_AGGREGATABLE', 'CUSTOM')),
  directionality text NOT NULL CHECK (directionality IN
    ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'TARGET_RANGE', 'NEUTRAL',
     'CONTEXT_DEPENDENT')),
  time_behavior text NOT NULL CHECK (time_behavior IN
    ('POINT_IN_TIME', 'PERIOD', 'CUMULATIVE', 'RATE')),

  -- Which entity-type categories this metric may attach to. NULL = any.
  scope_categories text[],
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated')),
  is_system boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A proportion cannot be summed: adding two percentages is meaningless.
  CONSTRAINT helm_value_metrics_summable CHECK (
    aggregation <> 'SUM' OR unit_type NOT IN ('percentage', 'ratio', 'score')
  ),
  -- A currency default only makes sense on a currency metric.
  CONSTRAINT helm_value_metrics_currency_coherent CHECK (
    default_currency IS NULL OR unit_type = 'currency'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS helm_value_metrics_system_key_idx
  ON public.helm_value_metrics (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS helm_value_metrics_org_key_idx
  ON public.helm_value_metrics (org_id, key) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS helm_value_metrics_dimension_idx
  ON public.helm_value_metrics (dimension) WHERE status = 'active';

-- ---------------------------------------------------------------- value nodes

-- One metric, about one subject, at one horizon. A single ontology entity
-- participates in many value nodes -- SKU-X has a revenue contribution, a gross
-- margin, an inventory exposure, a working-capital draw and a supply risk.
CREATE TABLE IF NOT EXISTS public.helm_value_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  metric_id text NOT NULL REFERENCES public.helm_value_metrics(id) ON DELETE RESTRICT,
  -- The ontology entity this is about. Referenced, never duplicated.
  subject_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  -- Used when the node is scoped rather than entity-bound.
  scope_kind text CHECK (scope_kind IS NULL OR scope_kind IN
    ('enterprise', 'region', 'country', 'business_unit', 'function', 'customer',
     'portfolio', 'product', 'opportunity', 'supplier', 'resource')),
  scope_ref text,
  time_horizon text CHECK (time_horizon IS NULL OR time_horizon IN
    ('current', 'month', 'quarter', 'year', 'lifetime')),
  label text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A value node must be about something.
  CONSTRAINT helm_value_nodes_has_subject CHECK (
    subject_entity_id IS NOT NULL OR scope_kind IS NOT NULL
  )
);

-- Node identity, with NULLs folded so duplicates cannot slip through.
CREATE UNIQUE INDEX IF NOT EXISTS helm_value_nodes_identity_idx
  ON public.helm_value_nodes (
    org_id,
    metric_id,
    COALESCE(subject_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_kind, ''),
    COALESCE(scope_ref, ''),
    COALESCE(time_horizon, '')
  );
CREATE INDEX IF NOT EXISTS helm_value_nodes_entity_idx
  ON public.helm_value_nodes (org_id, subject_entity_id);
CREATE INDEX IF NOT EXISTS helm_value_nodes_metric_idx
  ON public.helm_value_nodes (org_id, metric_id);

-- ---------------------------------------------------------------- value links

-- How one quantity depends on another. NOTE: no CAUSES. A value link is a
-- management/value dependency, not a validated causal claim -- the Causal
-- Graph is Phase 8, and keeping the vocabularies apart preserves the
-- distinction between correlation and causal hypothesis.
CREATE TABLE IF NOT EXISTS public.helm_value_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  link_type text NOT NULL CHECK (link_type IN
    ('DRIVES', 'CONTRIBUTES_TO', 'CONSUMES', 'ENABLES', 'CONSTRAINS', 'REDUCES',
     'INCREASES', 'EXPOSES', 'PROTECTS', 'DEPENDS_ON', 'ALLOCATES_TO',
     'TRANSFERS_TO')),
  source_node_id uuid NOT NULL REFERENCES public.helm_value_nodes(id) ON DELETE CASCADE,
  target_node_id uuid NOT NULL REFERENCES public.helm_value_nodes(id) ON DELETE CASCADE,
  weight numeric,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  lag_days integer,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  observed_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_system text NOT NULL CHECK (source_system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (source_node_id <> target_node_id)
);

CREATE INDEX IF NOT EXISTS helm_value_links_out_idx
  ON public.helm_value_links (org_id, source_node_id, link_type) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS helm_value_links_in_idx
  ON public.helm_value_links (org_id, target_node_id, link_type) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS helm_value_links_out_all_idx
  ON public.helm_value_links (org_id, source_node_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS helm_value_links_in_all_idx
  ON public.helm_value_links (org_id, target_node_id, valid_from, valid_to);

-- --------------------------------------------------------- value observations

-- The values themselves. MANY coexist per node and none supersedes another:
-- the 38% actual, the 35% forecast, the 40% target and the 34% scenario are
-- four different kinds of fact about the same quantity. Collapsing them would
-- destroy the basis for scenario comparison, forecast accuracy and learning.
CREATE TABLE IF NOT EXISTS public.helm_value_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES public.helm_value_nodes(id) ON DELETE CASCADE,
  observation_type text NOT NULL CHECK (observation_type IN
    ('ACTUAL', 'FORECAST', 'TARGET', 'SCENARIO', 'ESTIMATE', 'DERIVED', 'ASSUMPTION')),

  numeric_value numeric,
  text_value text,
  unit_type text NOT NULL CHECK (unit_type IN
    ('currency', 'percentage', 'ratio', 'units', 'count',
     'days', 'hours', 'capacity', 'score', 'index')),
  currency text CHECK (currency IS NULL OR char_length(currency) = 3),

  -- POINT_IN_TIME metrics anchor at effective_at; PERIOD metrics use the range.
  effective_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,

  -- Valid time (when the source asserted it) vs record time (when HELM learned
  -- it) -- the same distinction Phase 1 established, ADR-0014.
  observed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  -- A scenario value belongs to a scenario; reality must stay separable.
  scenario_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  assumption_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE SET NULL,

  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_system text NOT NULL CHECK (source_system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  -- Lineage hook: Phase 3 attaches calculation traces through provenance.
  provenance_id uuid REFERENCES public.helm_provenance(id) ON DELETE SET NULL,
  -- Reserved for Phase 3. Always NULL in Phase 2.
  calculation_run_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_value_obs_has_value CHECK (
    numeric_value IS NOT NULL OR text_value IS NOT NULL
  ),
  -- A scenario number without a scenario is meaningless; a scenario reference
  -- on an actual makes reality and a model indistinguishable.
  CONSTRAINT helm_value_obs_scenario_context CHECK (
    (observation_type = 'SCENARIO' AND scenario_entity_id IS NOT NULL)
    OR (observation_type <> 'SCENARIO' AND scenario_entity_id IS NULL)
  ),
  CONSTRAINT helm_value_obs_period_order CHECK (
    period_start IS NULL OR period_end IS NULL OR period_end > period_start
  ),
  CONSTRAINT helm_value_obs_has_time CHECK (
    effective_at IS NOT NULL OR (period_start IS NOT NULL AND period_end IS NOT NULL)
  ),
  -- Currency exactly when the unit needs one.
  CONSTRAINT helm_value_obs_currency_coherent CHECK (
    (unit_type = 'currency' AND currency IS NOT NULL)
    OR (unit_type <> 'currency' AND currency IS NULL)
  ),
  -- Phase 2 writes no calculation runs.
  CONSTRAINT helm_value_obs_no_calculation CHECK (calculation_run_id IS NULL)
);

CREATE INDEX IF NOT EXISTS helm_value_obs_node_idx
  ON public.helm_value_observations (org_id, node_id, observation_type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS helm_value_obs_scenario_idx
  ON public.helm_value_observations (org_id, scenario_entity_id)
  WHERE scenario_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS helm_value_obs_reality_idx
  ON public.helm_value_observations (org_id, node_id, observation_type)
  WHERE scenario_entity_id IS NULL;

-- ------------------------------------------- unit integrity (defence in depth)

-- RLS and column CHECKs cannot compare an observation against its metric's
-- declared unit, so a trigger does. Without it, "a percentage metric may not
-- receive a currency unit" would hold only in TypeScript.
CREATE OR REPLACE FUNCTION public.helm_value_observation_units()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  m public.helm_value_metrics;
  n public.helm_value_nodes;
BEGIN
  SELECT * INTO n FROM public.helm_value_nodes WHERE id = NEW.node_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'value node % does not exist', NEW.node_id;
  END IF;
  IF n.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'observation org % does not match value node org %', NEW.org_id, n.org_id;
  END IF;

  SELECT * INTO m FROM public.helm_value_metrics WHERE id = n.metric_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'value metric % does not exist', n.metric_id;
  END IF;

  IF NEW.unit_type <> m.unit_type THEN
    RAISE EXCEPTION
      'metric % is measured in %, but the observation supplied % -- a number without its correct unit is not a fact',
      m.key, m.unit_type, NEW.unit_type;
  END IF;

  -- Bounds that keep 0.7 and 70%% from being confused.
  IF NEW.numeric_value IS NOT NULL THEN
    IF m.unit_type = 'ratio' AND (NEW.numeric_value < 0 OR NEW.numeric_value > 1) THEN
      RAISE EXCEPTION 'metric % is a ratio (0..1); got % -- did you mean a percentage?',
        m.key, NEW.numeric_value;
    END IF;
    IF m.unit_type IN ('percentage', 'score')
       AND (NEW.numeric_value < 0 OR NEW.numeric_value > 100) THEN
      RAISE EXCEPTION 'metric % is a % (0..100); got %', m.key, m.unit_type, NEW.numeric_value;
    END IF;
    IF m.unit_type IN ('count', 'capacity', 'index') AND NEW.numeric_value < 0 THEN
      RAISE EXCEPTION 'metric % cannot be negative; got %', m.key, NEW.numeric_value;
    END IF;
  END IF;

  -- The temporal context the metric implies.
  IF m.time_behavior = 'POINT_IN_TIME' AND NEW.effective_at IS NULL THEN
    RAISE EXCEPTION 'metric % is point-in-time and needs effective_at', m.key;
  END IF;
  IF m.time_behavior IN ('PERIOD', 'CUMULATIVE')
     AND (NEW.period_start IS NULL OR NEW.period_end IS NULL) THEN
    RAISE EXCEPTION 'metric % is a % metric and needs period_start and period_end',
      m.key, m.time_behavior;
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.helm_value_observation_units() FROM anon, public;

DROP TRIGGER IF EXISTS helm_value_observation_units_trg ON public.helm_value_observations;
CREATE TRIGGER helm_value_observation_units_trg
  BEFORE INSERT OR UPDATE ON public.helm_value_observations
  FOR EACH ROW EXECUTE FUNCTION public.helm_value_observation_units();

-- Value nodes and links must not reference another organization's rows.
CREATE OR REPLACE FUNCTION public.helm_value_org_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  other_org uuid;
BEGIN
  IF TG_TABLE_NAME = 'helm_value_nodes' THEN
    IF NEW.subject_entity_id IS NOT NULL THEN
      SELECT org_id INTO other_org FROM public.helm_entities WHERE id = NEW.subject_entity_id;
      IF other_org IS DISTINCT FROM NEW.org_id THEN
        RAISE EXCEPTION 'value node org % cannot reference entity in org %', NEW.org_id, other_org;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'helm_value_links' THEN
    SELECT org_id INTO other_org FROM public.helm_value_nodes WHERE id = NEW.source_node_id;
    IF other_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'value link org % cannot reference source node in org %', NEW.org_id, other_org;
    END IF;
    SELECT org_id INTO other_org FROM public.helm_value_nodes WHERE id = NEW.target_node_id;
    IF other_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'value link org % cannot reference target node in org %', NEW.org_id, other_org;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.helm_value_org_integrity() FROM anon, public;

DROP TRIGGER IF EXISTS helm_value_nodes_org_trg ON public.helm_value_nodes;
CREATE TRIGGER helm_value_nodes_org_trg
  BEFORE INSERT OR UPDATE ON public.helm_value_nodes
  FOR EACH ROW EXECUTE FUNCTION public.helm_value_org_integrity();

DROP TRIGGER IF EXISTS helm_value_links_org_trg ON public.helm_value_links;
CREATE TRIGGER helm_value_links_org_trg
  BEFORE INSERT OR UPDATE ON public.helm_value_links
  FOR EACH ROW EXECUTE FUNCTION public.helm_value_org_integrity();

-- --------------------------------------------------------- updated_at triggers

DROP TRIGGER IF EXISTS helm_value_metrics_updated_at ON public.helm_value_metrics;
CREATE TRIGGER helm_value_metrics_updated_at BEFORE UPDATE ON public.helm_value_metrics
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

DROP TRIGGER IF EXISTS helm_value_nodes_updated_at ON public.helm_value_nodes;
CREATE TRIGGER helm_value_nodes_updated_at BEFORE UPDATE ON public.helm_value_nodes
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

DROP TRIGGER IF EXISTS helm_value_links_updated_at ON public.helm_value_links;
CREATE TRIGGER helm_value_links_updated_at BEFORE UPDATE ON public.helm_value_links
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

-- ------------------------------------------------------------------------ RLS

ALTER TABLE public.helm_value_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_value_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_value_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_value_observations ENABLE ROW LEVEL SECURITY;

-- Shipped metrics are readable by any authenticated user; tenant extensions
-- only by that org. Metric governance is an admin act.
DROP POLICY IF EXISTS helm_value_metrics_read ON public.helm_value_metrics;
CREATE POLICY helm_value_metrics_read ON public.helm_value_metrics
  FOR SELECT TO authenticated
  USING (org_id IS NULL OR public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_value_metrics_insert ON public.helm_value_metrics;
CREATE POLICY helm_value_metrics_insert ON public.helm_value_metrics
  FOR INSERT TO authenticated
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_value_metrics_update ON public.helm_value_metrics;
CREATE POLICY helm_value_metrics_update ON public.helm_value_metrics
  FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'))
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_value_metrics_delete ON public.helm_value_metrics;
CREATE POLICY helm_value_metrics_delete ON public.helm_value_metrics
  FOR DELETE TO authenticated
  USING (org_id IS NOT NULL AND is_system = false AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_value_nodes_read ON public.helm_value_nodes;
CREATE POLICY helm_value_nodes_read ON public.helm_value_nodes
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_value_nodes_insert ON public.helm_value_nodes;
CREATE POLICY helm_value_nodes_insert ON public.helm_value_nodes
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_value_nodes_update ON public.helm_value_nodes;
CREATE POLICY helm_value_nodes_update ON public.helm_value_nodes
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_value_nodes_delete ON public.helm_value_nodes;
CREATE POLICY helm_value_nodes_delete ON public.helm_value_nodes
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager'));

DROP POLICY IF EXISTS helm_value_links_read ON public.helm_value_links;
CREATE POLICY helm_value_links_read ON public.helm_value_links
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_value_links_insert ON public.helm_value_links;
CREATE POLICY helm_value_links_insert ON public.helm_value_links
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_value_links_update ON public.helm_value_links;
CREATE POLICY helm_value_links_update ON public.helm_value_links
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_value_links_delete ON public.helm_value_links;
CREATE POLICY helm_value_links_delete ON public.helm_value_links
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager'));

-- Observations are append-only: a recorded claim about what was, what we
-- expected or what we wanted must not be quietly rewritten later. No UPDATE
-- and no DELETE policy -- the same guarantee as helm_decision_events.
DROP POLICY IF EXISTS helm_value_observations_read ON public.helm_value_observations;
CREATE POLICY helm_value_observations_read ON public.helm_value_observations
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_value_observations_insert ON public.helm_value_observations;
CREATE POLICY helm_value_observations_insert ON public.helm_value_observations
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

-- --------------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_value_metrics TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_value_nodes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_value_links TO authenticated;
GRANT SELECT, INSERT ON public.helm_value_observations TO authenticated;

-- ============================================================================
-- SEED: shipped value metrics (org_id IS NULL, is_system = true)
--
-- Generated from packages/value-graph/src/seed.ts. Idempotent.
-- ============================================================================

INSERT INTO public.helm_value_metrics
  (id, org_id, key, name, description, dimension, unit_type, default_currency,
   data_type, aggregation, directionality, time_behavior, scope_categories,
   version, status, is_system, metadata)
VALUES
  ('vm_opportunityvalue', NULL, 'OpportunityValue', 'Opportunity Value', 'The full value of an identified revenue event, before any probability weighting.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_opportunityprobability', NULL, 'OpportunityProbability', 'Opportunity Probability', 'Likelihood the opportunity closes, as a proportion. Weighted by value when rolled up, never summed.', 'COMMERCIAL', 'ratio', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"weightBy":"OpportunityValue"}'::jsonb),
  ('vm_expectedrevenue', NULL, 'ExpectedRevenue', 'Expected Revenue', 'Probability-weighted revenue from an opportunity or pipeline over a period.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_revenue', NULL, 'Revenue', 'Revenue', 'Recognised revenue for a cost object over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_pipelinecoverage', NULL, 'PipelineCoverage', 'Pipeline Coverage', 'Weighted pipeline divided by the target for the period. A coverage ratio, not a sum.', 'COMMERCIAL', 'ratio', NULL, 'numeric', 'NON_AGGREGATABLE', 'TARGET_RANGE', 'PERIOD', NULL, 1, 'active', true, '{"typicalTargetRange":[3,5]}'::jsonb),
  ('vm_customervalue', NULL, 'CustomerValue', 'Customer Value', 'Cumulative economic value attributable to a customer relationship.', 'CUSTOMER', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'CUMULATIVE', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_demandquantity', NULL, 'DemandQuantity', 'Demand Quantity', 'Units of a product demanded over a period by a commercial event.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'NEUTRAL', 'PERIOD', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_availableinventory', NULL, 'AvailableInventory', 'Available Inventory', 'Units on hand plus inbound within the horizon, at a specific position. More is not automatically better — it is also capital.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_inventoryrequirement', NULL, 'InventoryRequirement', 'Inventory Requirement', 'Units needed to serve committed and expected demand over the horizon.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'NEUTRAL', 'PERIOD', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_inventorygap', NULL, 'InventoryGap', 'Inventory Gap', 'Requirement minus available inventory. Positive means demand cannot be served from stock.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_servicelevel', NULL, 'ServiceLevel', 'Service Level', 'Proportion of demand served on time, expressed 0-100. Weighted by volume when rolled up.', 'CUSTOMER', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_leadtime', NULL, 'LeadTime', 'Lead Time', 'Days between placing a replenishment order and receiving it.', 'OPERATIONAL', 'days', NULL, 'numeric', 'AVERAGE', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_capacityutilization', NULL, 'CapacityUtilization', 'Capacity Utilization', 'Demand as a proportion of available capacity, 0-100. Both too low and too high are problems.', 'RESOURCE', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'TARGET_RANGE', 'PERIOD', NULL, 1, 'active', true, '{"typicalTargetRange":[70,85],"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_unitcost', NULL, 'UnitCost', 'Unit Cost', 'Landed cost of one unit of product.', 'FINANCIAL', 'currency', NULL, 'numeric', 'AVERAGE', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_averagesellingprice', NULL, 'AverageSellingPrice', 'Average Selling Price', 'Realised price per unit after discount. Normally a management assumption rather than a measurement, which is why calculations that use it require an ASSUMPTION observation.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_cogs', NULL, 'Cogs', 'Cost of Goods Sold', 'Product cost of the units expected to be sold over a period. Distinct from inventory value, which follows what is held rather than what is sold.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_grossmargin', NULL, 'GrossMargin', 'Gross Margin', 'Revenue less cost of goods sold, in currency, over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_grossmarginpct', NULL, 'GrossMarginPct', 'Gross Margin %', 'Gross margin as a proportion of revenue, 0-100. A ratio of sums, so it cannot itself be summed.', 'FINANCIAL', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{"weightBy":"Revenue"}'::jsonb),
  ('vm_contributionmargin', NULL, 'ContributionMargin', 'Contribution Margin', 'Revenue less variable cost. What the cost object contributes toward fixed costs.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_workingcapital', NULL, 'WorkingCapital', 'Working Capital', 'Capital tied up in inventory, receivables and payables. Lower frees cash, but too low starves service.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_inventoryvalue', NULL, 'InventoryValue', 'Inventory Value', 'Capital held as stock at a position, at cost.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_cashimpact', NULL, 'CashImpact', 'Cash Impact', 'Net effect on cash over the horizon.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_opex', NULL, 'Opex', 'Operating Expense', 'Operating cost for a cost object over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_ebitda', NULL, 'Ebitda', 'EBITDA', 'Earnings before interest, tax, depreciation and amortization.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_supplyrisk', NULL, 'SupplyRisk', 'Supply Risk', 'Exposure to supply failure at a position or product, 0-100. Rolls up as the worst case, not an average.', 'RISK', 'score', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_customerrisk', NULL, 'CustomerRisk', 'Customer Risk', 'Exposure to losing or being unable to serve a customer, 0-100.', 'RISK', 'score', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_inventoryrisk', NULL, 'InventoryRisk', 'Inventory Risk Exposure', 'Value at risk from expiry, obsolescence or write-down.', 'RISK', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_concentrationrisk', NULL, 'ConcentrationRisk', 'Concentration Risk', 'Share of a dimension dependent on a single supplier, customer or product, 0-100.', 'RISK', 'percentage', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_futureopportunityrisk', NULL, 'FutureOpportunityRisk', 'Future Opportunity Risk', 'Value at risk in other opportunities because a constrained resource is committed here. The cost of foreclosing a future option.', 'RISK', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_strategicalignment', NULL, 'StrategicAlignment', 'Strategic Alignment', 'How well an activity advances stated management objectives, 0-100. Judgemental, not measured.', 'STRATEGIC', 'score', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{"weightBy":"ExpectedRevenue"}'::jsonb),
  ('vm_growthpotential', NULL, 'GrowthPotential', 'Growth Potential', 'Headroom for future value creation in a market, segment or portfolio, 0-100.', 'STRATEGIC', 'score', NULL, 'numeric', 'AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_sourcingresilience', NULL, 'SourcingResilience', 'Sourcing Resilience', 'Ability to keep supplying if the primary source fails, 0-100. Rolls up as the weakest link.', 'RESILIENCE', 'score', NULL, 'numeric', 'MIN', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
