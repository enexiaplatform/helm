-- ============================================================================
-- HELM Phase 6 — Decision Authority Graph & Governance Runtime
--
-- STRICTLY ADDITIVE. Only helm_* objects are created or altered. No Memoire
-- table, policy, index, trigger, function or embedding is touched. The shared
-- org layer (organizations, org_units, org_unit_memberships) is READ by new
-- SECURITY DEFINER helpers and never altered. Nothing is dropped except HELM
-- policies that are re-created narrower under a new name.
--
-- What this adds (ADR-0022):
--
--   helm_decision_types                   governance classification, registry data
--   helm_authority_policies               DOA document versions — bitemporal, immutable
--   helm_authority_rules                  one immutable line of a policy version
--   helm_role_occupancies                 an authenticated identity in a Role, over time
--   helm_delegations                      time-limited, bounded transfer of authority
--   helm_decision_governance_profiles     a decision's type and declared subjects
--   helm_decision_visibility              DATA VISIBILITY grants to org units
--   helm_authority_evaluations            the immutable judgement of one commitment
--   helm_required_approvals               generated from an evaluation
--   helm_approval_acts                    APPROVE / REJECT / RETURN, write-once
--   helm_approval_rules                   RETIRED (replaced by the two tables above)
--
-- And it closes the Phase 5 gap: every decision table's read policy moves from
-- "any member of the organization" to helm_can_see_decision() — org admin, the
-- decision's creator, or a member of a unit the decision is shared with (or of
-- any unit above it).
--
-- Business logic stays in code. Triggers here enforce INTEGRITY — immutability,
-- tenancy, identity, fingerprint coherence, separation of duties — and never
-- evaluate a threshold, pick a rule or decide anything.
--
-- The commitment is untouched: helm_decision_commitments.authority_status stays
-- pinned to NOT_EVALUATED by its Phase 5 CHECK. The verdict lives here.
-- ============================================================================

-- ------------------------------------------------------------ decision types

