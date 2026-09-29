-- ============================================================================
-- HELM Phase 8 — Enterprise Causal Graph
-- ============================================================================
--
-- ADR-0026 (causal knowledge infrastructure, specialized storage),
-- ADR-0027 (evidence hierarchy, status and confidence policy).
--
--   PART 1  variables, claims and their revisions
--   PART 2  evidence, links, correlation findings
--   PART 3  causal questions and their candidates
--   PART 4  guards: write-once, record time stamped by the database, same-org
--           references, sequential revisions, one supersession, no
--           contradictory case as support, no correlation as evidence
--   PART 5  helm_private visibility helpers and scoped RLS
--   PART 6  the atomic claim writer, grants
--
-- CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP. Nothing here references a
-- calculation, a calculation run, a value observation or a scenario output,
-- and nothing here writes one. A claim's status is never stored: it is derived
-- from the evidence known at a lens (@helm/causal-runtime).
--
-- Additive for Memoire: every statement is on a helm_* object or in
-- helm_private; the shared-core membership tables are only READ.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_causal_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]{1,62}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) >= 1),
  kind text NOT NULL CHECK (kind IN ('METRIC', 'ACTION', 'CONDITION', 'EVENT', 'OUTCOME')),
  metric_key text,
  description text NOT NULL DEFAULT '',
  sensitivity text NOT NULL CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refs) = 'array'),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key),
  -- Only a METRIC variable is bound to a value metric, and it always is.
  CONSTRAINT helm_causal_variables_metric_coherent CHECK ((kind = 'METRIC') = (metric_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.helm_causal_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cause_key text NOT NULL,
  effect_key text NOT NULL,
  -- A small vocabulary; there is no unconditional CAUSES.
  relationship_type text NOT NULL CHECK (relationship_type IN ('INCREASES', 'DECREASES', 'ENABLES', 'CONSTRAINS', 'DELAYS', 'ACCELERATES', 'MEDIATES', 'MODERATES')),
  target_claim_id uuid REFERENCES public.helm_causal_claims(id) ON DELETE RESTRICT,
  -- Never global by default: anchored on entities, or ENTERPRISE_WIDE with a stated justification.
  scope jsonb NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'),
  applicable_from timestamptz,
  applicable_to timestamptz,
  sensitivity text NOT NULL CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  authored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  authored_by_label text NOT NULL CHECK (char_length(btrim(authored_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_causal_claims_two_variables CHECK (cause_key <> effect_key),
  CONSTRAINT helm_causal_claims_qualifier_coherent CHECK ((relationship_type IN ('MEDIATES', 'MODERATES')) = (target_claim_id IS NOT NULL)),
  CONSTRAINT helm_causal_claims_scoped CHECK (
    (scope->>'kind' = 'ANCHORED' AND jsonb_typeof(scope->'anchors') = 'array' AND jsonb_array_length(scope->'anchors') >= 1)
    OR (scope->>'kind' = 'ENTERPRISE_WIDE' AND char_length(btrim(coalesce(scope->>'justification', ''))) >= 12)
  ),
  CONSTRAINT helm_causal_claims_period_coherent CHECK (applicable_from IS NULL OR applicable_to IS NULL OR applicable_from < applicable_to)
);
CREATE INDEX IF NOT EXISTS helm_causal_claims_effect_idx ON public.helm_causal_claims (org_id, effect_key);
CREATE INDEX IF NOT EXISTS helm_causal_claims_cause_idx ON public.helm_causal_claims (org_id, cause_key);

CREATE TABLE IF NOT EXISTS public.helm_causal_claim_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.helm_causal_claims(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  mechanism jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mechanism) = 'array'),
  confounders jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(confounders) = 'array'),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 1),
  external_validity text NOT NULL,
  links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array'),
  retired boolean NOT NULL DEFAULT false,
  retirement_reason text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, revision),
  CONSTRAINT helm_causal_revisions_retirement_explained CHECK (NOT retired OR char_length(btrim(coalesce(retirement_reason, ''))) >= 1)
);

-- ====================================================================== PART 2

