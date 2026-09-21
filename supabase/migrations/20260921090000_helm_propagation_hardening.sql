-- ============================================================================
-- HELM Phase 3 hardening
--
-- STRICTLY ADDITIVE IN EFFECT. Only helm_*-prefixed objects. No Memoire table,
-- policy, index, trigger or function is altered or dropped. Every statement is
-- guarded so re-running is a no-op.
--
--   1. A calculation run carries TWO lenses, not one:
--        effective_as_of    what business time is being modelled
--        recorded_through   what HELM was allowed to know when the run began
--      The old single `as_of` conflated them. It is renamed to effective_as_of
--      (which is what it always meant) rather than dropped, so any existing
--      row keeps its value, and recorded_through is backfilled from started_at
--      — the honest reconstruction of a run's knowledge cutoff.
--
--   2. The run policy vocabulary names the truth layer it reads. `BASELINE`
--      becomes `SOURCE_TRUTH`: a baseline run reads what the business says,
--      and must not rank HELM's own historical output as business truth.
--
--   3. A calculation step keeps the RAW computation next to the normalized
--      business value, so a reader can see that 2 687 700 000 VND is a
--      rounding of 2 687 699 999.9999999999999999999969 and not an invention.
--
--   4. Two Phase 1 objects that exist live but in no repository migration —
--      helm_write_entity and helm_entity_aliases_unique_current_idx — are
--      reproduced here, and helm_write_entity now pins its search_path, closing
--      the Supabase function_search_path_mutable advisory.
-- ============================================================================

-- --------------------------------------------------------- 1. two lenses

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'helm_calculation_runs'
      AND column_name = 'as_of'
  ) THEN
    ALTER TABLE public.helm_calculation_runs RENAME COLUMN as_of TO effective_as_of;
  END IF;
END
$do$;

COMMENT ON COLUMN public.helm_calculation_runs.effective_as_of IS
  'Business/effective time being modelled. Governs valid time: a point-in-time '
  'claim effective after this instant is not about the world being modelled.';

ALTER TABLE public.helm_calculation_runs
  ADD COLUMN IF NOT EXISTS recorded_through timestamptz;

-- A run's knowledge cutoff, for any row written before this column existed, is
-- the moment it started: that is exactly what the engine now pins by default.
UPDATE public.helm_calculation_runs
  SET recorded_through = started_at
  WHERE recorded_through IS NULL;

ALTER TABLE public.helm_calculation_runs
  ALTER COLUMN recorded_through SET NOT NULL;

COMMENT ON COLUMN public.helm_calculation_runs.recorded_through IS
  'Knowledge cutoff. No observation recorded after this instant enters the run, '
  'even if its effective time qualifies. Pinned once at run start and restored '
  'verbatim on replay, which is what makes a replay evidence about what HELM '
  'could know rather than a fresh run using old numbers.';

-- Deliberately NOT constrained to <= started_at. recorded_through comes from the
-- application clock and started_at from the database clock; a CHECK between two
-- clocks would fail on ordinary skew. The engine pins it at run start; replay
-- restores an earlier value; neither can move it later than the run began.

-- -------------------------------------------- 2. policy names the truth layer

ALTER TABLE public.helm_calculation_runs
  DROP CONSTRAINT IF EXISTS helm_calculation_runs_preference_check;

UPDATE public.helm_calculation_runs
  SET preference = 'SOURCE_TRUTH'
  WHERE preference = 'BASELINE';

ALTER TABLE public.helm_calculation_runs
  ADD CONSTRAINT helm_calculation_runs_preference_check
  CHECK (preference IN ('SOURCE_TRUTH', 'ACTUALS_FIRST', 'SCENARIO', 'ASSUMPTION_ONLY'));

-- --------------------------------------- 3. raw computation beside the value

ALTER TABLE public.helm_calculation_steps
  ADD COLUMN IF NOT EXISTS output_value_raw text;

COMMENT ON COLUMN public.helm_calculation_steps.output_value IS
  'The BUSINESS-NORMALIZED value written to the observation, at the metric''s '
  'storage precision (whole dong for VND, four decimals for a percentage).';

COMMENT ON COLUMN public.helm_calculation_steps.output_value_raw IS
  'The raw computation at full internal precision, when normalization moved it. '
  'NULL when the computation was already exact at storage precision.';

-- -------------------------- 4. reconcile Phase 1 objects missing from the repo
--
-- Two HELM objects exist in the live database but were created by NO migration
-- in this repository — they were applied directly during Phase 1 while fixing
-- the entity-write RPC and alias idempotency, and never written back:
--
--   helm_write_entity                        the RPC PostgresGraphStore calls
--   helm_entity_aliases_unique_current_idx   one current alias per identity
--
-- A database built from these files therefore could not run the Postgres graph
-- adapter at all. Both are reproduced here exactly as they stand live —
-- definition, body and privileges — so the repository and the database describe
-- the same system. Against the live database this replaces the function in
-- place (same signature, same return type, grants preserved) and the index
-- already exists.

-- The alias index: an entity has at most one CURRENT alias per system, kind and
-- normalized value. Without it, re-running a connector duplicated aliases.
CREATE UNIQUE INDEX IF NOT EXISTS helm_entity_aliases_unique_current_idx
  ON public.helm_entity_aliases
  USING btree (org_id, entity_id, system, alias_kind, normalized_value)
  WHERE (valid_to IS NULL);