CREATE TABLE IF NOT EXISTS public.helm_decision_types (
  key text PRIMARY KEY CHECK (key ~ '^[A-Z][A-Z_]{1,62}$'),
  -- NULL = shipped by HELM and available to every organization.
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.helm_decision_types (key, org_id, name, description) VALUES
  ('INVENTORY_ALLOCATION', NULL, 'Inventory allocation', 'Which demand a constrained stock position serves, and from where it is drawn.'),
  ('PRICING', NULL, 'Pricing', 'A realised price, discount or price structure departing from the list.'),
  ('CUSTOMER_TERMS', NULL, 'Customer terms', 'Delivery, payment or service terms agreed with a named customer.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------ policies and rules

CREATE TABLE IF NOT EXISTS public.helm_authority_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  -- A reference to the document ("DOA-2026-04"), never a copy of it.
  reference text NOT NULL CHECK (char_length(btrim(reference)) >= 1),
  source text NOT NULL CHECK (source IN
    ('BOARD_POLICY', 'DOA_DOCUMENT', 'CORPORATE_POLICY', 'LOCAL_MANAGEMENT_POLICY', 'LEGAL_REQUIREMENT')),
  demo boolean NOT NULL DEFAULT false,
  -- Why this authority exists.
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  -- Valid time: when the version is in force. Record time: when HELM learned it.
  valid_from timestamptz NOT NULL,
  valid_to timestamptz CHECK (valid_to IS NULL OR valid_to > valid_from),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  supersedes_policy_id uuid REFERENCES public.helm_authority_policies(id) ON DELETE RESTRICT,
  -- A changed policy is a new version, never an edit.
  CONSTRAINT helm_authority_policies_version_once UNIQUE (org_id, key, version)
);

CREATE TABLE IF NOT EXISTS public.helm_authority_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES public.helm_authority_policies(id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  -- Authority attaches to a ROLE entity; a person holder is a flagged exception.
  holder_kind text NOT NULL CHECK (holder_kind IN ('ROLE', 'PERSON')),
  holder_role_id uuid REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  holder_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  holder_label text NOT NULL CHECK (char_length(btrim(holder_label)) >= 1),
  effect text NOT NULL CHECK (effect IN ('GRANT', 'RESTRICT', 'REQUIRE_APPROVAL')),
  decision_types text[] NOT NULL CHECK (cardinality(decision_types) >= 1),
  acts text[] NOT NULL CHECK (
    cardinality(acts) >= 1
    AND acts <@ ARRAY['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE', 'OVERRIDE_POLICY']::text[]
  ),
  -- [{dimension, entities:[{entityId,label}]}] — part of an immutable rule version.
  scope jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scope) = 'array'),
  -- [{metricKey, label, comparator, threshold, unit, currency}] — lines on COMPUTED
  -- consequences. There is no column here for an amount anyone typed.
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'),
  escalation_role_id uuid REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  escalation_role_label text,
  approval_independence text NOT NULL DEFAULT 'INDEPENDENT_OF_COMMITTER'
    CHECK (approval_independence IN ('INDEPENDENT_OF_COMMITTER', 'NONE')),
  approval_sequence integer NOT NULL DEFAULT 1 CHECK (approval_sequence >= 1),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 8),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT helm_authority_rules_key_once UNIQUE (policy_id, key),
  CONSTRAINT helm_authority_rules_holder_coherent CHECK (
    (holder_kind = 'ROLE' AND holder_role_id IS NOT NULL AND holder_user_id IS NULL)
    OR (holder_kind = 'PERSON' AND holder_user_id IS NOT NULL AND holder_role_id IS NULL)
  ),
  -- An exception or a matrix requirement names a role, not a person.
  CONSTRAINT helm_authority_rules_role_effects CHECK (effect = 'GRANT' OR holder_kind = 'ROLE'),
  -- An exception must say whose authority the restricted commitment goes to.
  CONSTRAINT helm_authority_rules_restriction_routed CHECK (effect <> 'RESTRICT' OR escalation_role_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS helm_authority_rules_policy_idx ON public.helm_authority_rules (policy_id);
CREATE INDEX IF NOT EXISTS helm_authority_policies_org_idx ON public.helm_authority_policies (org_id, key, valid_from);

-- A policy version and its rules are what the organization said, when it said it.
CREATE OR REPLACE FUNCTION public.helm_authority_policies_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  prior record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_authority_policies: a policy version is never edited or deleted; record a new version';
  END IF;
  IF NEW.supersedes_policy_id IS NOT NULL THEN
    SELECT org_id, key INTO prior FROM public.helm_authority_policies WHERE id = NEW.supersedes_policy_id;
    IF prior IS NULL OR prior.org_id <> NEW.org_id OR prior.key <> NEW.key THEN
      RAISE EXCEPTION 'helm_authority_policies: a version supersedes an earlier version of the same policy, in the same organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_authority_policies_guard ON public.helm_authority_policies;
CREATE TRIGGER helm_authority_policies_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_authority_policies
  FOR EACH ROW EXECUTE FUNCTION public.helm_authority_policies_guard();

CREATE OR REPLACE FUNCTION public.helm_authority_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  pol record;
  line jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_authority_rules: a rule is part of an immutable policy version; record a new version';
  END IF;
  SELECT org_id INTO pol FROM public.helm_authority_policies WHERE id = NEW.policy_id;
  IF pol IS NULL OR pol.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'helm_authority_rules: the policy is not in this organization';
  END IF;
  IF NEW.holder_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.helm_entities e
    WHERE e.id = NEW.holder_role_id AND e.org_id = NEW.org_id AND e.entity_type_id = 'et_role'
  ) THEN
    RAISE EXCEPTION 'helm_authority_rules: authority attaches to a Role entity of this organization';
  END IF;
  IF NEW.escalation_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.helm_entities e
    WHERE e.id = NEW.escalation_role_id AND e.org_id = NEW.org_id AND e.entity_type_id = 'et_role'
  ) THEN
    RAISE EXCEPTION 'helm_authority_rules: escalation goes to a Role entity of this organization';
  END IF;
  -- Every line is an exact decimal on a named metric, compared one known way.
  FOR line IN SELECT value FROM jsonb_array_elements(NEW.conditions) LOOP
    IF NOT (line ? 'metricKey') OR NOT (line ? 'threshold')
       OR (line->>'threshold') !~ '^-?[0-9]+(\.[0-9]+)?$'
       OR (line->>'comparator') NOT IN ('GTE', 'GT', 'LTE', 'LT') THEN
      RAISE EXCEPTION 'helm_authority_rules: a condition names a metric, a comparator and an exact decimal line';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_authority_rules_guard ON public.helm_authority_rules;
CREATE TRIGGER helm_authority_rules_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_authority_rules
  FOR EACH ROW EXECUTE FUNCTION public.helm_authority_rules_guard();

-- ------------------------------------------------------------ role occupancy