-- CORRELATES_WITH lives here and nowhere else. No column anywhere lets a
-- finding stand in for a claim or for evidence.
CREATE TABLE IF NOT EXISTS public.helm_correlation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  x_key text NOT NULL,
  y_key text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('POSITIVE', 'NEGATIVE', 'NONE')),
  method text NOT NULL CHECK (char_length(btrim(method)) >= 1),
  population text NOT NULL CHECK (char_length(btrim(population)) >= 1),
  period text NOT NULL CHECK (char_length(btrim(period)) >= 1),
  effect_estimate text NOT NULL CHECK (char_length(btrim(effect_estimate)) >= 1),
  uncertainty text NOT NULL CHECK (char_length(btrim(uncertainty)) >= 1),
  limitations text NOT NULL CHECK (char_length(btrim(limitations)) >= 1),
  scope jsonb NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refs) = 'array'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.helm_causal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('CONTROLLED_EXPERIMENT', 'NATURAL_EXPERIMENT', 'INTERVENTION', 'LONGITUDINAL_OBSERVATION', 'REPEATED_PATTERN', 'STATISTICAL_ANALYSIS', 'PROCESS_MECHANISM', 'EXTERNAL_RESEARCH', 'MANAGEMENT_EXPERTISE', 'CONTRADICTORY_CASE')),
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  assessed_strength text NOT NULL CHECK (assessed_strength IN ('LOW', 'MEDIUM', 'HIGH')),
  strength_rationale text NOT NULL CHECK (char_length(btrim(strength_rationale)) >= 1),
  -- Where it came from, who asserted it, how.
  provenance jsonb NOT NULL CHECK (
    char_length(btrim(coalesce(provenance->>'sourceSystem', ''))) >= 1
    AND char_length(btrim(coalesce(provenance->>'sourceReference', ''))) >= 1
    AND char_length(btrim(coalesce(provenance->>'assertedByLabel', ''))) >= 1
    AND provenance->>'method' IN ('DOCUMENT', 'MEASUREMENT', 'ANALYSIS', 'JUDGEMENT', 'EXTERNAL')
  ),
  cause_observed_at timestamptz,
  effect_observed_at timestamptz,
  statistical jsonb,
  correlation_finding_id uuid REFERENCES public.helm_correlation_findings(id) ON DELETE RESTRICT,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refs) = 'array'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED')),
  supersedes_id uuid REFERENCES public.helm_causal_evidence(id) ON DELETE RESTRICT,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- A person's judgement is never presented as a measurement.
  CONSTRAINT helm_causal_evidence_judgement_labelled CHECK ((type = 'MANAGEMENT_EXPERTISE') = (provenance->>'method' = 'JUDGEMENT')),
  CONSTRAINT helm_causal_evidence_statistics_stated CHECK (
    type <> 'STATISTICAL_ANALYSIS' OR (
      statistical IS NOT NULL
      AND char_length(btrim(coalesce(statistical->>'method', ''))) >= 1
      AND char_length(btrim(coalesce(statistical->>'population', ''))) >= 1
      AND char_length(btrim(coalesce(statistical->>'period', ''))) >= 1
      AND char_length(btrim(coalesce(statistical->>'effectEstimate', ''))) >= 1
      AND char_length(btrim(coalesce(statistical->>'uncertainty', ''))) >= 1
      AND char_length(btrim(coalesce(statistical->>'limitations', ''))) >= 1
    )
  )
);
-- A correction supersedes an item once; a later correction corrects the correction.
CREATE UNIQUE INDEX IF NOT EXISTS helm_causal_evidence_superseded_once ON public.helm_causal_evidence (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.helm_causal_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.helm_causal_claims(id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL REFERENCES public.helm_causal_evidence(id) ON DELETE RESTRICT,
  stance text NOT NULL CHECK (stance IN ('SUPPORTS', 'CHALLENGES', 'CONTRADICTS', 'CONTEXTUALIZES')),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 1),
  linked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS helm_causal_evidence_links_evidence_idx ON public.helm_causal_evidence_links (evidence_id);

-- ====================================================================== PART 3

CREATE TABLE IF NOT EXISTS public.helm_causal_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  target jsonb NOT NULL CHECK (char_length(btrim(coalesce(target->>'variableKey', ''))) >= 1),
  scope jsonb NOT NULL,
  period_from timestamptz,
  period_to timestamptz,
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  asked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- A candidate explanation is an existing claim a person proposed. HELM never proposes one.
CREATE TABLE IF NOT EXISTS public.helm_causal_question_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.helm_causal_questions(id) ON DELETE RESTRICT,
  claim_id uuid NOT NULL REFERENCES public.helm_causal_claims(id) ON DELETE RESTRICT,
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 1),
  proposed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, claim_id)
);