-- The entity-write RPC, verbatim from the live database EXCEPT for one line:
-- `SET search_path`, which closes the function_search_path_mutable advisory.
-- Every table it touches was already schema-qualified; the pin removes the last
-- dependency on the caller's search_path, with pg_temp last so a temporary
-- object can never shadow a real one.
CREATE OR REPLACE FUNCTION public.helm_write_entity(
  p_org_id uuid,
  p_entity_type_id text,
  p_canonical_key text,
  p_name text,
  p_description text,
  p_source_system text,
  p_source_entity_type text,
  p_source_entity_id text,
  p_valid_from timestamp with time zone,
  p_valid_to timestamp with time zone,
  p_observed_at timestamp with time zone,
  p_confidence numeric,
  p_attributes jsonb,
  p_status text,
  p_actor uuid
)
RETURNS TABLE(out_entity_id uuid, out_version integer, out_outcome text)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_existing public.helm_entities;
  v_now timestamptz := now();
  v_id uuid;
  v_version integer;
  v_outcome text;
  v_snapshot jsonb;
  v_valid_from timestamptz;
BEGIN
  SELECT * INTO v_existing
  FROM public.helm_entities e
  WHERE e.org_id = p_org_id
    AND e.entity_type_id = p_entity_type_id
    AND e.canonical_key = p_canonical_key;

  IF NOT FOUND THEN
    v_valid_from := COALESCE(p_valid_from, v_now);
    INSERT INTO public.helm_entities (
      org_id, entity_type_id, canonical_key, name, description,
      source_system, source_entity_type, source_entity_id,
      valid_from, valid_to, observed_at, ingested_at, updated_at, version,
      confidence, attributes, status, created_by
    ) VALUES (
      p_org_id, p_entity_type_id, p_canonical_key, p_name, p_description,
      p_source_system, p_source_entity_type, p_source_entity_id,
      v_valid_from, p_valid_to, p_observed_at, v_now, v_now, 1,
      p_confidence, COALESCE(p_attributes, '{}'::jsonb),
      COALESCE(p_status, 'active'), p_actor
    )
    RETURNING helm_entities.id, helm_entities.version INTO v_id, v_version;
    v_outcome := 'created';
  ELSE
    -- Idempotency: an identical re-ingest must not advance the version or write
    -- a version row. Re-running a connector is expected to be a no-op.
    IF v_existing.name = p_name
      AND COALESCE(v_existing.description, '') = COALESCE(p_description, '')
      AND v_existing.valid_from = COALESCE(p_valid_from, v_existing.valid_from)
      AND v_existing.valid_to IS NOT DISTINCT FROM p_valid_to
      AND v_existing.observed_at IS NOT DISTINCT FROM p_observed_at
      AND v_existing.confidence IS NOT DISTINCT FROM p_confidence
      AND v_existing.attributes = COALESCE(p_attributes, '{}'::jsonb)
      AND v_existing.status = COALESCE(p_status, v_existing.status)
      AND v_existing.source_entity_id IS NOT DISTINCT FROM p_source_entity_id
      AND v_existing.source_entity_type IS NOT DISTINCT FROM p_source_entity_type
    THEN
      RETURN QUERY SELECT v_existing.id, v_existing.version, 'unchanged'::text;
      RETURN;
    END IF;

    UPDATE public.helm_entities e SET
      name = p_name,
      description = p_description,
      source_entity_type = p_source_entity_type,
      source_entity_id = p_source_entity_id,
      valid_from = COALESCE(p_valid_from, e.valid_from),
      valid_to = p_valid_to,
      observed_at = p_observed_at,
      confidence = p_confidence,
      attributes = COALESCE(p_attributes, '{}'::jsonb),
      status = COALESCE(p_status, e.status),
      version = e.version + 1,
      updated_at = v_now
    WHERE e.id = v_existing.id
    RETURNING e.id, e.version INTO v_id, v_version;
    v_outcome := 'updated';
  END IF;

  -- Close the previously open version, then append the new one. Same statement
  -- batch as the entity write, so history can never be half-written.
  UPDATE public.helm_entity_versions ev
  SET recorded_to = v_now
  WHERE ev.entity_id = v_id AND ev.recorded_to IS NULL;

  SELECT to_jsonb(e.*) INTO v_snapshot FROM public.helm_entities e WHERE e.id = v_id;

  INSERT INTO public.helm_entity_versions (
    entity_id, org_id, version, change_kind, snapshot,
    valid_from, valid_to, observed_at, recorded_from, recorded_to, changed_by
  )
  SELECT v_id, p_org_id, v_version,
    CASE
      WHEN v_outcome = 'created' THEN 'created'
      WHEN COALESCE(p_status, 'active') = 'retired' THEN 'retired'
      ELSE 'updated'
    END,
    v_snapshot,
    e.valid_from, e.valid_to, e.observed_at, v_now, NULL, p_actor
  FROM public.helm_entities e WHERE e.id = v_id;

  RETURN QUERY SELECT v_id, v_version, v_outcome;
END;
$fn$;

-- Privileges exactly as they stand live. A freshly created function is
-- executable by PUBLIC by default; the live one is not, and neither is anon.
-- The RPC runs as the caller (SECURITY INVOKER), so RLS still decides what a
-- signed-in user may write.
REVOKE ALL ON FUNCTION public.helm_write_entity(
  uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, timestamptz, numeric, jsonb, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.helm_write_entity(
  uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, timestamptz, numeric, jsonb, text, uuid
) TO authenticated, service_role;

-- helm_set_updated_at is ALREADY pinned in the live database, by a migration
-- (pin_helm_trigger_search_path) that was applied directly and never committed
-- to this repository. A database built from these files would therefore carry
-- the advisory the live one does not. Pinning it here makes the repository
-- reproduce the live state; against the live database it is a no-op.
ALTER FUNCTION public.helm_set_updated_at() SET search_path TO 'public', 'pg_temp';