CREATE TABLE IF NOT EXISTS public.helm_role_occupancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  role_label text NOT NULL CHECK (char_length(btrim(role_label)) >= 1),
  -- The authenticated identity. RLS and the approval guard check this, never a label.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  person_entity_id uuid REFERENCES public.helm_entities(id) ON DELETE SET NULL,
  person_label text NOT NULL CHECK (char_length(btrim(person_label)) >= 1),
  kind text NOT NULL CHECK (kind IN ('SUBSTANTIVE', 'ACTING')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz CHECK (valid_to IS NULL OR valid_to > valid_from),
  basis text NOT NULL CHECK (char_length(btrim(basis)) >= 4),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS helm_role_occupancies_user_idx ON public.helm_role_occupancies (org_id, user_id, valid_from);
CREATE INDEX IF NOT EXISTS helm_role_occupancies_role_idx ON public.helm_role_occupancies (org_id, role_id, valid_from);

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
    RETURN NEW;
  END IF;
  -- UPDATE: the only change is ending an open occupancy, once.
  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'helm_role_occupancies: that occupancy has already ended; its history is not rewritten';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.role_id <> OLD.role_id OR NEW.user_id <> OLD.user_id
     OR NEW.kind <> OLD.kind OR NEW.valid_from <> OLD.valid_from OR NEW.basis <> OLD.basis
     OR NEW.recorded_at <> OLD.recorded_at OR NEW.person_label <> OLD.person_label THEN
    RAISE EXCEPTION 'helm_role_occupancies: only the end of an occupancy may be recorded';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_role_occupancies_guard ON public.helm_role_occupancies;
CREATE TRIGGER helm_role_occupancies_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_role_occupancies
  FOR EACH ROW EXECUTE FUNCTION public.helm_role_occupancies_guard();

-- ---------------------------------------------------------------- delegation

CREATE TABLE IF NOT EXISTS public.helm_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  delegator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  delegator_label text NOT NULL CHECK (char_length(btrim(delegator_label)) >= 1),
  delegator_role_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  delegator_role_label text NOT NULL,
  delegate_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  delegate_label text NOT NULL CHECK (char_length(btrim(delegate_label)) >= 1),
  decision_types text[] NOT NULL CHECK (cardinality(decision_types) >= 1),
  acts text[] NOT NULL CHECK (
    cardinality(acts) >= 1
    AND acts <@ ARRAY['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE', 'OVERRIDE_POLICY']::text[]
  ),
  scope jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scope) = 'array'),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'),
  valid_from timestamptz NOT NULL,
  -- Required: a delegation without an end is a change of role, not a delegation.
  valid_to timestamptz NOT NULL CHECK (valid_to > valid_from),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 8),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT helm_delegations_not_to_self CHECK (delegator_user_id <> delegate_user_id),
  CONSTRAINT helm_delegations_revocation_coherent CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS helm_delegations_delegate_idx ON public.helm_delegations (org_id, delegate_user_id, valid_from);

-- Integrity only: a delegation needs a seat behind it. Whether it stays inside
-- the delegator's authority is checked by the kernel (validateDelegation) and
-- again, by intersection, at every evaluation.
CREATE OR REPLACE FUNCTION public.helm_delegations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helm_delegations: a delegation is history and is never deleted; revoke it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'helm_delegations: a delegation is recorded unrevoked';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.helm_role_occupancies o
      WHERE o.org_id = NEW.org_id AND o.user_id = NEW.delegator_user_id AND o.role_id = NEW.delegator_role_id
        AND o.valid_from <= now() AND (o.valid_to IS NULL OR o.valid_to > now())
    ) THEN
      RAISE EXCEPTION 'helm_delegations: the delegator does not occupy the role whose authority they delegate';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'helm_delegations: that delegation is already revoked';
  END IF;
  IF NEW.revoked_at IS NULL OR NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id
     OR NEW.delegator_user_id <> OLD.delegator_user_id OR NEW.delegate_user_id <> OLD.delegate_user_id
     OR NEW.delegator_role_id <> OLD.delegator_role_id OR NEW.valid_from <> OLD.valid_from
     OR NEW.valid_to <> OLD.valid_to OR NEW.scope <> OLD.scope OR NEW.conditions <> OLD.conditions
     OR NEW.acts <> OLD.acts OR NEW.decision_types <> OLD.decision_types OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'helm_delegations: only revoking may change a delegation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_delegations_guard ON public.helm_delegations;
CREATE TRIGGER helm_delegations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_delegations
  FOR EACH ROW EXECUTE FUNCTION public.helm_delegations_guard();

-- ---------------------------------------------- decision governance profile

CREATE TABLE IF NOT EXISTS public.helm_decision_governance_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  decision_type_key text REFERENCES public.helm_decision_types(key) ON DELETE RESTRICT,
  -- Entities the decision is also about. They ADD to the scope HELM derives.
  declared_subjects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(declared_subjects) = 'array'),
  note text NOT NULL DEFAULT '',
  declared_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  declared_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS helm_decision_governance_profiles_decision_idx
  ON public.helm_decision_governance_profiles (decision_id, declared_at);

-- ------------------------------------------------------- decision visibility

CREATE TABLE IF NOT EXISTS public.helm_decision_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE CASCADE,
  org_unit_id uuid NOT NULL REFERENCES public.org_units(id) ON DELETE CASCADE,
  org_unit_label text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 4),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_decision_visibility_once UNIQUE (decision_id, org_unit_id)
);

CREATE INDEX IF NOT EXISTS helm_decision_visibility_unit_idx ON public.helm_decision_visibility (org_unit_id);

-- Integrity only: the grant, the decision and the unit are one organization's.
CREATE OR REPLACE FUNCTION public.helm_decision_governance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'helm_decision_governance_profiles' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_decision_governance_profiles: a classification is insert-only; declare a new one';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '%: a grant is added or removed, never edited', TG_TABLE_NAME;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.helm_decisions d WHERE d.id = NEW.decision_id AND d.org_id = NEW.org_id) THEN
    RAISE EXCEPTION '%: decision not found in this organization', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'helm_decision_visibility'
     AND NOT EXISTS (SELECT 1 FROM public.org_units u WHERE u.id = NEW.org_unit_id AND u.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_decision_visibility: the unit is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_decision_governance_profiles_guard ON public.helm_decision_governance_profiles;
CREATE TRIGGER helm_decision_governance_profiles_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_governance_profiles
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_governance_guard();

DROP TRIGGER IF EXISTS helm_decision_visibility_guard ON public.helm_decision_visibility;
CREATE TRIGGER helm_decision_visibility_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_decision_visibility
  FOR EACH ROW EXECUTE FUNCTION public.helm_decision_governance_guard();

-- ------------------------------------------------ the visibility helpers
-- SECURITY DEFINER so a policy can consult memberships and decisions without
-- recursing through their own policies. Subtree-inclusive: membership of a
-- unit reaches every unit below it, so a country GM sees the country's BUs.

CREATE OR REPLACE FUNCTION public.helm_visible_org_units(p_org uuid)
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

CREATE OR REPLACE FUNCTION public.helm_can_see_decision(p_decision uuid)
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
            AND v.org_unit_id IN (SELECT public.helm_visible_org_units(d.org_id))
        )
      )
  );