-- ====================================================================== PART 4

-- One guard for every causal table: write-once, and the record time is the
-- database's own — a client cannot back-date what HELM knew.
CREATE OR REPLACE FUNCTION public.helm_causal_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: causal knowledge is append-only; a change is a new revision, a correction or a new link', TG_TABLE_NAME;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_causal_claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_causal_variables v WHERE v.org_id = NEW.org_id AND v.key = NEW.cause_key)
     OR NOT EXISTS (SELECT 1 FROM public.helm_causal_variables v WHERE v.org_id = NEW.org_id AND v.key = NEW.effect_key) THEN
    RAISE EXCEPTION 'helm_causal_claims: a claim names two causal variables of its own organization';
  END IF;
  IF NEW.target_claim_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = NEW.target_claim_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_causal_claims: a qualifying claim qualifies a claim of its own organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_causal_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  last_rev integer;
  last_retired boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = NEW.claim_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_causal_claim_revisions: the claim is not in this organization';
  END IF;
  SELECT r.revision, r.retired INTO last_rev, last_retired
  FROM public.helm_causal_claim_revisions r WHERE r.claim_id = NEW.claim_id ORDER BY r.revision DESC LIMIT 1;
  IF coalesce(last_retired, false) THEN
    RAISE EXCEPTION 'helm_causal_claim_revisions: the claim is retired; author a new claim';
  END IF;
  IF NEW.revision <> coalesce(last_rev, 0) + 1 THEN
    RAISE EXCEPTION 'helm_causal_claim_revisions: revision % follows %; revisions are sequential and never rewritten', NEW.revision, coalesce(last_rev, 0);
  END IF;
  IF NEW.revision = 1 AND NEW.retired THEN
    RAISE EXCEPTION 'helm_causal_claim_revisions: a claim cannot be created retired';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_causal_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.supersedes_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.helm_causal_evidence e WHERE e.id = NEW.supersedes_id AND e.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_causal_evidence: a correction supersedes evidence of its own organization';
  END IF;
  IF NEW.correlation_finding_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.helm_correlation_findings f WHERE f.id = NEW.correlation_finding_id AND f.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_causal_evidence: the cited correlation finding is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_causal_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  ev record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = NEW.claim_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_causal_evidence_links: the claim is not in this organization';
  END IF;
  SELECT * INTO ev FROM public.helm_causal_evidence e WHERE e.id = NEW.evidence_id;
  IF ev IS NULL OR ev.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'helm_causal_evidence_links: the evidence is not in this organization';
  END IF;
  IF ev.type = 'CONTRADICTORY_CASE' AND NEW.stance = 'SUPPORTS' THEN
    RAISE EXCEPTION 'helm_causal_evidence_links: a CONTRADICTORY_CASE is evidence against a claim; it cannot support one';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_correlation_findings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_causal_variables v WHERE v.org_id = NEW.org_id AND v.key = NEW.x_key)
     OR NOT EXISTS (SELECT 1 FROM public.helm_causal_variables v WHERE v.org_id = NEW.org_id AND v.key = NEW.y_key) THEN
    RAISE EXCEPTION 'helm_correlation_findings: a finding names two causal variables of its own organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_causal_questions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'helm_causal_questions' THEN
    IF NOT EXISTS (SELECT 1 FROM public.helm_causal_variables v WHERE v.org_id = NEW.org_id AND v.key = NEW.target->>'variableKey') THEN
      RAISE EXCEPTION 'helm_causal_questions: the question targets a variable that is not in this organization';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.helm_causal_questions q WHERE q.id = NEW.question_id AND q.org_id = NEW.org_id)
       OR NOT EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = NEW.claim_id AND c.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'helm_causal_question_candidates: a candidate is an existing claim of the question''s organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_causal_variables_record ON public.helm_causal_variables;
