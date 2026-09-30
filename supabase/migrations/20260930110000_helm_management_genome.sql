-- ============================================================================
-- HELM Phase 9 — Management Genome
-- ============================================================================
--
-- ADR-0028 (organizational memory of situations, beliefs, choices, outcomes).
--
--   PART 1  episodes and their bound references
--   PART 2  patterns, their revisions, and the episodes people link to them
--   PART 3  lessons and their reviews
--   PART 4  guards: write-once, record time stamped by the database, same-org
--           references, sequential pattern revisions, one link per (pattern,
--           episode), a stance that agrees with what HELM observed, no
--           self-endorsement of a lesson
--   PART 5  helm_private row rules and scoped RLS (row-based: a read policy
--           never re-reads its own row by id, so INSERT … RETURNING works)
--   PART 6  the atomic pattern writer, grants
--   PART 7  the one read path the constraints do not already index
--
-- Decision Process Quality ≠ Outcome Quality. Nothing here stores a score of a
-- decision, a rating of a person, or a pattern's status (derived at a lens).
-- Nothing references a person as a feature, and nothing here writes a decision,
-- a calculation, a causal claim or an authority rule.
--
-- Additive for Memoire: every statement is on a helm_* object or in
-- helm_private; the shared-core membership tables are only READ.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_genome_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  -- Null for a decision that was framed and never committed.
  commitment_id uuid REFERENCES public.helm_decision_commitments(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  scope jsonb NOT NULL,
  -- Structured features derived from kernel records at the decision boundary.
  situation jsonb NOT NULL CHECK (jsonb_typeof(situation->'values') = 'object'),
  -- The knowledge boundary management decided under.
  boundary_effective timestamptz NOT NULL,
  boundary_recorded timestamptz NOT NULL,
  -- Derived from the metrics the commitment expects to move — never declared.
  sensitivity_classes text[] NOT NULL CHECK (sensitivity_classes <@ ARRAY['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED']),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  authored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  authored_by_label text NOT NULL CHECK (char_length(btrim(authored_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_genome_episodes_scoped CHECK (
    (scope->>'kind' = 'ANCHORED' AND jsonb_typeof(scope->'anchors') = 'array')
    OR (scope->>'kind' = 'ENTERPRISE_WIDE' AND char_length(btrim(coalesce(scope->>'justification', ''))) >= 12)
  ),
  CONSTRAINT helm_genome_episodes_boundary_ordered CHECK (boundary_effective <= boundary_recorded)
);
-- One container per management experience.
CREATE UNIQUE INDEX IF NOT EXISTS helm_genome_episodes_one_per_commitment ON public.helm_genome_episodes (commitment_id) WHERE commitment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS helm_genome_episodes_decision_idx ON public.helm_genome_episodes (org_id, decision_id);

CREATE TABLE IF NOT EXISTS public.helm_genome_episode_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.helm_genome_episodes(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'CAUSAL_CONTEXT', 'GOVERNANCE_EVALUATION', 'OUTCOME_REVIEW')),
  -- A pointer to an existing immutable artifact. The episode copies nothing.
  ref jsonb NOT NULL CHECK (jsonb_typeof(ref) = 'object' AND char_length(btrim(coalesce(ref->>'kind', ''))) >= 1 AND char_length(btrim(coalesce(ref->>'id', ''))) >= 1),
  note text,
  bound_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS helm_genome_episode_refs_once ON public.helm_genome_episode_refs (episode_id, role, (ref->>'id'));

-- ====================================================================== PART 2

CREATE TABLE IF NOT EXISTS public.helm_genome_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  -- Where it holds: never global by default.
  scope jsonb NOT NULL,
  -- Situation features that must hold. Nothing here is about a person.
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(conditions) = 'object'),
  -- One OBSERVABLE characteristic, so HELM can check any episode against it.
  characteristic jsonb NOT NULL CHECK (characteristic->>'kind' IN ('OUTCOME_VS_EXPECTATION', 'ASSUMPTION_OUTCOME', 'PROCESS_FEATURE')),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  authored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  authored_by_label text NOT NULL CHECK (char_length(btrim(authored_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_genome_patterns_scoped CHECK (
    (scope->>'kind' = 'ANCHORED' AND jsonb_typeof(scope->'anchors') = 'array' AND jsonb_array_length(scope->'anchors') >= 1)
    OR (scope->>'kind' = 'ENTERPRISE_WIDE' AND char_length(btrim(coalesce(scope->>'justification', ''))) >= 12)
  )
);

CREATE TABLE IF NOT EXISTS public.helm_genome_pattern_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES public.helm_genome_patterns(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  statement text NOT NULL CHECK (char_length(btrim(statement)) >= 1),
  -- What the pattern does NOT show. Required, every revision.
  limitations text NOT NULL CHECK (char_length(btrim(limitations)) >= 1),
  retired boolean NOT NULL DEFAULT false,
  retirement_reason text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pattern_id, revision),
  CONSTRAINT helm_genome_pattern_revisions_retirement_explained CHECK (NOT retired OR char_length(btrim(coalesce(retirement_reason, ''))) >= 1)
);

-- A person's link of one episode to one pattern. The stance must agree with
-- what HELM's own records said when it was made.
CREATE TABLE IF NOT EXISTS public.helm_genome_pattern_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES public.helm_genome_patterns(id) ON DELETE RESTRICT,
  episode_id uuid NOT NULL REFERENCES public.helm_genome_episodes(id) ON DELETE RESTRICT,
  stance text NOT NULL CHECK (stance IN ('SUPPORTING_EPISODE', 'CONTRADICTORY_EPISODE', 'CONTEXTUAL_EPISODE')),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) >= 1),
  observed text NOT NULL CHECK (observed IN ('SUPPORTS', 'CONTRADICTS', 'OUT_OF_SCOPE', 'NOT_OBSERVABLE')),
  linked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pattern_id, episode_id),
  CONSTRAINT helm_genome_pattern_evidence_stance_agrees CHECK (
    (stance = 'SUPPORTING_EPISODE' AND observed = 'SUPPORTS')
    OR (stance = 'CONTRADICTORY_EPISODE' AND observed = 'CONTRADICTS')
    OR stance = 'CONTEXTUAL_EPISODE'
  )
);
CREATE INDEX IF NOT EXISTS helm_genome_pattern_evidence_episode_idx ON public.helm_genome_pattern_evidence (episode_id);