$fn$;

CREATE OR REPLACE FUNCTION public.helm_can_see_revision(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.helm_decision_revisions r
    WHERE r.id = p_revision AND public.helm_can_see_decision(r.decision_id)
  );
$fn$;

-- ------------------------------------------------------------ evaluations

CREATE TABLE IF NOT EXISTS public.helm_authority_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  -- The exact commitment judged. A reconsidered commitment has another.
  commitment_fingerprint text NOT NULL CHECK (char_length(commitment_fingerprint) >= 8),
  act text NOT NULL CHECK (act IN ('PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE', 'OVERRIDE_POLICY')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_label text NOT NULL,
  actor_roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actor_roles) = 'array'),
  -- Authority is judged as of the act, never as of today.
  act_at timestamptz NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_type_key text REFERENCES public.helm_decision_types(key) ON DELETE RESTRICT,
  profile_id uuid REFERENCES public.helm_decision_governance_profiles(id) ON DELETE RESTRICT,
  policies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(policies) = 'array'),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  consequences jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(consequences) = 'array'),
  rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
  delegations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(delegations) = 'array'),
  basis_rule_id uuid REFERENCES public.helm_authority_rules(id) ON DELETE RESTRICT,
  basis_delegation_id uuid REFERENCES public.helm_delegations(id) ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('AUTHORIZED', 'REQUIRES_APPROVAL', 'ESCALATED', 'NOT_AUTHORIZED', 'INDETERMINATE')),
  required_authorities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_authorities) = 'array'),
  escalation_chain jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(escalation_chain) = 'array'),
  authorities_in_scope jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(authorities_in_scope) = 'array'),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  governability text NOT NULL CHECK (governability IN ('GOVERNABLE', 'GOVERNABLE_WITH_GAPS', 'NOT_GOVERNABLE')),
  explanation jsonb NOT NULL CHECK (jsonb_typeof(explanation) = 'array' AND jsonb_array_length(explanation) >= 1),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) >= 8),
  supersedes_evaluation_id uuid REFERENCES public.helm_authority_evaluations(id) ON DELETE RESTRICT,

  -- An AUTHORIZED verdict always names the rule it rests on.
  CONSTRAINT helm_authority_evaluations_authorized_has_basis CHECK (result <> 'AUTHORIZED' OR basis_rule_id IS NOT NULL),
  -- An INDETERMINATE verdict always names what is missing.
  CONSTRAINT helm_authority_evaluations_indeterminate_names_gaps CHECK (result <> 'INDETERMINATE' OR jsonb_array_length(gaps) >= 1),
  CONSTRAINT helm_authority_evaluations_governability_coherent CHECK ((result = 'INDETERMINATE') = (governability = 'NOT_GOVERNABLE'))
);

CREATE INDEX IF NOT EXISTS helm_authority_evaluations_commitment_idx
  ON public.helm_authority_evaluations (org_id, commitment_id, evaluated_at);
CREATE INDEX IF NOT EXISTS helm_authority_evaluations_decision_idx
  ON public.helm_authority_evaluations (decision_id);