CREATE TRIGGER helm_causal_variables_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_variables FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_claims_record ON public.helm_causal_claims;
CREATE TRIGGER helm_causal_claims_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_claims FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_claims_guard ON public.helm_causal_claims;
CREATE TRIGGER helm_causal_claims_guard BEFORE INSERT ON public.helm_causal_claims FOR EACH ROW EXECUTE FUNCTION public.helm_causal_claims_guard();
DROP TRIGGER IF EXISTS helm_causal_revisions_record ON public.helm_causal_claim_revisions;
CREATE TRIGGER helm_causal_revisions_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_claim_revisions FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_revisions_guard ON public.helm_causal_claim_revisions;
CREATE TRIGGER helm_causal_revisions_guard BEFORE INSERT ON public.helm_causal_claim_revisions FOR EACH ROW EXECUTE FUNCTION public.helm_causal_revisions_guard();
DROP TRIGGER IF EXISTS helm_causal_evidence_record ON public.helm_causal_evidence;
CREATE TRIGGER helm_causal_evidence_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_evidence FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_evidence_guard ON public.helm_causal_evidence;
CREATE TRIGGER helm_causal_evidence_guard BEFORE INSERT ON public.helm_causal_evidence FOR EACH ROW EXECUTE FUNCTION public.helm_causal_evidence_guard();
DROP TRIGGER IF EXISTS helm_causal_links_record ON public.helm_causal_evidence_links;
CREATE TRIGGER helm_causal_links_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_evidence_links FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_links_guard ON public.helm_causal_evidence_links;
CREATE TRIGGER helm_causal_links_guard BEFORE INSERT ON public.helm_causal_evidence_links FOR EACH ROW EXECUTE FUNCTION public.helm_causal_links_guard();
DROP TRIGGER IF EXISTS helm_correlation_findings_record ON public.helm_correlation_findings;
CREATE TRIGGER helm_correlation_findings_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_correlation_findings FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_correlation_findings_guard ON public.helm_correlation_findings;
CREATE TRIGGER helm_correlation_findings_guard BEFORE INSERT ON public.helm_correlation_findings FOR EACH ROW EXECUTE FUNCTION public.helm_correlation_findings_guard();
DROP TRIGGER IF EXISTS helm_causal_questions_record ON public.helm_causal_questions;
CREATE TRIGGER helm_causal_questions_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_questions FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_questions_guard ON public.helm_causal_questions;
CREATE TRIGGER helm_causal_questions_guard BEFORE INSERT ON public.helm_causal_questions FOR EACH ROW EXECUTE FUNCTION public.helm_causal_questions_guard();
DROP TRIGGER IF EXISTS helm_causal_candidates_record ON public.helm_causal_question_candidates;
CREATE TRIGGER helm_causal_candidates_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_causal_question_candidates FOR EACH ROW EXECUTE FUNCTION public.helm_causal_record_guard();
DROP TRIGGER IF EXISTS helm_causal_candidates_guard ON public.helm_causal_question_candidates;
CREATE TRIGGER helm_causal_candidates_guard BEFORE INSERT ON public.helm_causal_question_candidates FOR EACH ROW EXECUTE FUNCTION public.helm_causal_questions_guard();

-- Every claim is committed with its revision 1.
CREATE OR REPLACE FUNCTION public.helm_causal_claim_complete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_causal_claim_revisions r WHERE r.claim_id = NEW.id AND r.revision = 1) THEN
    RAISE EXCEPTION 'helm_causal_claims: a claim is recorded together with its first revision';
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS helm_causal_claim_complete_guard ON public.helm_causal_claims;
CREATE CONSTRAINT TRIGGER helm_causal_claim_complete_guard
  AFTER INSERT ON public.helm_causal_claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.helm_causal_claim_complete_guard();

-- ====================================================================== PART 5

