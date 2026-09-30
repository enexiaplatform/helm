-- ============================================================================
-- HELM — Management Review Loop
-- ============================================================================
--
-- ADR-0031 (the operating cadence as a first-class object).
--
--   PART 1  reviews, review items and review closures
--   PART 2  guards: write-once, record time stamped by the database, a review
--           follows a CLOSED review of the same scope, a closed review takes no
--           more items (it is memory), a review closes once and every item has
--           exactly one disposition — none is left hanging
--   PART 3  helm_private row rules and scoped RLS (row-based, so
--           INSERT … RETURNING works): a review is read whole (its unit
--           audience and every class of its opening state); an item about a
--           decision is read only where the decision can be seen
--   PART 4  grants
--
-- A review BINDS: it references twin snapshots, decisions, commitments, claims
-- and genome memory by id, and copies none of them. Its status and its pack are
-- derived; the stored preparation and closing fingerprints are the check a
-- later recomputation must match. Nothing here decides, commits, approves or
-- executes anything.
--
-- Additive for Memoire: every statement is on a helm_* object or in helm_private.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_management_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) >= 1),
  cadence text NOT NULL CHECK (cadence IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'STRATEGIC')),
  period_label text NOT NULL CHECK (char_length(btrim(period_label)) >= 1),
  scope jsonb NOT NULL CHECK (scope->>'kind' IN ('ENTERPRISE', 'ENTITY')),
  previous_review_id uuid REFERENCES public.helm_management_reviews(id) ON DELETE RESTRICT,
  opening_snapshot_id uuid NOT NULL REFERENCES public.helm_twin_snapshots(id) ON DELETE RESTRICT,
  opening_effective timestamptz NOT NULL,
  opening_recorded timestamptz NOT NULL,
  preparation_fingerprint text NOT NULL CHECK (char_length(btrim(preparation_fingerprint)) >= 1),
  sensitivity_classes text[] NOT NULL CHECK (sensitivity_classes <@ ARRAY['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE', 'COMMERCIAL_CONFIDENTIAL', 'HR_RESTRICTED', 'STRATEGIC_RESTRICTED']),
  visibility text NOT NULL DEFAULT 'ORG_WIDE' CHECK (visibility IN ('ORG_WIDE', 'RESTRICTED')),
  granted_unit_ids uuid[] NOT NULL DEFAULT '{}',
  opened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  opened_by_label text NOT NULL CHECK (char_length(btrim(opened_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_management_reviews_opening_ordered CHECK (opening_effective <= opening_recorded)
);
CREATE INDEX IF NOT EXISTS helm_management_reviews_org_idx ON public.helm_management_reviews (org_id, recorded_at);

CREATE TABLE IF NOT EXISTS public.helm_management_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.helm_management_reviews(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('ATTENTION', 'DECISION', 'COMMITMENT', 'ASSUMPTION', 'ACTION_INTENT', 'EPISODE', 'PATTERN', 'LESSON', 'COUNTERFACTUAL_CASE', 'CAUSAL_CLAIM', 'QUESTION')),
  role text NOT NULL CHECK (role IN ('RAISED', 'FRAMED', 'COMMITTED', 'RECONSIDERED', 'NOTED')),
  -- Only a QUESTION owns its content; everything else is a reference to an object that already exists.
  ref jsonb CHECK (ref IS NULL OR (jsonb_typeof(ref) = 'object' AND ref ? 'id')),
  -- For decision-bound kinds: the decision the reference belongs to, so visibility follows it.
  decision_id uuid REFERENCES public.helm_decisions(id) ON DELETE RESTRICT,
  note text NOT NULL DEFAULT '',
  carried_from_item_id uuid REFERENCES public.helm_management_review_items(id) ON DELETE RESTRICT,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_management_review_items_question_owns_content CHECK (
    (kind = 'QUESTION' AND ref IS NULL AND char_length(btrim(note)) >= 8 AND role = 'RAISED')
    OR (kind <> 'QUESTION' AND ref IS NOT NULL)
  ),
  CONSTRAINT helm_management_review_items_role_fits CHECK (
    (role <> 'COMMITTED' OR kind = 'COMMITMENT') AND (role NOT IN ('FRAMED', 'RECONSIDERED') OR kind = 'DECISION')
  )
);
CREATE INDEX IF NOT EXISTS helm_management_review_items_review_idx ON public.helm_management_review_items (review_id);

CREATE TABLE IF NOT EXISTS public.helm_management_review_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL UNIQUE REFERENCES public.helm_management_reviews(id) ON DELETE RESTRICT,
  closing_snapshot_id uuid NOT NULL REFERENCES public.helm_twin_snapshots(id) ON DELETE RESTRICT,
  closing_effective timestamptz NOT NULL,
  closing_recorded timestamptz NOT NULL,
  closing_fingerprint text NOT NULL CHECK (char_length(btrim(closing_fingerprint)) >= 1),
  summary text NOT NULL CHECK (char_length(btrim(summary)) >= 1),
  dispositions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dispositions) = 'array'),
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  closed_by_label text NOT NULL CHECK (char_length(btrim(closed_by_label)) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helm_management_review_closures_closing_ordered CHECK (closing_effective <= closing_recorded)
);