-- Integrity only: the judgement is of THIS commitment, by the identity that
-- committed it, and an AUTHORIZED basis is a rule that identity actually held
-- at the act — through a seat or a delegation. The threshold verdict itself is
-- the kernel's; the database cannot and does not re-derive it.
CREATE OR REPLACE FUNCTION public.helm_authority_evaluations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c record;
  r record;
  prior record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_authority_evaluations: an evaluation is a record of a judgement; it is never edited or deleted';
  END IF;
  SELECT * INTO c FROM public.helm_decision_commitments WHERE id = NEW.commitment_id;
  IF c IS NULL OR c.org_id <> NEW.org_id OR c.decision_id <> NEW.decision_id THEN
    RAISE EXCEPTION 'helm_authority_evaluations: commitment not found for this decision and organization';
  END IF;
  IF c.fingerprint <> NEW.commitment_fingerprint THEN
    RAISE EXCEPTION 'helm_authority_evaluations: the evaluation names a fingerprint the commitment does not carry';
  END IF;
  IF NEW.act = 'COMMIT' AND NEW.actor_user_id IS DISTINCT FROM c.committed_by THEN
    RAISE EXCEPTION 'helm_authority_evaluations: the actor of a commitment is the identity that committed it';
  END IF;
  IF NEW.supersedes_evaluation_id IS NOT NULL THEN
    SELECT commitment_id INTO prior FROM public.helm_authority_evaluations WHERE id = NEW.supersedes_evaluation_id;
    IF prior IS NULL OR prior.commitment_id <> NEW.commitment_id THEN
      RAISE EXCEPTION 'helm_authority_evaluations: an evaluation supersedes an earlier evaluation of the same commitment';
    END IF;
  END IF;
  IF NEW.basis_rule_id IS NOT NULL THEN
    SELECT * INTO r FROM public.helm_authority_rules WHERE id = NEW.basis_rule_id;
    IF r IS NULL OR r.org_id <> NEW.org_id OR r.effect <> 'GRANT' THEN
      RAISE EXCEPTION 'helm_authority_evaluations: the basis is a GRANT rule of this organization';
    END IF;
    IF NEW.result = 'AUTHORIZED' AND NOT (
      (r.holder_kind = 'PERSON' AND r.holder_user_id = NEW.actor_user_id)
      OR EXISTS (
        SELECT 1 FROM public.helm_role_occupancies o
        WHERE o.org_id = NEW.org_id AND o.user_id = NEW.actor_user_id AND o.role_id = r.holder_role_id
          AND o.recorded_at <= NEW.act_at AND o.valid_from <= NEW.act_at
          AND (o.valid_to IS NULL OR o.valid_to > NEW.act_at)
      )
      OR EXISTS (
        SELECT 1 FROM public.helm_delegations g
        WHERE g.id = NEW.basis_delegation_id AND g.org_id = NEW.org_id
          AND g.delegate_user_id = NEW.actor_user_id AND g.delegator_role_id = r.holder_role_id
          AND g.recorded_at <= NEW.act_at AND g.valid_from <= NEW.act_at AND g.valid_to > NEW.act_at
          AND (g.revoked_at IS NULL OR g.revoked_at > NEW.act_at)
      )
    ) THEN
      RAISE EXCEPTION 'helm_authority_evaluations: an AUTHORIZED basis must be a rule the actor held at the act, by seat or by delegation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_authority_evaluations_guard ON public.helm_authority_evaluations;
CREATE TRIGGER helm_authority_evaluations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_authority_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.helm_authority_evaluations_guard();

-- --------------------------------------------------------- required approvals