-- Every piece of evidence behind a claim: what is linked, and every correction of it.
CREATE OR REPLACE FUNCTION helm_private.causal_claim_evidence(p_claim uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH RECURSIVE chain(id) AS (
    SELECT l.evidence_id FROM public.helm_causal_evidence_links l WHERE l.claim_id = p_claim
    UNION
    SELECT e.id FROM public.helm_causal_evidence e JOIN chain c ON e.supersedes_id = c.id
  )
  SELECT id FROM chain;
$fn$;

-- A claim's effective classes (ADR-0026 §7): declared, its variables', its evidence's.
CREATE OR REPLACE FUNCTION helm_private.causal_claim_classes(p_claim uuid)
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(array_agg(DISTINCT k ORDER BY k), '{}') FROM (
    SELECT c.sensitivity AS k FROM public.helm_causal_claims c WHERE c.id = p_claim
    UNION ALL
    SELECT v.sensitivity FROM public.helm_causal_claims c
      JOIN public.helm_causal_variables v ON v.org_id = c.org_id AND v.key IN (c.cause_key, c.effect_key)
      WHERE c.id = p_claim
    UNION ALL
    SELECT e.sensitivity FROM public.helm_causal_evidence e WHERE e.id IN (SELECT helm_private.causal_claim_evidence(p_claim))
  ) classes;
$fn$;

-- Decisions a claim rests on: named by any of its revisions, or by its evidence.
CREATE OR REPLACE FUNCTION helm_private.causal_claim_decisions(p_claim uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT DISTINCT d::uuid FROM (
    SELECT CASE WHEN ref->>'kind' = 'DECISION' THEN ref->>'id' WHEN ref->>'kind' = 'ASSUMPTION' THEN ref->>'pin' END AS d
    FROM public.helm_causal_claim_revisions r, jsonb_array_elements(r.links) ref
    WHERE r.claim_id = p_claim
    UNION ALL
    SELECT ref->>'id'
    FROM public.helm_causal_evidence e, jsonb_array_elements(e.refs) ref
    WHERE e.id IN (SELECT helm_private.causal_claim_evidence(p_claim)) AND ref->>'kind' = 'DECISION'
  ) x
  WHERE d ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$fn$;

-- A claim is read whole or not at all: its unit audience, every class it
-- carries, and every decision it rests on. A withheld claim is withheld with
-- its title, so a confidential decision never leaks through a causal claim.
--
-- The rule takes the ROW's own columns, not an id to look up: a policy that
-- re-reads the row by id cannot see a row being inserted in the same statement
-- (a STABLE helper reads the statement's snapshot), so INSERT … RETURNING —
-- how every client write reads its own record back — would be refused. The
-- by-id helpers below wrap the row rules for policies that reference a claim
-- that already exists.
CREATE OR REPLACE FUNCTION helm_private.causal_claim_row_visible(
  p_org uuid, p_claim uuid, p_visibility text, p_authored_by uuid, p_units uuid[], p_sensitivity text, p_cause text, p_effect text
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
        AND helm_private.has_clearance(p_org, p_sensitivity)
        AND NOT EXISTS (
          SELECT 1 FROM public.helm_causal_variables v
          WHERE v.org_id = p_org AND v.key IN (p_cause, p_effect) AND NOT helm_private.has_clearance(p_org, v.sensitivity)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.helm_causal_evidence e
          WHERE e.id IN (SELECT helm_private.causal_claim_evidence(p_claim)) AND NOT helm_private.has_clearance(p_org, e.sensitivity)
        )
        AND NOT EXISTS (SELECT 1 FROM helm_private.causal_claim_decisions(p_claim) d WHERE NOT helm_private.can_see_decision(d))
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_causal_claim(p_claim uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.causal_claim_row_visible(c.org_id, c.id, c.visibility, c.authored_by, c.granted_unit_ids, c.sensitivity, c.cause_key, c.effect_key)
    FROM public.helm_causal_claims c WHERE c.id = p_claim
  ), false);
$fn$;

CREATE OR REPLACE FUNCTION helm_private.causal_evidence_row_visible(p_org uuid, p_sensitivity text, p_refs jsonb)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND helm_private.has_clearance(p_org, p_sensitivity)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) ref
      WHERE ref->>'kind' = 'DECISION'
        AND ref->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND NOT helm_private.can_see_decision((ref->>'id')::uuid)
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_causal_evidence(p_evidence uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.causal_evidence_row_visible(e.org_id, e.sensitivity, e.refs) FROM public.helm_causal_evidence e WHERE e.id = p_evidence
  ), false);
$fn$;

CREATE OR REPLACE FUNCTION helm_private.causal_question_row_visible(p_org uuid, p_asked_by uuid, p_units uuid[], p_target jsonb)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT public.is_org_member(p_org)
    AND (
      public.has_org_role(p_org, 'admin')
      OR p_asked_by = auth.uid()
      OR cardinality(p_units) = 0
      OR EXISTS (SELECT 1 FROM unnest(p_units) g(unit_id) WHERE g.unit_id IN (SELECT helm_private.visible_org_units(p_org)))
    )
    AND (p_target->>'toSnapshotId' IS NULL OR helm_private.can_see_twin_snapshot((p_target->>'toSnapshotId')::uuid))
    AND (p_target->>'fromSnapshotId' IS NULL OR helm_private.can_see_twin_snapshot((p_target->>'fromSnapshotId')::uuid));
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_causal_question(p_question uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.causal_question_row_visible(q.org_id, q.asked_by, q.granted_unit_ids, q.target) FROM public.helm_causal_questions q WHERE q.id = p_question
  ), false);
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