-- ====================================================================== PART 3

CREATE TABLE IF NOT EXISTS public.helm_genome_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  claim text NOT NULL CHECK (char_length(btrim(claim)) >= 1),
  scope jsonb NOT NULL,
  -- At least one episode or pattern the lesson rests on. Inert: nothing consumes it.
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  authored_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  authored_by_label text NOT NULL CHECK (char_length(btrim(authored_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_genome_lessons_scoped CHECK (
    (scope->>'kind' = 'ANCHORED' AND jsonb_typeof(scope->'anchors') = 'array' AND jsonb_array_length(scope->'anchors') >= 1)
    OR (scope->>'kind' = 'ENTERPRISE_WIDE' AND char_length(btrim(coalesce(scope->>'justification', ''))) >= 12)
  )
);

-- PROPOSED is the absence of a review.
CREATE TABLE IF NOT EXISTS public.helm_genome_lesson_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES public.helm_genome_lessons(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ENDORSED', 'DISPUTED', 'RETIRED')),
  note text NOT NULL CHECK (char_length(btrim(note)) >= 1),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  reviewed_by_label text NOT NULL CHECK (char_length(btrim(reviewed_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ====================================================================== PART 4

CREATE OR REPLACE FUNCTION public.helm_genome_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: the genome is append-only; a change is a new revision, a new link or a new review', TG_TABLE_NAME;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_genome_episodes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_decisions d WHERE d.id = NEW.decision_id AND d.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_genome_episodes: the decision is not in this organization';
  END IF;
  IF NEW.commitment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.helm_decision_commitments c WHERE c.id = NEW.commitment_id AND c.org_id = NEW.org_id AND c.decision_id = NEW.decision_id) THEN
    RAISE EXCEPTION 'helm_genome_episodes: the commitment does not belong to this decision';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_genome_episode_refs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_genome_episodes e WHERE e.id = NEW.episode_id AND e.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_genome_episode_refs: the episode is not in this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_genome_pattern_revisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  last_rev integer;
  last_retired boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_genome_patterns p WHERE p.id = NEW.pattern_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_genome_pattern_revisions: the pattern is not in this organization';
  END IF;
  SELECT r.revision, r.retired INTO last_rev, last_retired
  FROM public.helm_genome_pattern_revisions r WHERE r.pattern_id = NEW.pattern_id ORDER BY r.revision DESC LIMIT 1;
  IF coalesce(last_retired, false) THEN
    RAISE EXCEPTION 'helm_genome_pattern_revisions: the pattern is retired; author a new pattern';
  END IF;
  IF NEW.revision <> coalesce(last_rev, 0) + 1 THEN
    RAISE EXCEPTION 'helm_genome_pattern_revisions: revision % follows %; revisions are sequential and never rewritten', NEW.revision, coalesce(last_rev, 0);
  END IF;
  IF NEW.revision = 1 AND NEW.retired THEN
    RAISE EXCEPTION 'helm_genome_pattern_revisions: a pattern cannot be created retired';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_genome_pattern_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  latest_retired boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_genome_patterns p WHERE p.id = NEW.pattern_id AND p.org_id = NEW.org_id)
     OR NOT EXISTS (SELECT 1 FROM public.helm_genome_episodes e WHERE e.id = NEW.episode_id AND e.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_genome_pattern_evidence: the pattern and the episode are in this organization';
  END IF;
  SELECT r.retired INTO latest_retired FROM public.helm_genome_pattern_revisions r WHERE r.pattern_id = NEW.pattern_id ORDER BY r.revision DESC LIMIT 1;
  IF coalesce(latest_retired, false) THEN
    RAISE EXCEPTION 'helm_genome_pattern_evidence: the pattern is retired; it takes no further episode';
  END IF;
  RETURN NEW;
END;
$fn$;

-- A lesson rests on episodes or patterns of its own organization — not on free text.
CREATE OR REPLACE FUNCTION public.helm_genome_lessons_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  r jsonb;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(NEW.evidence) LOOP
    IF r->>'kind' = 'MANAGEMENT_EPISODE' THEN
      IF NOT EXISTS (SELECT 1 FROM public.helm_genome_episodes e WHERE e.id::text = r->>'id' AND e.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'helm_genome_lessons: the episode % is not in this organization', r->>'id';
      END IF;
    ELSIF r->>'kind' = 'MANAGEMENT_PATTERN' THEN
      IF NOT EXISTS (SELECT 1 FROM public.helm_genome_patterns p WHERE p.id::text = r->>'id' AND p.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'helm_genome_lessons: the pattern % is not in this organization', r->>'id';
      END IF;
    ELSE
      RAISE EXCEPTION 'helm_genome_lessons: a lesson rests on episodes or patterns of this genome, not on a %', r->>'kind';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_genome_lesson_reviews_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  author uuid;
BEGIN
  SELECT l.authored_by INTO author FROM public.helm_genome_lessons l WHERE l.id = NEW.lesson_id AND l.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm_genome_lesson_reviews: the lesson is not in this organization';
  END IF;
  IF NEW.status = 'ENDORSED' AND NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = author THEN
    RAISE EXCEPTION 'helm_genome_lesson_reviews: an author cannot endorse their own lesson; someone else reviews it';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Every pattern is committed with its revision 1.
CREATE OR REPLACE FUNCTION public.helm_genome_pattern_complete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_genome_pattern_revisions r WHERE r.pattern_id = NEW.id AND r.revision = 1) THEN
    RAISE EXCEPTION 'helm_genome_patterns: a pattern is recorded together with its first revision';
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_genome_episodes_record ON public.helm_genome_episodes;
CREATE TRIGGER helm_genome_episodes_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_episodes FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_episodes_guard ON public.helm_genome_episodes;
CREATE TRIGGER helm_genome_episodes_guard BEFORE INSERT ON public.helm_genome_episodes FOR EACH ROW EXECUTE FUNCTION public.helm_genome_episodes_guard();
DROP TRIGGER IF EXISTS helm_genome_episode_refs_record ON public.helm_genome_episode_refs;
CREATE TRIGGER helm_genome_episode_refs_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_episode_refs FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_episode_refs_guard ON public.helm_genome_episode_refs;
CREATE TRIGGER helm_genome_episode_refs_guard BEFORE INSERT ON public.helm_genome_episode_refs FOR EACH ROW EXECUTE FUNCTION public.helm_genome_episode_refs_guard();
DROP TRIGGER IF EXISTS helm_genome_patterns_record ON public.helm_genome_patterns;
CREATE TRIGGER helm_genome_patterns_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_patterns FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_pattern_revisions_record ON public.helm_genome_pattern_revisions;
CREATE TRIGGER helm_genome_pattern_revisions_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_pattern_revisions FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_pattern_revisions_guard ON public.helm_genome_pattern_revisions;
CREATE TRIGGER helm_genome_pattern_revisions_guard BEFORE INSERT ON public.helm_genome_pattern_revisions FOR EACH ROW EXECUTE FUNCTION public.helm_genome_pattern_revisions_guard();
DROP TRIGGER IF EXISTS helm_genome_pattern_evidence_record ON public.helm_genome_pattern_evidence;
CREATE TRIGGER helm_genome_pattern_evidence_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_pattern_evidence FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_pattern_evidence_guard ON public.helm_genome_pattern_evidence;
CREATE TRIGGER helm_genome_pattern_evidence_guard BEFORE INSERT ON public.helm_genome_pattern_evidence FOR EACH ROW EXECUTE FUNCTION public.helm_genome_pattern_evidence_guard();
DROP TRIGGER IF EXISTS helm_genome_lessons_record ON public.helm_genome_lessons;
CREATE TRIGGER helm_genome_lessons_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_lessons FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_lessons_guard ON public.helm_genome_lessons;
CREATE TRIGGER helm_genome_lessons_guard BEFORE INSERT ON public.helm_genome_lessons FOR EACH ROW EXECUTE FUNCTION public.helm_genome_lessons_guard();
DROP TRIGGER IF EXISTS helm_genome_lesson_reviews_record ON public.helm_genome_lesson_reviews;
CREATE TRIGGER helm_genome_lesson_reviews_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_genome_lesson_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_genome_record_guard();
DROP TRIGGER IF EXISTS helm_genome_lesson_reviews_guard ON public.helm_genome_lesson_reviews;
CREATE TRIGGER helm_genome_lesson_reviews_guard BEFORE INSERT ON public.helm_genome_lesson_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_genome_lesson_reviews_guard();

DROP TRIGGER IF EXISTS helm_genome_pattern_complete_guard ON public.helm_genome_patterns;
CREATE CONSTRAINT TRIGGER helm_genome_pattern_complete_guard
  AFTER INSERT ON public.helm_genome_patterns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.helm_genome_pattern_complete_guard();

-- ====================================================================== PART 5

ALTER TABLE public.helm_genome_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_episode_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_pattern_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_pattern_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_genome_lesson_reviews ENABLE ROW LEVEL SECURITY;

-- An episode is read whole or not at all: its unit audience, every sensitivity
-- class it carries, and the decision it wraps. Written over the row's own
-- columns so INSERT … RETURNING works.
CREATE OR REPLACE FUNCTION helm_private.genome_episode_row_visible(
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

CREATE OR REPLACE FUNCTION helm_private.can_see_genome_episode(p_episode uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.genome_episode_row_visible(e.org_id, e.decision_id, e.visibility, e.authored_by, e.granted_unit_ids, e.sensitivity_classes)
    FROM public.helm_genome_episodes e WHERE e.id = p_episode
  ), false);
$fn$;

-- A pattern is read whole or not at all: its unit audience and EVERY episode it
-- has been linked to. A pattern resting on an episode the viewer cannot read is
-- withheld, title included.
CREATE OR REPLACE FUNCTION helm_private.genome_pattern_row_visible(
  p_org uuid, p_pattern uuid, p_visibility text, p_authored_by uuid, p_units uuid[]
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
        AND NOT EXISTS (
          SELECT 1 FROM public.helm_genome_pattern_evidence e
          WHERE e.pattern_id = p_pattern AND NOT helm_private.can_see_genome_episode(e.episode_id)
        )
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_genome_pattern(p_pattern uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.genome_pattern_row_visible(p.org_id, p.id, p.visibility, p.authored_by, p.granted_unit_ids)
    FROM public.helm_genome_patterns p WHERE p.id = p_pattern
  ), false);
$fn$;

-- A lesson likewise: its unit audience and every episode or pattern it rests on.
CREATE OR REPLACE FUNCTION helm_private.genome_lesson_row_visible(
  p_org uuid, p_visibility text, p_authored_by uuid, p_units uuid[], p_evidence jsonb
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
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_evidence) r
          WHERE r->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND CASE r->>'kind'
                  WHEN 'MANAGEMENT_EPISODE' THEN NOT helm_private.can_see_genome_episode((r->>'id')::uuid)
                  WHEN 'MANAGEMENT_PATTERN' THEN NOT helm_private.can_see_genome_pattern((r->>'id')::uuid)
                  ELSE true
                END
        )
      )
    );
$fn$;

CREATE OR REPLACE FUNCTION helm_private.can_see_genome_lesson(p_lesson uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.genome_lesson_row_visible(l.org_id, l.visibility, l.authored_by, l.granted_unit_ids, l.evidence)
    FROM public.helm_genome_lessons l WHERE l.id = p_lesson
  ), false);
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

DROP POLICY IF EXISTS "Scoped read genome episodes" ON public.helm_genome_episodes;
CREATE POLICY "Scoped read genome episodes" ON public.helm_genome_episodes
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.genome_episode_row_visible(org_id, decision_id, visibility, authored_by, granted_unit_ids, sensitivity_classes));
DROP POLICY IF EXISTS "Members open genome episodes" ON public.helm_genome_episodes;
CREATE POLICY "Members open genome episodes" ON public.helm_genome_episodes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND authored_by = (select auth.uid())
    AND helm_private.can_see_decision(decision_id)
    AND NOT EXISTS (SELECT 1 FROM unnest(sensitivity_classes) k WHERE NOT helm_private.has_clearance(org_id, k))
  );