CREATE TABLE IF NOT EXISTS public.helm_required_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  evaluation_id uuid NOT NULL REFERENCES public.helm_authority_evaluations(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  commitment_fingerprint text NOT NULL,
  role_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  role_label text NOT NULL,
  basis_rule_id uuid NOT NULL REFERENCES public.helm_authority_rules(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('ESCALATION', 'RESTRICTION', 'MATRIX')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 8),
  sequence integer NOT NULL DEFAULT 1 CHECK (sequence >= 1),
  -- When set, this person cannot satisfy the requirement (separation of duties).
  independent_of_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS helm_required_approvals_evaluation_idx ON public.helm_required_approvals (evaluation_id, sequence);
CREATE INDEX IF NOT EXISTS helm_required_approvals_commitment_idx ON public.helm_required_approvals (org_id, commitment_id);

CREATE OR REPLACE FUNCTION public.helm_required_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  e record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_required_approvals: a requirement is generated from an evaluation and never edited or deleted';
  END IF;
  SELECT * INTO e FROM public.helm_authority_evaluations WHERE id = NEW.evaluation_id;
  IF e IS NULL OR e.org_id <> NEW.org_id OR e.commitment_id <> NEW.commitment_id
     OR e.decision_id <> NEW.decision_id OR e.commitment_fingerprint <> NEW.commitment_fingerprint THEN
    RAISE EXCEPTION 'helm_required_approvals: a requirement belongs to the commitment fingerprint its evaluation judged';
  END IF;
  IF e.result NOT IN ('REQUIRES_APPROVAL', 'ESCALATED') THEN
    RAISE EXCEPTION 'helm_required_approvals: an evaluation that is % requires no approval', e.result;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_required_approvals_guard ON public.helm_required_approvals;
CREATE TRIGGER helm_required_approvals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_required_approvals
  FOR EACH ROW EXECUTE FUNCTION public.helm_required_approvals_guard();

-- ------------------------------------------------------------ approval acts

CREATE TABLE IF NOT EXISTS public.helm_approval_acts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  required_approval_id uuid NOT NULL REFERENCES public.helm_required_approvals(id) ON DELETE RESTRICT,
  evaluation_id uuid NOT NULL REFERENCES public.helm_authority_evaluations(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  commitment_id uuid NOT NULL REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  commitment_fingerprint text NOT NULL,
  approver_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approver_label text NOT NULL,
  approver_role_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE RESTRICT,
  approver_role_label text NOT NULL,
  basis_kind text NOT NULL CHECK (basis_kind IN ('ROLE_OCCUPANCY', 'DELEGATION')),
  basis_occupancy_id uuid REFERENCES public.helm_role_occupancies(id) ON DELETE RESTRICT,
  basis_delegation_id uuid REFERENCES public.helm_delegations(id) ON DELETE RESTRICT,
  basis_rule_id uuid REFERENCES public.helm_authority_rules(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT', 'RETURN_FOR_RECONSIDERATION')),
  comments text NOT NULL DEFAULT '',
  conditions text NOT NULL DEFAULT '',
  valid_until timestamptz,
  acted_at timestamptz NOT NULL DEFAULT now(),

  -- One response per requirement. An act is never replaced.
  CONSTRAINT helm_approval_acts_once UNIQUE (required_approval_id),
  CONSTRAINT helm_approval_acts_basis_coherent CHECK (
    (basis_kind = 'ROLE_OCCUPANCY' AND basis_occupancy_id IS NOT NULL AND basis_delegation_id IS NULL)
    OR (basis_kind = 'DELEGATION' AND basis_delegation_id IS NOT NULL AND basis_occupancy_id IS NULL)
  ),
  -- A rejection or a return says why.
  CONSTRAINT helm_approval_acts_reasoned CHECK (decision = 'APPROVE' OR char_length(btrim(comments)) >= 4)
);

CREATE INDEX IF NOT EXISTS helm_approval_acts_commitment_idx ON public.helm_approval_acts (org_id, commitment_id, acted_at);

-- Integrity: the act answers exactly its requirement's fingerprint; the approver
-- is not the person the requirement must be independent of; and the role is
-- resolved from a seat or a delegation the approver actually held at the act —
-- never accepted as text.
CREATE OR REPLACE FUNCTION public.helm_approval_acts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  req record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_approval_acts: an approval act is what a person did; it is never edited or deleted';
  END IF;
  SELECT * INTO req FROM public.helm_required_approvals WHERE id = NEW.required_approval_id;
  IF req IS NULL OR req.org_id <> NEW.org_id OR req.evaluation_id <> NEW.evaluation_id
     OR req.commitment_id <> NEW.commitment_id OR req.decision_id <> NEW.decision_id
     OR req.commitment_fingerprint <> NEW.commitment_fingerprint THEN
    RAISE EXCEPTION 'helm_approval_acts: an act answers exactly the commitment fingerprint its requirement was raised for';
  END IF;
  IF NEW.approver_role_id <> req.role_id THEN
    RAISE EXCEPTION 'helm_approval_acts: the requirement is for another role';
  END IF;
  IF req.independent_of_user_id IS NOT NULL AND NEW.approver_user_id = req.independent_of_user_id THEN
    RAISE EXCEPTION 'helm_approval_acts: separation of duties — this approval must come from someone other than the person who committed';
  END IF;
  IF NEW.acted_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'helm_approval_acts: an act cannot be recorded in the future';
  END IF;
  IF NEW.basis_kind = 'ROLE_OCCUPANCY' AND NOT EXISTS (
    SELECT 1 FROM public.helm_role_occupancies o
    WHERE o.id = NEW.basis_occupancy_id AND o.org_id = NEW.org_id AND o.user_id = NEW.approver_user_id
      AND o.role_id = req.role_id AND o.recorded_at <= NEW.acted_at
      AND o.valid_from <= NEW.acted_at AND (o.valid_to IS NULL OR o.valid_to > NEW.acted_at)
  ) THEN
    RAISE EXCEPTION 'helm_approval_acts: the approver did not occupy the required role when acting';
  END IF;
  IF NEW.basis_kind = 'DELEGATION' AND NOT EXISTS (
    SELECT 1 FROM public.helm_delegations g
    WHERE g.id = NEW.basis_delegation_id AND g.org_id = NEW.org_id AND g.delegate_user_id = NEW.approver_user_id
      AND g.delegator_role_id = req.role_id AND 'APPROVE' = ANY (g.acts)
      AND g.recorded_at <= NEW.acted_at AND g.valid_from <= NEW.acted_at AND g.valid_to > NEW.acted_at
      AND (g.revoked_at IS NULL OR g.revoked_at > NEW.acted_at)
  ) THEN
    RAISE EXCEPTION 'helm_approval_acts: the approver held no delegation of the required role when acting';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_approval_acts_guard ON public.helm_approval_acts;
CREATE TRIGGER helm_approval_acts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.helm_approval_acts
  FOR EACH ROW EXECUTE FUNCTION public.helm_approval_acts_guard();

-- ------------------------------------------------ the retired approval rules

COMMENT ON TABLE public.helm_approval_rules IS
  'RETIRED (Phase 6): a manually entered threshold_amount against an org rank. REPLACED by helm_authority_policies and helm_authority_rules, whose conditions are read from computed consequences and whose holders are roles. Kept for additive discipline; nothing reads or writes it.';
DROP POLICY IF EXISTS "Managers manage approval rules" ON public.helm_approval_rules;

-- ------------------------------------------------------------------ RLS

ALTER TABLE public.helm_decision_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_authority_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_authority_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_role_occupancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_governance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_decision_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_authority_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_required_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_approval_acts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read decision types" ON public.helm_decision_types;
CREATE POLICY "Read decision types" ON public.helm_decision_types
  FOR SELECT TO authenticated USING (org_id IS NULL OR public.is_org_member(org_id));
-- Like every registry: shipped types have no org; an organization's own are admin-only.
DROP POLICY IF EXISTS "Admins add decision types" ON public.helm_decision_types;
CREATE POLICY "Admins add decision types" ON public.helm_decision_types
  FOR INSERT TO authenticated WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

-- The authority structure — policies, rules, who holds which seat, and who
-- holds delegated authority — is readable by the organization: authority that
-- cannot be seen cannot be explained. Only admins record it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_authority_policies', 'helm_authority_rules', 'helm_role_occupancies', 'helm_delegations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Members read %s" ON public.%I FOR SELECT TO authenticated USING (public.is_org_member(org_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_authority_policies', 'helm_authority_rules', 'helm_role_occupancies'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Admins record %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Admins record %s" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, ''admin''));', t, t);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS "Admins end role occupancies" ON public.helm_role_occupancies;
CREATE POLICY "Admins end role occupancies" ON public.helm_role_occupancies
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'admin'))
  WITH CHECK (public.has_org_role(org_id, 'admin'));

