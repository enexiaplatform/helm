-- ============================================================================
-- HELM Foundation
--
-- HELM shares Memoire's database and identity. This migration is strictly
-- ADDITIVE: it creates the shared organization layer (which Memoire's kernel
-- scope was designed to adopt later) and every HELM domain table. It never
-- alters, drops, or rewrites a Memoire table. Re-running is a no-op.
--
-- Isolation model:
--   * The hard tenant wall is the organization. Every HELM table carries
--     org_id, and RLS policies call SECURITY DEFINER helpers so membership
--     lookups never recurse through policies.
--   * Roles are ranked (admin > manager > member > viewer). Policies compare
--     ranks, so adding a role never requires a policy rewrite.
--   * helm_decision_events is append-only: INSERT and SELECT policies exist,
--     UPDATE/DELETE policies deliberately do not. Decision history cannot be
--     silently rewritten, by anyone, from the client.
-- ============================================================================

-- ---------------------------------------------------------------- org layer

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  base_currency text NOT NULL DEFAULT 'USD' CHECK (char_length(base_currency) = 3),
  fiscal_year_start_month integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.organization_memberships (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'manager', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.org_units(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  unit_type text NOT NULL DEFAULT 'team' CHECK (unit_type IN
    ('company', 'business_unit', 'division', 'department', 'region', 'country', 'territory', 'team')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.org_unit_memberships (
  unit_id uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_manager boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, user_id)
);

-- ------------------------------------------------------------- RLS helpers
-- SECURITY DEFINER so policies on org-scoped tables can consult memberships
-- without recursing through the membership table's own policies.

CREATE OR REPLACE FUNCTION public.is_org_member(check_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.org_id = check_org AND m.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.org_role_rank(check_org uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE m.role
      WHEN 'admin' THEN 4
      WHEN 'manager' THEN 3
      WHEN 'member' THEN 2
      WHEN 'viewer' THEN 1
      ELSE 0
    END
    FROM public.organization_memberships m
    WHERE m.org_id = check_org AND m.user_id = auth.uid()
  ), 0);
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(check_org uuid, min_role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.org_role_rank(check_org) >= CASE min_role
    WHEN 'admin' THEN 4
    WHEN 'manager' THEN 3
    WHEN 'member' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 5
  END;
$$;

REVOKE ALL ON FUNCTION public.is_org_member(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.org_role_rank(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.has_org_role(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_role_rank(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(uuid, text) TO authenticated;

-- updated_at maintenance shared by every HELM table.
CREATE OR REPLACE FUNCTION public.helm_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------ org settings

CREATE TABLE IF NOT EXISTS public.helm_org_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  default_service_level numeric NOT NULL DEFAULT 0.95 CHECK (default_service_level > 0 AND default_service_level < 1),
  hurdle_rate numeric CHECK (hurdle_rate IS NULL OR (hurdle_rate >= 0 AND hurdle_rate <= 1)),
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ cost objects

CREATE TABLE IF NOT EXISTS public.helm_cost_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.helm_cost_objects(id) ON DELETE SET NULL,
  org_unit_id uuid REFERENCES public.org_units(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN
    ('company', 'business_unit', 'brand', 'product', 'customer', 'channel', 'territory', 'project')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Reference into Memoire (never a copy): lets economics link back to the
  -- commercial system of record when the account exists there.
  memoire_account_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Period economics per cost object. kind distinguishes actual/budget/forecast
-- so variance analysis needs no second table later.
CREATE TABLE IF NOT EXISTS public.helm_economics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cost_object_id uuid NOT NULL REFERENCES public.helm_cost_objects(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  kind text NOT NULL DEFAULT 'actual' CHECK (kind IN ('actual', 'budget', 'forecast')),
  revenue numeric NOT NULL DEFAULT 0,
  variable_cost numeric NOT NULL DEFAULT 0,
  traceable_fixed_cost numeric NOT NULL DEFAULT 0,
  allocated_fixed_cost numeric NOT NULL DEFAULT 0,
  units numeric,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, cost_object_id, period, kind)
);

-- --------------------------------------------------------------- inventory

CREATE TABLE IF NOT EXISTS public.helm_inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cost_object_id uuid REFERENCES public.helm_cost_objects(id) ON DELETE SET NULL,
  sku text NOT NULL DEFAULT '',
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  unit_cost numeric NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  avg_daily_demand numeric NOT NULL DEFAULT 0,
  demand_stddev numeric NOT NULL DEFAULT 0,
  lead_time_days numeric NOT NULL DEFAULT 0,
  stock_on_hand numeric NOT NULL DEFAULT 0,
  stock_inbound numeric NOT NULL DEFAULT 0,
  expiry_date date,
  shelf_life_days integer,
  service_level numeric CHECK (service_level IS NULL OR (service_level > 0 AND service_level < 1)),
  order_cost numeric,
  holding_cost_rate numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------- processes

CREATE TABLE IF NOT EXISTS public.helm_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  demand_per_week numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.helm_process_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  process_id uuid NOT NULL REFERENCES public.helm_processes(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  owner_label text NOT NULL DEFAULT '',
  processing_minutes numeric NOT NULL DEFAULT 0,
  resources_count numeric NOT NULL DEFAULT 1 CHECK (resources_count > 0),
  available_minutes_per_week numeric NOT NULL DEFAULT 2400,
  wait_minutes numeric NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- signals
-- Signals are computed deterministically by the rule engine and persisted so
-- they have a lifecycle (acknowledge, convert to decision, dismiss). The
-- dedupe_key stops recomputation from duplicating an open signal.

CREATE TABLE IF NOT EXISTS public.helm_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_code text NOT NULL,
  dedupe_key text NOT NULL,
  severity text NOT NULL DEFAULT 'watch' CHECK (severity IN ('info', 'watch', 'warning', 'critical')),
  title text NOT NULL,
  reason text NOT NULL DEFAULT '',
  threshold_label text NOT NULL DEFAULT '',
  measured_label text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  entity_kind text,
  entity_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'converted', 'dismissed')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dedupe_key)
);

-- --------------------------------------------------------------- decisions

CREATE TABLE IF NOT EXISTS public.helm_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  org_unit_id uuid REFERENCES public.org_units(id) ON DELETE SET NULL,
  decision_type text NOT NULL DEFAULT 'custom' CHECK (decision_type IN
    ('pricing', 'special_order', 'make_or_buy', 'keep_or_drop', 'hire_or_outsource',
     'replace_or_retain', 'investment', 'inventory_commitment', 'resource_allocation',
     'market_entry_exit', 'custom')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  context text NOT NULL DEFAULT '',
  problem text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'analyzing', 'pending_approval', 'approved', 'rejected',
     'executing', 'monitoring', 'closed')),
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date date,
  review_after date,
  currency text,
  amount_at_stake numeric,
  recommendation text NOT NULL DEFAULT '',
  decided_alternative_id uuid,
  decision_rationale text NOT NULL DEFAULT '',
  expected_outcome text NOT NULL DEFAULT '',
  expected_metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  actual_outcome text NOT NULL DEFAULT '',
  outcome_score text CHECK (outcome_score IS NULL OR outcome_score IN ('better', 'as_expected', 'worse', 'mixed')),
  lesson text NOT NULL DEFAULT '',
  signal_id uuid REFERENCES public.helm_signals(id) ON DELETE SET NULL,
  -- Reference + snapshot, never a copy: what the manager saw when deciding is
  -- preserved even as the live Memoire record keeps evolving.
  memoire_account_id uuid,
  memoire_opportunity_id uuid,
  context_snapshot jsonb,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejected_reason text NOT NULL DEFAULT '',
  closed_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.helm_signals
  ADD COLUMN IF NOT EXISTS decision_id uuid REFERENCES public.helm_decisions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.helm_decision_alternatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  -- Structured financial lines the relevant-cost engine evaluates:
  -- [{ label, kind: incremental_revenue|relevant_cost|opportunity_cost|
  --    sunk_ignored|allocated_ignored, amount, note }]
  financial_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  qualitative text NOT NULL DEFAULT '',
  strategic text NOT NULL DEFAULT '',
  risks text NOT NULL DEFAULT '',
  is_recommended boolean NOT NULL DEFAULT false,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'helm_decisions_decided_alternative_fk'
  ) THEN
    ALTER TABLE public.helm_decisions
      ADD CONSTRAINT helm_decisions_decided_alternative_fk
      FOREIGN KEY (decided_alternative_id)
      REFERENCES public.helm_decision_alternatives(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.helm_decision_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE CASCADE,
  statement text NOT NULL,
  basis text NOT NULL DEFAULT '',
  sensitivity text NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('low', 'medium', 'high')),
  -- Reviewed when the decision closes: did the assumption hold?
  validated text NOT NULL DEFAULT 'pending' CHECK (validated IN ('pending', 'held', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail. No UPDATE or DELETE policy exists on purpose.
CREATE TABLE IF NOT EXISTS public.helm_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.helm_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  owner_label text NOT NULL DEFAULT '',
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  -- Record of what was pushed back into Memoire (event id, plan item id).
  writeback jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------- scenarios

CREATE TABLE IF NOT EXISTS public.helm_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid REFERENCES public.helm_decisions(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- approval rules

CREATE TABLE IF NOT EXISTS public.helm_approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_type text CHECK (decision_type IS NULL OR decision_type IN
    ('pricing', 'special_order', 'make_or_buy', 'keep_or_drop', 'hire_or_outsource',
     'replace_or_retain', 'investment', 'inventory_commitment', 'resource_allocation',
     'market_entry_exit', 'custom')),
  threshold_amount numeric NOT NULL DEFAULT 0,
  required_role text NOT NULL DEFAULT 'manager' CHECK (required_role IN ('manager', 'admin')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- indexes

CREATE INDEX IF NOT EXISTS org_memberships_user_idx ON public.organization_memberships (user_id);
CREATE INDEX IF NOT EXISTS org_units_org_idx ON public.org_units (org_id);
CREATE INDEX IF NOT EXISTS org_unit_memberships_org_user_idx ON public.org_unit_memberships (org_id, user_id);
CREATE INDEX IF NOT EXISTS helm_cost_objects_org_idx ON public.helm_cost_objects (org_id, kind);
CREATE INDEX IF NOT EXISTS helm_economics_org_period_idx ON public.helm_economics (org_id, period, kind);
CREATE INDEX IF NOT EXISTS helm_economics_object_idx ON public.helm_economics (cost_object_id, period);
CREATE INDEX IF NOT EXISTS helm_inventory_org_idx ON public.helm_inventory_items (org_id);
CREATE INDEX IF NOT EXISTS helm_process_activities_process_idx ON public.helm_process_activities (process_id, sort);
CREATE INDEX IF NOT EXISTS helm_signals_org_status_idx ON public.helm_signals (org_id, status, severity);
CREATE INDEX IF NOT EXISTS helm_decisions_org_status_idx ON public.helm_decisions (org_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS helm_decision_alternatives_decision_idx ON public.helm_decision_alternatives (decision_id, sort);
CREATE INDEX IF NOT EXISTS helm_decision_assumptions_decision_idx ON public.helm_decision_assumptions (decision_id);
CREATE INDEX IF NOT EXISTS helm_decision_events_decision_idx ON public.helm_decision_events (decision_id, created_at);
CREATE INDEX IF NOT EXISTS helm_actions_org_status_idx ON public.helm_actions (org_id, status, due_date);
CREATE INDEX IF NOT EXISTS helm_scenarios_org_idx ON public.helm_scenarios (org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS helm_approval_rules_org_idx ON public.helm_approval_rules (org_id) WHERE active;

-- ------------------------------------------------------- updated_at triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'org_units', 'helm_org_settings', 'helm_cost_objects',
    'helm_economics', 'helm_inventory_items', 'helm_processes',
    'helm_process_activities', 'helm_signals', 'helm_decisions',
    'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions',
    'helm_scenarios', 'helm_approval_rules'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS set_updated_at ON public.%I;
       CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();', t, t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------- RLS

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_unit_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_cost_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_economics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_process_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_approval_rules ENABLE ROW LEVEL SECURITY;

-- Organizations: members read; admins update; creation goes through the
-- create_organization() RPC so the org + admin membership are atomic.
CREATE POLICY "Members read their organizations" ON public.organizations
  FOR SELECT TO authenticated USING (public.is_org_member(id));
CREATE POLICY "Admins update their organizations" ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.has_org_role(id, 'admin'))
  WITH CHECK (public.has_org_role(id, 'admin'));

CREATE POLICY "Members read memberships" ON public.organization_memberships
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Admins manage memberships" ON public.organization_memberships
  FOR ALL TO authenticated
  USING (public.has_org_role(org_id, 'admin'))
  WITH CHECK (public.has_org_role(org_id, 'admin'));

CREATE POLICY "Members read org units" ON public.org_units
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Admins manage org units" ON public.org_units
  FOR ALL TO authenticated
  USING (public.has_org_role(org_id, 'admin'))
  WITH CHECK (public.has_org_role(org_id, 'admin'));

CREATE POLICY "Members read unit memberships" ON public.org_unit_memberships
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Admins manage unit memberships" ON public.org_unit_memberships
  FOR ALL TO authenticated
  USING (public.has_org_role(org_id, 'admin'))
  WITH CHECK (public.has_org_role(org_id, 'admin'));

-- Settings and approval rules: read by members, written by admins (settings)
-- and managers+ (approval rules).
CREATE POLICY "Members read org settings" ON public.helm_org_settings
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Admins manage org settings" ON public.helm_org_settings
  FOR ALL TO authenticated
  USING (public.has_org_role(org_id, 'admin'))
  WITH CHECK (public.has_org_role(org_id, 'admin'));

CREATE POLICY "Members read approval rules" ON public.helm_approval_rules
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Managers manage approval rules" ON public.helm_approval_rules
  FOR ALL TO authenticated
  USING (public.has_org_role(org_id, 'manager'))
  WITH CHECK (public.has_org_role(org_id, 'manager'));

-- Working tables: members read and write within their org; deletes need
-- manager rank. (Org A never sees Org B: every predicate is org-scoped.)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'helm_cost_objects', 'helm_economics', 'helm_inventory_items',
    'helm_processes', 'helm_process_activities', 'helm_signals',
    'helm_decisions', 'helm_decision_alternatives', 'helm_decision_assumptions',
    'helm_actions', 'helm_scenarios'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "Members read %s" ON public.%I
         FOR SELECT TO authenticated USING (public.is_org_member(org_id));', t, t);
    EXECUTE format(
      'CREATE POLICY "Members insert %s" ON public.%I
         FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, ''member''));', t, t);
    EXECUTE format(
      'CREATE POLICY "Members update %s" ON public.%I
         FOR UPDATE TO authenticated
         USING (public.has_org_role(org_id, ''member''))
         WITH CHECK (public.has_org_role(org_id, ''member''));', t, t);
    EXECUTE format(
      'CREATE POLICY "Managers delete %s" ON public.%I
         FOR DELETE TO authenticated USING (public.has_org_role(org_id, ''manager''));', t, t);
  END LOOP;
END;
$$;

-- Decision events: append-only. INSERT and SELECT only — the absence of
-- UPDATE/DELETE policies is the guarantee that history is never rewritten.
CREATE POLICY "Members read decision events" ON public.helm_decision_events
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "Members append decision events" ON public.helm_decision_events
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND actor_id = auth.uid());

-- ------------------------------------------------------------------ grants

REVOKE ALL ON TABLE
  public.organizations, public.organization_memberships, public.org_units,
  public.org_unit_memberships, public.helm_org_settings, public.helm_cost_objects,
  public.helm_economics, public.helm_inventory_items, public.helm_processes,
  public.helm_process_activities, public.helm_signals, public.helm_decisions,
  public.helm_decision_alternatives, public.helm_decision_assumptions,
  public.helm_decision_events, public.helm_actions, public.helm_scenarios,
  public.helm_approval_rules
FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.organizations, public.organization_memberships, public.org_units,
  public.org_unit_memberships, public.helm_org_settings, public.helm_cost_objects,
  public.helm_economics, public.helm_inventory_items, public.helm_processes,
  public.helm_process_activities, public.helm_signals, public.helm_decisions,
  public.helm_decision_alternatives, public.helm_decision_assumptions,
  public.helm_decision_events, public.helm_actions, public.helm_scenarios,
  public.helm_approval_rules
TO authenticated;

-- -------------------------------------------------------------------- RPCs

-- Atomic org creation: the caller becomes the admin in the same transaction,
-- which sidesteps the chicken-and-egg RLS problem of inserting the first
-- membership into an org you are not yet a member of.
CREATE OR REPLACE FUNCTION public.create_organization(
  p_name text,
  p_currency text DEFAULT 'USD',
  p_fy_start integer DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_name IS NULL OR char_length(trim(p_name)) < 1 OR char_length(p_name) > 200 THEN
    RAISE EXCEPTION 'organization name must be 1-200 characters';
  END IF;
  INSERT INTO public.organizations (name, base_currency, fiscal_year_start_month, created_by)
  VALUES (trim(p_name), upper(coalesce(p_currency, 'USD')), coalesce(p_fy_start, 1), auth.uid())
  RETURNING id INTO new_org;
  INSERT INTO public.organization_memberships (org_id, user_id, role)
  VALUES (new_org, auth.uid(), 'admin');
  INSERT INTO public.helm_org_settings (org_id) VALUES (new_org);
  RETURN new_org;
END;
$$;

-- Admin adds a member by email (the user must already have signed up — the
-- shared user_profiles table is the lookup).
CREATE OR REPLACE FUNCTION public.add_org_member(
  p_org uuid,
  p_email text,
  p_role text DEFAULT 'member'
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target uuid;
BEGIN
  IF NOT public.has_org_role(p_org, 'admin') THEN
    RAISE EXCEPTION 'requires organization admin';
  END IF;
  IF p_role NOT IN ('admin', 'manager', 'member', 'viewer') THEN
    RAISE EXCEPTION 'invalid role %', p_role;
  END IF;
  SELECT id INTO target FROM public.user_profiles WHERE lower(email) = lower(trim(p_email));
  IF target IS NULL THEN
    RAISE EXCEPTION 'no user with that email has signed up yet';
  END IF;
  INSERT INTO public.organization_memberships (org_id, user_id, role)
  VALUES (p_org, target, p_role)
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organization(text, text, integer) FROM anon, public;
REVOKE ALL ON FUNCTION public.add_org_member(uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.create_organization(text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_org_member(uuid, text, text) TO authenticated;