DROP POLICY IF EXISTS "Scoped read genome episode refs" ON public.helm_genome_episode_refs;
CREATE POLICY "Scoped read genome episode refs" ON public.helm_genome_episode_refs
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_genome_episode(episode_id));
DROP POLICY IF EXISTS "Readers bind genome episode refs" ON public.helm_genome_episode_refs;
CREATE POLICY "Readers bind genome episode refs" ON public.helm_genome_episode_refs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND bound_by = (select auth.uid()) AND helm_private.can_see_genome_episode(episode_id));

DROP POLICY IF EXISTS "Scoped read genome patterns" ON public.helm_genome_patterns;
CREATE POLICY "Scoped read genome patterns" ON public.helm_genome_patterns
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.genome_pattern_row_visible(org_id, id, visibility, authored_by, granted_unit_ids));
DROP POLICY IF EXISTS "Members author genome patterns" ON public.helm_genome_patterns;
CREATE POLICY "Members author genome patterns" ON public.helm_genome_patterns
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND authored_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read genome pattern revisions" ON public.helm_genome_pattern_revisions;
CREATE POLICY "Scoped read genome pattern revisions" ON public.helm_genome_pattern_revisions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_genome_pattern(pattern_id));
-- Revising takes a reader of the pattern; retiring takes its author or an admin.
DROP POLICY IF EXISTS "Readers revise genome patterns" ON public.helm_genome_pattern_revisions;
CREATE POLICY "Readers revise genome patterns" ON public.helm_genome_pattern_revisions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND recorded_by = (select auth.uid())
    AND (
      revision = 1 AND EXISTS (SELECT 1 FROM public.helm_genome_patterns p WHERE p.id = pattern_id AND p.authored_by = (select auth.uid()))
      OR revision > 1 AND helm_private.can_see_genome_pattern(pattern_id)
    )
    AND (
      NOT retired
      OR public.has_org_role(org_id, 'admin')
      OR EXISTS (SELECT 1 FROM public.helm_genome_patterns p WHERE p.id = pattern_id AND p.authored_by = (select auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Scoped read genome pattern evidence" ON public.helm_genome_pattern_evidence;
CREATE POLICY "Scoped read genome pattern evidence" ON public.helm_genome_pattern_evidence
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.can_see_genome_pattern(pattern_id) AND helm_private.can_see_genome_episode(episode_id));
DROP POLICY IF EXISTS "Readers link genome pattern evidence" ON public.helm_genome_pattern_evidence;
CREATE POLICY "Readers link genome pattern evidence" ON public.helm_genome_pattern_evidence
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND linked_by = (select auth.uid())
    AND helm_private.can_see_genome_pattern(pattern_id) AND helm_private.can_see_genome_episode(episode_id)
  );

DROP POLICY IF EXISTS "Scoped read genome lessons" ON public.helm_genome_lessons;
CREATE POLICY "Scoped read genome lessons" ON public.helm_genome_lessons
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.genome_lesson_row_visible(org_id, visibility, authored_by, granted_unit_ids, evidence));
DROP POLICY IF EXISTS "Members author genome lessons" ON public.helm_genome_lessons;
CREATE POLICY "Members author genome lessons" ON public.helm_genome_lessons
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member') AND authored_by = (select auth.uid()));