-- A delegation is made by the delegator, as themselves; revoked by them or an admin.
DROP POLICY IF EXISTS "Delegators record delegations" ON public.helm_delegations;
CREATE POLICY "Delegators record delegations" ON public.helm_delegations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND delegator_user_id = (select auth.uid()));
DROP POLICY IF EXISTS "Delegators revoke delegations" ON public.helm_delegations;
CREATE POLICY "Delegators revoke delegations" ON public.helm_delegations
  FOR UPDATE TO authenticated
  USING (delegator_user_id = (select auth.uid()) OR public.has_org_role(org_id, 'admin'))
  WITH CHECK (delegator_user_id = (select auth.uid()) OR public.has_org_role(org_id, 'admin'));

-- Decision-bound governance records: visible exactly where the decision is.
DROP POLICY IF EXISTS "Scoped read governance profiles" ON public.helm_decision_governance_profiles;
CREATE POLICY "Scoped read governance profiles" ON public.helm_decision_governance_profiles
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped classify decisions" ON public.helm_decision_governance_profiles;
CREATE POLICY "Scoped classify decisions" ON public.helm_decision_governance_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id) AND declared_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read visibility grants" ON public.helm_decision_visibility;
CREATE POLICY "Scoped read visibility grants" ON public.helm_decision_visibility
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped share decisions" ON public.helm_decision_visibility;
CREATE POLICY "Scoped share decisions" ON public.helm_decision_visibility
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id) AND granted_by = (select auth.uid()));
DROP POLICY IF EXISTS "Admins withdraw visibility grants" ON public.helm_decision_visibility;
CREATE POLICY "Admins withdraw visibility grants" ON public.helm_decision_visibility
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS "Scoped read authority evaluations" ON public.helm_authority_evaluations;
CREATE POLICY "Scoped read authority evaluations" ON public.helm_authority_evaluations
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped record authority evaluations" ON public.helm_authority_evaluations;
CREATE POLICY "Scoped record authority evaluations" ON public.helm_authority_evaluations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id) AND evaluated_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read required approvals" ON public.helm_required_approvals;
CREATE POLICY "Scoped read required approvals" ON public.helm_required_approvals
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Scoped record required approvals" ON public.helm_required_approvals;
CREATE POLICY "Scoped record required approvals" ON public.helm_required_approvals
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id));

-- The approver is the authenticated caller. A client cannot submit
-- "approved by the Country GM" for someone else.
DROP POLICY IF EXISTS "Scoped read approval acts" ON public.helm_approval_acts;
CREATE POLICY "Scoped read approval acts" ON public.helm_approval_acts
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Approvers record their own acts" ON public.helm_approval_acts;
CREATE POLICY "Approvers record their own acts" ON public.helm_approval_acts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member')
    AND public.helm_can_see_decision(decision_id)
    AND approver_user_id = (select auth.uid())
  );

-- ------------------------------------ scoped visibility for the decision tables
-- Replaces "any member reads every decision" (Phase 5's stated gap) on every
-- decision table. Writes are scoped the same way: a member cannot add to, seal
-- or resolve a decision they cannot see.

DROP POLICY IF EXISTS "Members read helm_decisions" ON public.helm_decisions;
DROP POLICY IF EXISTS "Scoped read helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped read helm_decisions" ON public.helm_decisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(id));
DROP POLICY IF EXISTS "Members update helm_decisions" ON public.helm_decisions;
DROP POLICY IF EXISTS "Scoped update helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped update helm_decisions" ON public.helm_decisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(id));
DROP POLICY IF EXISTS "Managers delete helm_decisions" ON public.helm_decisions;
DROP POLICY IF EXISTS "Scoped delete helm_decisions" ON public.helm_decisions;
CREATE POLICY "Scoped delete helm_decisions" ON public.helm_decisions
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager') AND public.helm_can_see_decision(id));