ALTER TABLE public.helm_causal_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_claim_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_correlation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_causal_question_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Scoped read causal variables" ON public.helm_causal_variables;
CREATE POLICY "Scoped read causal variables" ON public.helm_causal_variables
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.has_clearance(org_id, sensitivity));
DROP POLICY IF EXISTS "Members define causal variables" ON public.helm_causal_variables;
CREATE POLICY "Members define causal variables" ON public.helm_causal_variables
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND recorded_by = (select auth.uid()) AND helm_private.has_clearance(org_id, sensitivity));

DROP POLICY IF EXISTS "Scoped read causal claims" ON public.helm_causal_claims;
CREATE POLICY "Scoped read causal claims" ON public.helm_causal_claims
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.causal_claim_row_visible(org_id, id, visibility, authored_by, granted_unit_ids, sensitivity, cause_key, effect_key));
DROP POLICY IF EXISTS "Members author causal claims" ON public.helm_causal_claims;
CREATE POLICY "Members author causal claims" ON public.helm_causal_claims
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND authored_by = (select auth.uid()) AND helm_private.has_clearance(org_id, sensitivity));

DROP POLICY IF EXISTS "Scoped read causal revisions" ON public.helm_causal_claim_revisions;
CREATE POLICY "Scoped read causal revisions" ON public.helm_causal_claim_revisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_causal_claim(claim_id));
-- Revising takes a reader of the claim; retiring takes its author or an admin.
DROP POLICY IF EXISTS "Readers revise causal claims" ON public.helm_causal_claim_revisions;
CREATE POLICY "Readers revise causal claims" ON public.helm_causal_claim_revisions
  FOR INSERT TO authenticated WITH CHECK (
    public.has_org_role(org_id, 'member')
    AND recorded_by = (select auth.uid())
    AND (
      revision = 1
      AND EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = claim_id AND c.authored_by = (select auth.uid()))
      OR revision > 1 AND helm_private.can_see_causal_claim(claim_id)
    )
    AND (
      NOT retired
      OR public.has_org_role(org_id, 'admin')
      OR EXISTS (SELECT 1 FROM public.helm_causal_claims c WHERE c.id = claim_id AND c.authored_by = (select auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Scoped read causal evidence" ON public.helm_causal_evidence;
CREATE POLICY "Scoped read causal evidence" ON public.helm_causal_evidence
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.causal_evidence_row_visible(org_id, sensitivity, refs));
DROP POLICY IF EXISTS "Members record causal evidence" ON public.helm_causal_evidence;
CREATE POLICY "Members record causal evidence" ON public.helm_causal_evidence
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND recorded_by = (select auth.uid()) AND helm_private.has_clearance(org_id, sensitivity));

DROP POLICY IF EXISTS "Scoped read causal links" ON public.helm_causal_evidence_links;
CREATE POLICY "Scoped read causal links" ON public.helm_causal_evidence_links
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_causal_claim(claim_id) AND helm_private.can_see_causal_evidence(evidence_id));
DROP POLICY IF EXISTS "Readers link causal evidence" ON public.helm_causal_evidence_links;
CREATE POLICY "Readers link causal evidence" ON public.helm_causal_evidence_links
  FOR INSERT TO authenticated WITH CHECK (
    public.has_org_role(org_id, 'member') AND linked_by = (select auth.uid())
    AND helm_private.can_see_causal_claim(claim_id) AND helm_private.can_see_causal_evidence(evidence_id)
  );

DROP POLICY IF EXISTS "Scoped read correlation findings" ON public.helm_correlation_findings;
CREATE POLICY "Scoped read correlation findings" ON public.helm_correlation_findings
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.has_clearance(org_id, sensitivity));
DROP POLICY IF EXISTS "Members record correlation findings" ON public.helm_correlation_findings;
CREATE POLICY "Members record correlation findings" ON public.helm_correlation_findings
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND recorded_by = (select auth.uid()) AND helm_private.has_clearance(org_id, sensitivity));