-- ====================================================================== PART 2

CREATE OR REPLACE FUNCTION public.helm_review_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: review records are append-only; a closed review is memory, and what changes is the next review', TG_TABLE_NAME;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_management_reviews_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  prev record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_twin_snapshots s WHERE s.id = NEW.opening_snapshot_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_management_reviews: the opening snapshot is not in this organization';
  END IF;
  IF NEW.previous_review_id IS NOT NULL THEN
    SELECT r.* INTO prev FROM public.helm_management_reviews r WHERE r.id = NEW.previous_review_id AND r.org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'helm_management_reviews: the previous review is not in this organization';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.helm_management_review_closures c WHERE c.review_id = prev.id) THEN
      RAISE EXCEPTION 'helm_management_reviews: a review follows a closed review; what is still open there is carried forward from its closure';
    END IF;
    IF (prev.scope->>'kind') IS DISTINCT FROM (NEW.scope->>'kind') OR coalesce(prev.scope->>'entityId', '') <> coalesce(NEW.scope->>'entityId', '') THEN
      RAISE EXCEPTION 'helm_management_reviews: the previous review is of another scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_management_review_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.helm_management_reviews r WHERE r.id = NEW.review_id AND r.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_management_review_items: the review is not in this organization';
  END IF;
  IF EXISTS (SELECT 1 FROM public.helm_management_review_closures c WHERE c.review_id = NEW.review_id) THEN
    RAISE EXCEPTION 'helm_management_review_items: a closed review is memory and takes no more items';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.helm_management_review_closures_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  rev record;
BEGIN
  SELECT r.* INTO rev FROM public.helm_management_reviews r WHERE r.id = NEW.review_id AND r.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'helm_management_review_closures: the review is not in this organization';
  END IF;
  IF NEW.closing_recorded < rev.opening_recorded THEN
    RAISE EXCEPTION 'helm_management_review_closures: a review cannot close before it opened';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.helm_twin_snapshots s WHERE s.id = NEW.closing_snapshot_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'helm_management_review_closures: the closing snapshot is not in this organization';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.dispositions) d
    WHERE d->>'disposition' NOT IN ('RESOLVED', 'CARRIED_FORWARD', 'DROPPED') OR char_length(btrim(coalesce(d->>'reason', ''))) < 1
  ) THEN
    RAISE EXCEPTION 'helm_management_review_closures: every disposition is resolved, carried forward or dropped, and says why';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.helm_management_review_items i
    WHERE i.review_id = NEW.review_id
      AND (SELECT count(*) FROM jsonb_array_elements(NEW.dispositions) d WHERE d->>'itemId' = i.id::text) <> 1
  ) THEN
    RAISE EXCEPTION 'helm_management_review_closures: every item of the review needs exactly one disposition — none is left hanging';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_management_reviews_record ON public.helm_management_reviews;
CREATE TRIGGER helm_management_reviews_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_management_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_review_record_guard();
DROP TRIGGER IF EXISTS helm_management_reviews_guard ON public.helm_management_reviews;
CREATE TRIGGER helm_management_reviews_guard BEFORE INSERT ON public.helm_management_reviews FOR EACH ROW EXECUTE FUNCTION public.helm_management_reviews_guard();
DROP TRIGGER IF EXISTS helm_management_review_items_record ON public.helm_management_review_items;
CREATE TRIGGER helm_management_review_items_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_management_review_items FOR EACH ROW EXECUTE FUNCTION public.helm_review_record_guard();
DROP TRIGGER IF EXISTS helm_management_review_items_guard ON public.helm_management_review_items;
CREATE TRIGGER helm_management_review_items_guard BEFORE INSERT ON public.helm_management_review_items FOR EACH ROW EXECUTE FUNCTION public.helm_management_review_items_guard();
DROP TRIGGER IF EXISTS helm_management_review_closures_record ON public.helm_management_review_closures;
CREATE TRIGGER helm_management_review_closures_record BEFORE INSERT OR UPDATE OR DELETE ON public.helm_management_review_closures FOR EACH ROW EXECUTE FUNCTION public.helm_review_record_guard();
DROP TRIGGER IF EXISTS helm_management_review_closures_guard ON public.helm_management_review_closures;
CREATE TRIGGER helm_management_review_closures_guard BEFORE INSERT ON public.helm_management_review_closures FOR EACH ROW EXECUTE FUNCTION public.helm_management_review_closures_guard();