DO $$
DECLARE t text;
BEGIN
  -- Tables that carry decision_id.
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions',
    'helm_decision_revisions', 'helm_decision_criteria', 'helm_decision_challenges',
    'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
    'helm_decision_outcome_reviews'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members read %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped read %s" ON public.%I FOR SELECT TO authenticated
         USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  -- Tables that carry only revision_id.
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members read %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped read %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped read %s" ON public.%I FOR SELECT TO authenticated
         USING (public.is_org_member(org_id) AND public.helm_can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  -- Phase 5 writes into a decision's parts: scoped to decisions the writer can see.
  FOREACH t IN ARRAY ARRAY[
    'helm_decision_revisions', 'helm_decision_criteria', 'helm_decision_challenges',
    'helm_decision_evidence', 'helm_decision_commitments', 'helm_decision_commitment_snapshots',
    'helm_decision_outcome_reviews'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members write %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped write %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped write %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND public.helm_can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members write %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped write %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped write %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND public.helm_can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  -- The pre-kernel working tables' insert/update/delete, likewise.
  FOREACH t IN ARRAY ARRAY['helm_decision_alternatives', 'helm_decision_assumptions', 'helm_actions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members insert %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped insert %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped insert %s" ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.has_org_role(org_id, ''member'') AND public.helm_can_see_decision(decision_id));', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Members update %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped update %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped update %s" ON public.%I FOR UPDATE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND public.helm_can_see_decision(decision_id))
         WITH CHECK (public.has_org_role(org_id, ''member'') AND public.helm_can_see_decision(decision_id));', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Managers delete %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped delete %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped delete %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''manager'') AND public.helm_can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  -- Phase 5's draft deletions, scoped too: a draft part of a decision one cannot see stays put.
  FOREACH t IN ARRAY ARRAY['helm_decision_criteria', 'helm_decision_evidence'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members remove draft %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped remove draft %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped remove draft %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND public.helm_can_see_decision(decision_id));', t, t);
  END LOOP;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['helm_decision_criterion_assessments', 'helm_decision_weightings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members remove draft %s" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Scoped remove draft %s" ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY "Scoped remove draft %s" ON public.%I FOR DELETE TO authenticated
         USING (public.has_org_role(org_id, ''member'') AND public.helm_can_see_revision(revision_id));', t, t);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS "Members seal decision revisions" ON public.helm_decision_revisions;
DROP POLICY IF EXISTS "Scoped seal decision revisions" ON public.helm_decision_revisions;
CREATE POLICY "Scoped seal decision revisions" ON public.helm_decision_revisions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id));

DROP POLICY IF EXISTS "Members resolve decision challenges" ON public.helm_decision_challenges;
DROP POLICY IF EXISTS "Scoped resolve decision challenges" ON public.helm_decision_challenges;
CREATE POLICY "Scoped resolve decision challenges" ON public.helm_decision_challenges
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id))
  WITH CHECK (public.has_org_role(org_id, 'member') AND public.helm_can_see_decision(decision_id));

DROP POLICY IF EXISTS "Members read decision events" ON public.helm_decision_events;
DROP POLICY IF EXISTS "Scoped read decision events" ON public.helm_decision_events;
CREATE POLICY "Scoped read decision events" ON public.helm_decision_events
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND public.helm_can_see_decision(decision_id));
DROP POLICY IF EXISTS "Members append decision events" ON public.helm_decision_events;
DROP POLICY IF EXISTS "Scoped append decision events" ON public.helm_decision_events;
CREATE POLICY "Scoped append decision events" ON public.helm_decision_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member')
    AND public.helm_can_see_decision(decision_id)
    AND actor_id = (select auth.uid())
  );

-- ------------------------------------------------------------------ grants

REVOKE ALL ON TABLE
  public.helm_decision_types, public.helm_authority_policies, public.helm_authority_rules,
  public.helm_role_occupancies, public.helm_delegations, public.helm_decision_governance_profiles,
  public.helm_decision_visibility, public.helm_authority_evaluations, public.helm_required_approvals,
  public.helm_approval_acts
FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE public.helm_decision_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.helm_authority_policies, public.helm_authority_rules, public.helm_role_occupancies,
  public.helm_delegations, public.helm_decision_governance_profiles, public.helm_decision_visibility,
  public.helm_authority_evaluations, public.helm_required_approvals, public.helm_approval_acts
TO authenticated;
GRANT ALL ON TABLE
  public.helm_decision_types, public.helm_authority_policies, public.helm_authority_rules,
  public.helm_role_occupancies, public.helm_delegations, public.helm_decision_governance_profiles,
  public.helm_decision_visibility, public.helm_authority_evaluations, public.helm_required_approvals,
  public.helm_approval_acts
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_authority_policies_guard(), public.helm_authority_rules_guard(),
  public.helm_role_occupancies_guard(), public.helm_delegations_guard(),
  public.helm_decision_governance_guard(), public.helm_authority_evaluations_guard(),
  public.helm_required_approvals_guard(), public.helm_approval_acts_guard(),
  public.helm_visible_org_units(uuid), public.helm_can_see_decision(uuid), public.helm_can_see_revision(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.helm_visible_org_units(uuid), public.helm_can_see_decision(uuid), public.helm_can_see_revision(uuid)
TO authenticated, service_role;