DROP POLICY IF EXISTS "Scoped read genome lesson reviews" ON public.helm_genome_lesson_reviews;
CREATE POLICY "Scoped read genome lesson reviews" ON public.helm_genome_lesson_reviews
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_genome_lesson(lesson_id));
DROP POLICY IF EXISTS "Readers review genome lessons" ON public.helm_genome_lesson_reviews;
CREATE POLICY "Readers review genome lessons" ON public.helm_genome_lesson_reviews
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND reviewed_by = (select auth.uid()) AND helm_private.can_see_genome_lesson(lesson_id));

-- ====================================================================== PART 6

-- A pattern and its revision 1 in one transaction. SECURITY INVOKER: it writes
-- under the caller's own RLS and grants nothing.
CREATE OR REPLACE FUNCTION public.helm_record_genome_pattern(p_pattern jsonb, p_revision jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.helm_genome_patterns (org_id, title, scope, conditions, characteristic, visibility, granted_unit_ids, authored_by, authored_by_label)
  VALUES (
    (p_pattern->>'org_id')::uuid, p_pattern->>'title', p_pattern->'scope', coalesce(p_pattern->'conditions', '{}'::jsonb), p_pattern->'characteristic',
    coalesce(p_pattern->>'visibility', 'ORG_WIDE'),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_pattern->'granted_unit_ids', '[]'::jsonb))::uuid),
    auth.uid(), p_pattern->>'authored_by_label'
  )
  RETURNING id INTO new_id;

  INSERT INTO public.helm_genome_pattern_revisions (org_id, pattern_id, revision, statement, limitations, retired, retirement_reason, recorded_by)
  VALUES ((p_pattern->>'org_id')::uuid, new_id, 1, p_revision->>'statement', p_revision->>'limitations', false, NULL, auth.uid());
  RETURN new_id;