DROP POLICY IF EXISTS "Scoped read causal questions" ON public.helm_causal_questions;
CREATE POLICY "Scoped read causal questions" ON public.helm_causal_questions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.causal_question_row_visible(org_id, asked_by, granted_unit_ids, target));
DROP POLICY IF EXISTS "Members ask causal questions" ON public.helm_causal_questions;
CREATE POLICY "Members ask causal questions" ON public.helm_causal_questions
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND asked_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read causal candidates" ON public.helm_causal_question_candidates;
CREATE POLICY "Scoped read causal candidates" ON public.helm_causal_question_candidates
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_causal_question(question_id) AND helm_private.can_see_causal_claim(claim_id));
DROP POLICY IF EXISTS "Readers propose causal candidates" ON public.helm_causal_question_candidates;
CREATE POLICY "Readers propose causal candidates" ON public.helm_causal_question_candidates
  FOR INSERT TO authenticated WITH CHECK (
    public.has_org_role(org_id, 'member') AND proposed_by = (select auth.uid())
    AND helm_private.can_see_causal_question(question_id) AND helm_private.can_see_causal_claim(claim_id)
  );

-- ====================================================================== PART 6

-- A claim and its revision 1 in one transaction. SECURITY INVOKER: it writes
-- under the caller's own RLS and grants nothing.
CREATE OR REPLACE FUNCTION public.helm_record_causal_claim(p_claim jsonb, p_revision jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.helm_causal_claims (
    org_id, cause_key, effect_key, relationship_type, target_claim_id, scope, conditions, applicable_from, applicable_to,
    sensitivity, visibility, granted_unit_ids, authored_by, authored_by_label
  ) VALUES (
    (p_claim->>'org_id')::uuid, p_claim->>'cause_key', p_claim->>'effect_key', p_claim->>'relationship_type',
    nullif(p_claim->>'target_claim_id', '')::uuid, p_claim->'scope', coalesce(p_claim->'conditions', '[]'::jsonb),
    nullif(p_claim->>'applicable_from', '')::timestamptz, nullif(p_claim->>'applicable_to', '')::timestamptz,
    p_claim->>'sensitivity', coalesce(p_claim->>'visibility', 'ORG_WIDE'),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_claim->'granted_unit_ids', '[]'::jsonb))::uuid),
    auth.uid(), p_claim->>'authored_by_label'
  )
  RETURNING id INTO new_id;

  INSERT INTO public.helm_causal_claim_revisions (
    org_id, claim_id, revision, statement, mechanism, confounders, rationale, external_validity, links, retired, retirement_reason, recorded_by
  ) VALUES (
    (p_claim->>'org_id')::uuid, new_id, 1, p_revision->>'statement', coalesce(p_revision->'mechanism', '[]'::jsonb),
    coalesce(p_revision->'confounders', '[]'::jsonb), p_revision->>'rationale', coalesce(p_revision->>'external_validity', ''),
    coalesce(p_revision->'links', '[]'::jsonb), false, NULL, auth.uid()
  );
  RETURN new_id;
END;
$fn$;

REVOKE ALL ON TABLE
  public.helm_causal_variables, public.helm_causal_claims, public.helm_causal_claim_revisions, public.helm_causal_evidence,
  public.helm_causal_evidence_links, public.helm_correlation_findings, public.helm_causal_questions, public.helm_causal_question_candidates
FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE
  public.helm_causal_variables, public.helm_causal_claims, public.helm_causal_claim_revisions, public.helm_causal_evidence,
  public.helm_causal_evidence_links, public.helm_correlation_findings, public.helm_causal_questions, public.helm_causal_question_candidates
TO authenticated;
-- Supabase's default privileges give signed-in clients UPDATE and DELETE on
-- every new public table. RLS would match no row (there is no such policy),
-- but an append-only record should not carry the privilege at all.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.helm_causal_variables, public.helm_causal_claims, public.helm_causal_claim_revisions, public.helm_causal_evidence,
  public.helm_causal_evidence_links, public.helm_correlation_findings, public.helm_causal_questions, public.helm_causal_question_candidates
FROM authenticated;
GRANT ALL ON TABLE
  public.helm_causal_variables, public.helm_causal_claims, public.helm_causal_claim_revisions, public.helm_causal_evidence,
  public.helm_causal_evidence_links, public.helm_correlation_findings, public.helm_causal_questions, public.helm_causal_question_candidates
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_causal_record_guard(), public.helm_causal_claims_guard(), public.helm_causal_revisions_guard(),
  public.helm_causal_evidence_guard(), public.helm_causal_links_guard(), public.helm_correlation_findings_guard(),
  public.helm_causal_questions_guard(), public.helm_causal_claim_complete_guard(), public.helm_record_causal_claim(jsonb, jsonb)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_record_causal_claim(jsonb, jsonb) TO authenticated, service_role;
