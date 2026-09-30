-- ============================================================================
-- HELM — AI Intelligence audit
-- ============================================================================
--
-- ADR-0032 (a governed, provider-neutral AI layer above the kernel).
--
--   PART 1  one append-only table: the audit of every AI run
--   PART 2  guards: write-once, record time stamped by the database, and a shape
--           that CANNOT hold a reasoning trace — the output holds statements,
--           questions and unknowns; the provider holds an id, a model and a
--           version; nothing else fits
--   PART 3  RLS: a user reads their own runs, an org admin reads all
--   PART 4  grants
--
-- The AI writes no enterprise truth: this table is the only thing an AI run
-- records, and it records that the run happened, not a thought. Additive for
-- Memoire: every statement is on a helm_* object.
-- ============================================================================

-- ====================================================================== PART 1

CREATE TABLE IF NOT EXISTS public.helm_ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Who asked. The AI reads as this person and never sees more than they may.
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT DEFAULT auth.uid(),
  task text NOT NULL CHECK (task IN ('EXPLAIN_TWIN_CHANGE', 'SUMMARIZE_ASSUMPTIONS', 'EXPLAIN_DECISION', 'SUMMARIZE_CAUSAL_EVIDENCE', 'FIND_SIMILAR_SITUATIONS', 'EXPLAIN_COUNTERFACTUAL', 'DRAFT_MANAGEMENT_BRIEF', 'ASK_HELM', 'COUNCIL')),
  template_id text NOT NULL CHECK (char_length(btrim(template_id)) >= 1),
  template_version text NOT NULL CHECK (char_length(btrim(template_version)) >= 1),
  prompt_hash text NOT NULL CHECK (char_length(btrim(prompt_hash)) >= 1),
  -- Provider-neutral: an identity, never a vendor-specific payload.
  provider jsonb NOT NULL CHECK (
    jsonb_typeof(provider) = 'object'
    AND provider ? 'id' AND provider ? 'model' AND provider ? 'modelVersion'
    AND (provider - 'id' - 'model' - 'modelVersion') = '{}'::jsonb
  ),
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  grounding jsonb NOT NULL CHECK (jsonb_typeof(grounding) = 'object'),
  -- Statements, questions, unknowns — and nothing else. There is no place to keep a chain of thought.
  output jsonb NOT NULL CHECK (
    jsonb_typeof(output) = 'object'
    AND jsonb_typeof(output->'statements') = 'array'
    AND (output - 'statements' - 'questions' - 'unknowns') = '{}'::jsonb
  ),
  result_meta jsonb NOT NULL CHECK (
    jsonb_typeof(result_meta) = 'object'
    AND (result_meta - 'statementsByClass' - 'evidenceCount' - 'fingerprint') = '{}'::jsonb
  ),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helm_ai_runs_user_idx ON public.helm_ai_runs (org_id, user_id, recorded_at DESC);

-- ====================================================================== PART 2

CREATE OR REPLACE FUNCTION public.helm_ai_runs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'helm_ai_runs: AI runs are an audit trail and are append-only';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS helm_ai_runs_guard ON public.helm_ai_runs;
CREATE TRIGGER helm_ai_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.helm_ai_runs FOR EACH ROW EXECUTE FUNCTION public.helm_ai_runs_guard();

-- ====================================================================== PART 3

ALTER TABLE public.helm_ai_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own AI runs" ON public.helm_ai_runs;
CREATE POLICY "Read own AI runs" ON public.helm_ai_runs
  FOR SELECT TO authenticated
  USING (public.is_org_member(org_id) AND (user_id = (select auth.uid()) OR public.has_org_role(org_id, 'admin')));
DROP POLICY IF EXISTS "Record own AI runs" ON public.helm_ai_runs;
CREATE POLICY "Record own AI runs" ON public.helm_ai_runs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(org_id, 'member') AND user_id = (select auth.uid()));

-- ====================================================================== PART 4

REVOKE ALL ON TABLE public.helm_ai_runs FROM anon, PUBLIC;
GRANT SELECT, INSERT ON TABLE public.helm_ai_runs TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.helm_ai_runs FROM authenticated;
GRANT ALL ON TABLE public.helm_ai_runs TO service_role;

REVOKE ALL ON FUNCTION public.helm_ai_runs_guard() FROM PUBLIC, anon;