END;
$fn$;

REVOKE ALL ON TABLE
  public.helm_genome_episodes, public.helm_genome_episode_refs, public.helm_genome_patterns, public.helm_genome_pattern_revisions,
  public.helm_genome_pattern_evidence, public.helm_genome_lessons, public.helm_genome_lesson_reviews
FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE
  public.helm_genome_episodes, public.helm_genome_episode_refs, public.helm_genome_patterns, public.helm_genome_pattern_revisions,
  public.helm_genome_pattern_evidence, public.helm_genome_lessons, public.helm_genome_lesson_reviews
TO authenticated;
-- Supabase's default privileges grant UPDATE and DELETE on every new public table.
-- RLS would match no row, but an append-only record should not carry the privilege at all.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.helm_genome_episodes, public.helm_genome_episode_refs, public.helm_genome_patterns, public.helm_genome_pattern_revisions,
  public.helm_genome_pattern_evidence, public.helm_genome_lessons, public.helm_genome_lesson_reviews
FROM authenticated;
GRANT ALL ON TABLE
  public.helm_genome_episodes, public.helm_genome_episode_refs, public.helm_genome_patterns, public.helm_genome_pattern_revisions,
  public.helm_genome_pattern_evidence, public.helm_genome_lessons, public.helm_genome_lesson_reviews
TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_genome_record_guard(), public.helm_genome_episodes_guard(), public.helm_genome_episode_refs_guard(),
  public.helm_genome_pattern_revisions_guard(), public.helm_genome_pattern_evidence_guard(), public.helm_genome_lessons_guard(),
  public.helm_genome_lesson_reviews_guard(), public.helm_genome_pattern_complete_guard(), public.helm_record_genome_pattern(jsonb, jsonb)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_record_genome_pattern(jsonb, jsonb) TO authenticated, service_role;

-- ====================================================================== PART 7

-- Reviews are read by lesson. The other lookup keys (pattern, episode, revision)
-- are already covered by the unique constraints above.
CREATE INDEX IF NOT EXISTS helm_genome_lesson_reviews_lesson_idx ON public.helm_genome_lesson_reviews (lesson_id);