-- ====================================================================== PART 3

ALTER TABLE public.helm_management_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_management_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_management_review_closures ENABLE ROW LEVEL SECURITY;

-- A review is read whole or not at all: its unit audience and every sensitivity class of its opening state.
-- Written over the row's own columns so INSERT … RETURNING works.
CREATE OR REPLACE FUNCTION helm_private.review_row_visible(
  p_org uuid, p_visibility text, p_opened_by uuid, p_units uuid[], p_classes text[]
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
          OR p_opened_by = auth.uid()
          OR EXISTS (SELECT 1 FROM unnest(p_units) g(unit_id) WHERE g.unit_id IN (SELECT helm_private.visible_org_units(p_org)))
        )
        AND NOT EXISTS (SELECT 1 FROM unnest(p_classes) k WHERE NOT helm_private.has_clearance(p_org, k))
      )
    );
$fn$;

-- By-id wrapper: ONLY for policies on OTHER tables (items and closures), never on the reviews table itself.
CREATE OR REPLACE FUNCTION helm_private.can_see_management_review(p_review uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce((
    SELECT helm_private.review_row_visible(r.org_id, r.visibility, r.opened_by, r.granted_unit_ids, r.sensitivity_classes)
    FROM public.helm_management_reviews r WHERE r.id = p_review
  ), false);
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA helm_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA helm_private TO authenticated, service_role;

DROP POLICY IF EXISTS "Scoped read management reviews" ON public.helm_management_reviews;
CREATE POLICY "Scoped read management reviews" ON public.helm_management_reviews
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.review_row_visible(org_id, visibility, opened_by, granted_unit_ids, sensitivity_classes));
DROP POLICY IF EXISTS "Members open management reviews" ON public.helm_management_reviews;
CREATE POLICY "Members open management reviews" ON public.helm_management_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND opened_by = (select auth.uid())
    AND NOT EXISTS (SELECT 1 FROM unnest(sensitivity_classes) k WHERE NOT helm_private.has_clearance(org_id, k))
  );

-- An item about a decision is read only by someone who can see the decision.
DROP POLICY IF EXISTS "Scoped read management review items" ON public.helm_management_review_items;
CREATE POLICY "Scoped read management review items" ON public.helm_management_review_items
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND helm_private.can_see_management_review(review_id) AND (decision_id IS NULL OR helm_private.can_see_decision(decision_id)));
DROP POLICY IF EXISTS "Readers add management review items" ON public.helm_management_review_items;
CREATE POLICY "Readers add management review items" ON public.helm_management_review_items
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_org_role(org_id, 'member') AND added_by = (select auth.uid())
    AND helm_private.can_see_management_review(review_id) AND (decision_id IS NULL OR helm_private.can_see_decision(decision_id))
  );

DROP POLICY IF EXISTS "Scoped read management review closures" ON public.helm_management_review_closures;
CREATE POLICY "Scoped read management review closures" ON public.helm_management_review_closures
  FOR SELECT TO authenticated USING (public.is_org_member(org_id) AND helm_private.can_see_management_review(review_id));
DROP POLICY IF EXISTS "Readers close management reviews" ON public.helm_management_review_closures;
CREATE POLICY "Readers close management reviews" ON public.helm_management_review_closures
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND closed_by = (select auth.uid()) AND helm_private.can_see_management_review(review_id));

-- ====================================================================== PART 4

REVOKE ALL ON TABLE public.helm_management_reviews, public.helm_management_review_items, public.helm_management_review_closures FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE public.helm_management_reviews, public.helm_management_review_items, public.helm_management_review_closures TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.helm_management_reviews, public.helm_management_review_items, public.helm_management_review_closures FROM authenticated;
GRANT ALL ON TABLE public.helm_management_reviews, public.helm_management_review_items, public.helm_management_review_closures TO service_role;

REVOKE ALL ON FUNCTION
  public.helm_review_record_guard(), public.helm_management_reviews_guard(),
  public.helm_management_review_items_guard(), public.helm_management_review_closures_guard()
FROM PUBLIC, anon;
