-- ============================================================================
-- HELM Phase 1 — Enterprise Ontology
--
-- STRICTLY ADDITIVE. This migration:
--   * creates only helm_*-prefixed tables (ADR-0005)
--   * never ALTERs or DROPs a Memoire-owned table, policy, index or trigger
--   * reuses the existing RLS helpers (is_org_member / has_org_role) and the
--     existing helm_set_updated_at trigger function rather than redefining them
--   * is idempotent: re-running it is a no-op
--
-- Naming note: public.entities and public.relationships already exist as
-- Memoire's user-scoped capture tables. HELM's ontology is org-scoped,
-- temporal and provenance-bearing, so it takes the helm_ prefix throughout.
--
-- Temporal model (ADR-0014): valid time (valid_from/valid_to, observed_at)
-- describes when a fact is true in the world; record time (ingested_at,
-- updated_at, and the helm_entity_versions chain) describes when HELM learned
-- it. The two are different facts and both are preserved.
--
-- Provenance (ADR-0013): helm_provenance is a first-class polymorphic record
-- covering ingested, seeded, derived, calculated and human-entered facts. The
-- inline source_* columns on entities and relationships are a denormalised fast
-- path, not the authority.
--
-- GENERATED FILE — produced by scripts/generate-ontology-migration.mjs from
-- packages/ontology/src/seed.ts. Do not hand-edit the seed section;
-- verify:ontology regenerates and diffs this file.
-- ============================================================================

-- ------------------------------------------------------- registry: entity types

CREATE TABLE IF NOT EXISTS public.helm_entity_types (
  -- Readable deterministic id ('et_opportunity'), not a uuid: this is a small
  -- registry, and a stable readable key makes fixtures, debugging and
  -- cross-adapter equivalence straightforward.
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  -- NULL = shipped by HELM and available to every organization.
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Za-z0-9]*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text,
  category text NOT NULL CHECK (category IN
    ('organization', 'commercial', 'operations', 'finance', 'resource',
     'management', 'market', 'risk', 'value')),
  parent_type_id text REFERENCES public.helm_entity_types(id) ON DELETE SET NULL,
  attribute_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated')),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_type_id IS NULL OR parent_type_id <> id)
);

-- One key per scope: system types are globally unique, tenant types unique per org.
CREATE UNIQUE INDEX IF NOT EXISTS helm_entity_types_system_key_idx
  ON public.helm_entity_types (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS helm_entity_types_org_key_idx
  ON public.helm_entity_types (org_id, key) WHERE org_id IS NOT NULL;

-- ------------------------------------------------- registry: relationship types

CREATE TABLE IF NOT EXISTS public.helm_relationship_types (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]*$'),
  name text NOT NULL,
  description text,
  category text NOT NULL CHECK (category IN
    ('structural', 'commercial', 'operational', 'financial', 'management')),
  is_directed boolean NOT NULL DEFAULT true,
  carries_weight boolean NOT NULL DEFAULT false,
  -- NULL = unconstrained. Otherwise the allowed entity-type categories.
  source_categories text[],
  target_categories text[],
  inverse_key text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated')),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS helm_relationship_types_system_key_idx
  ON public.helm_relationship_types (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS helm_relationship_types_org_key_idx
  ON public.helm_relationship_types (org_id, key) WHERE org_id IS NOT NULL;

-- --------------------------------------------------------------------- entities

CREATE TABLE IF NOT EXISTS public.helm_entities (
  -- Stable across versions (ADR-0014): relationships point here with a real FK,
  -- so superseding an entity never orphans its edges.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type_id text NOT NULL REFERENCES public.helm_entity_types(id) ON DELETE RESTRICT,
  -- '<namespace>:<kind>:<ref>' — namespaced so two source systems cannot
  -- collide before identity resolution has had a chance to run.
  canonical_key text NOT NULL CHECK (canonical_key ~ '^[A-Za-z0-9_]+:[A-Za-z0-9_]+:.+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 400),
  description text,

  -- Inline provenance fast path; helm_provenance is authoritative.
  source_system text NOT NULL CHECK (source_system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  source_entity_type text,
  source_entity_id text,

  -- Valid time: when this is true in the world.
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  observed_at timestamptz,

  -- Record time: when HELM learned it.
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'merged')),
  -- Identity resolution folds one entity into another without deleting either.
  merged_into_id uuid REFERENCES public.helm_entities(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  UNIQUE (org_id, entity_type_id, canonical_key)
);

-- Traversal indexes. Both directions, because a management question arrives from
-- either end ("what does this opportunity touch?" / "what consumes this stock?").
CREATE INDEX IF NOT EXISTS helm_entities_org_type_idx
  ON public.helm_entities (org_id, entity_type_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS helm_entities_org_source_idx
  ON public.helm_entities (org_id, source_system, source_entity_id);
CREATE INDEX IF NOT EXISTS helm_entities_org_valid_idx
  ON public.helm_entities (org_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS helm_entities_name_trgm_idx
  ON public.helm_entities (org_id, lower(name));

-- ------------------------------------------------- entity versions (record time)

CREATE TABLE IF NOT EXISTS public.helm_entity_versions (
  entity_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN
    ('created', 'updated', 'validity_closed', 'retired', 'merged')),
  snapshot jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  observed_at timestamptz,
  -- Record-time window this version was believed. recorded_to IS NULL = current.
  recorded_from timestamptz NOT NULL DEFAULT now(),
  recorded_to timestamptz,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, version),
  CHECK (recorded_to IS NULL OR recorded_to >= recorded_from)
);

CREATE INDEX IF NOT EXISTS helm_entity_versions_org_entity_idx
  ON public.helm_entity_versions (org_id, entity_id, version);
-- "What did we believe at time T?" — one open version per entity.
CREATE INDEX IF NOT EXISTS helm_entity_versions_record_window_idx
  ON public.helm_entity_versions (org_id, entity_id, recorded_from, recorded_to);

-- ---------------------------------------------------------------- relationships

CREATE TABLE IF NOT EXISTS public.helm_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  relationship_type_id text NOT NULL
    REFERENCES public.helm_relationship_types(id) ON DELETE RESTRICT,
  source_entity_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  weight numeric,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  observed_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  source_system text NOT NULL CHECK (source_system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  source_object_type text,
  source_object_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (source_entity_id <> target_entity_id)
);

CREATE INDEX IF NOT EXISTS helm_relationships_out_idx
  ON public.helm_relationships (org_id, source_entity_id, relationship_type_id)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS helm_relationships_in_idx
  ON public.helm_relationships (org_id, target_entity_id, relationship_type_id)
  WHERE valid_to IS NULL;
-- Historical traversal needs the same edges without the partial predicate.
CREATE INDEX IF NOT EXISTS helm_relationships_out_all_idx
  ON public.helm_relationships (org_id, source_entity_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS helm_relationships_in_all_idx
  ON public.helm_relationships (org_id, target_entity_id, valid_from, valid_to);

-- ---------------------------------------------------------------- entity aliases

-- The structural hook for future entity resolution (docs/architecture/
-- identity-resolution.md). Phase 1 writes only 'exact' aliases at ingestion;
-- fuzzy matching, review queues and merges are deliberately out of scope.
CREATE TABLE IF NOT EXISTS public.helm_entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES public.helm_entities(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  alias_kind text NOT NULL CHECK (alias_kind IN
    ('source_id', 'code', 'name', 'tax_id', 'email', 'domain')),
  alias_value text NOT NULL CHECK (char_length(alias_value) BETWEEN 1 AND 400),
  normalized_value text NOT NULL,
  -- How we believe this link. An exact source-id match and a probabilistic name
  -- match are both aliases; a reviewer must be able to tell them apart.
  match_method text NOT NULL CHECK (match_method IN
    ('exact', 'manual', 'deterministic', 'probabilistic')),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS helm_entity_aliases_lookup_idx
  ON public.helm_entity_aliases (org_id, system, normalized_value) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS helm_entity_aliases_entity_idx
  ON public.helm_entity_aliases (org_id, entity_id);

-- -------------------------------------------------------------- ingestion events

CREATE TABLE IF NOT EXISTS public.helm_ingestion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  connector text NOT NULL,
  cursor text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN
    ('running', 'succeeded', 'failed', 'partial')),
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS helm_ingestion_events_org_started_idx
  ON public.helm_ingestion_events (org_id, started_at DESC);

-- ------------------------------------------------------------------- provenance

-- Polymorphic by subject_kind + subject_id, so one mechanism covers entities,
-- relationships and versions. No FK on subject_id is possible as a result;
-- verify:ontology asserts referential sanity instead.
CREATE TABLE IF NOT EXISTS public.helm_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN
    ('entity', 'relationship', 'entity_version')),
  subject_id uuid NOT NULL,
  source_field text,
  -- 'calculated' is what Phase 3's calculation audit will write, which is why
  -- this table is built now: retrofitting provenance later is far harder.
  method text NOT NULL CHECK (method IN
    ('ingested', 'seeded', 'derived', 'calculated', 'human_assumption', 'inferred')),
  system text NOT NULL CHECK (system IN
    ('memoire', 'erp', 'finance', 'scm', 'wms', 'hris', 'market', 'helm', 'manual')),
  connector text,
  source_object_type text,
  source_object_id text,
  ingestion_event_id uuid REFERENCES public.helm_ingestion_events(id) ON DELETE SET NULL,
  transformation text,
  inputs jsonb,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  notes text,
  -- The source fragment justifying the fact — never a full record copy.
  payload jsonb,
  observed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS helm_provenance_subject_idx
  ON public.helm_provenance (org_id, subject_kind, subject_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS helm_provenance_ingestion_idx
  ON public.helm_provenance (org_id, ingestion_event_id);

-- --------------------------------------------------------- updated_at triggers

DROP TRIGGER IF EXISTS helm_entity_types_updated_at ON public.helm_entity_types;
CREATE TRIGGER helm_entity_types_updated_at BEFORE UPDATE ON public.helm_entity_types
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

DROP TRIGGER IF EXISTS helm_relationship_types_updated_at ON public.helm_relationship_types;
CREATE TRIGGER helm_relationship_types_updated_at BEFORE UPDATE ON public.helm_relationship_types
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

DROP TRIGGER IF EXISTS helm_entities_updated_at ON public.helm_entities;
CREATE TRIGGER helm_entities_updated_at BEFORE UPDATE ON public.helm_entities
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

DROP TRIGGER IF EXISTS helm_relationships_updated_at ON public.helm_relationships;
CREATE TRIGGER helm_relationships_updated_at BEFORE UPDATE ON public.helm_relationships
  FOR EACH ROW EXECUTE FUNCTION public.helm_set_updated_at();

-- ---------------------------------------------------------------------- RLS

ALTER TABLE public.helm_entity_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_relationship_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_entity_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_ingestion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helm_provenance ENABLE ROW LEVEL SECURITY;

-- Registry: shipped types (org_id IS NULL) are readable by any authenticated
-- user; tenant extensions only by that org. Type changes require admin.
DROP POLICY IF EXISTS helm_entity_types_read ON public.helm_entity_types;
CREATE POLICY helm_entity_types_read ON public.helm_entity_types
  FOR SELECT TO authenticated
  USING (org_id IS NULL OR public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_entity_types_write ON public.helm_entity_types;
CREATE POLICY helm_entity_types_write ON public.helm_entity_types
  FOR INSERT TO authenticated
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_entity_types_update ON public.helm_entity_types;
CREATE POLICY helm_entity_types_update ON public.helm_entity_types
  FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'))
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_entity_types_delete ON public.helm_entity_types;
CREATE POLICY helm_entity_types_delete ON public.helm_entity_types
  FOR DELETE TO authenticated
  USING (org_id IS NOT NULL AND is_system = false AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_relationship_types_read ON public.helm_relationship_types;
CREATE POLICY helm_relationship_types_read ON public.helm_relationship_types
  FOR SELECT TO authenticated
  USING (org_id IS NULL OR public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_relationship_types_write ON public.helm_relationship_types;
CREATE POLICY helm_relationship_types_write ON public.helm_relationship_types
  FOR INSERT TO authenticated
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_relationship_types_update ON public.helm_relationship_types;
CREATE POLICY helm_relationship_types_update ON public.helm_relationship_types
  FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'))
  WITH CHECK (org_id IS NOT NULL AND public.has_org_role(org_id, 'admin'));

DROP POLICY IF EXISTS helm_relationship_types_delete ON public.helm_relationship_types;
CREATE POLICY helm_relationship_types_delete ON public.helm_relationship_types
  FOR DELETE TO authenticated
  USING (org_id IS NOT NULL AND is_system = false AND public.has_org_role(org_id, 'admin'));

-- Graph data: members read and write within their org; deletes need manager rank.
-- Every predicate is org-scoped, so org A never sees org B at the Postgres level.
DROP POLICY IF EXISTS helm_entities_read ON public.helm_entities;
CREATE POLICY helm_entities_read ON public.helm_entities
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_entities_insert ON public.helm_entities;
CREATE POLICY helm_entities_insert ON public.helm_entities
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_entities_update ON public.helm_entities;
CREATE POLICY helm_entities_update ON public.helm_entities
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_entities_delete ON public.helm_entities;
CREATE POLICY helm_entities_delete ON public.helm_entities
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager'));

DROP POLICY IF EXISTS helm_relationships_read ON public.helm_relationships;
CREATE POLICY helm_relationships_read ON public.helm_relationships
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_relationships_insert ON public.helm_relationships;
CREATE POLICY helm_relationships_insert ON public.helm_relationships
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_relationships_update ON public.helm_relationships;
CREATE POLICY helm_relationships_update ON public.helm_relationships
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_relationships_delete ON public.helm_relationships;
CREATE POLICY helm_relationships_delete ON public.helm_relationships
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager'));

DROP POLICY IF EXISTS helm_entity_aliases_read ON public.helm_entity_aliases;
CREATE POLICY helm_entity_aliases_read ON public.helm_entity_aliases
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_entity_aliases_insert ON public.helm_entity_aliases;
CREATE POLICY helm_entity_aliases_insert ON public.helm_entity_aliases
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_entity_aliases_update ON public.helm_entity_aliases;
CREATE POLICY helm_entity_aliases_update ON public.helm_entity_aliases
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_entity_aliases_delete ON public.helm_entity_aliases;
CREATE POLICY helm_entity_aliases_delete ON public.helm_entity_aliases
  FOR DELETE TO authenticated USING (public.has_org_role(org_id, 'manager'));

DROP POLICY IF EXISTS helm_ingestion_events_read ON public.helm_ingestion_events;
CREATE POLICY helm_ingestion_events_read ON public.helm_ingestion_events
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_ingestion_events_insert ON public.helm_ingestion_events;
CREATE POLICY helm_ingestion_events_insert ON public.helm_ingestion_events
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_ingestion_events_update ON public.helm_ingestion_events;
CREATE POLICY helm_ingestion_events_update ON public.helm_ingestion_events
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member'))
  WITH CHECK (public.has_org_role(org_id, 'member'));

-- Append-only, like helm_decision_events: the absence of UPDATE and DELETE
-- policies is the guarantee that history and provenance cannot be rewritten
-- from a client, by anyone.
DROP POLICY IF EXISTS helm_entity_versions_read ON public.helm_entity_versions;
CREATE POLICY helm_entity_versions_read ON public.helm_entity_versions
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_entity_versions_insert ON public.helm_entity_versions;
CREATE POLICY helm_entity_versions_insert ON public.helm_entity_versions
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

DROP POLICY IF EXISTS helm_provenance_read ON public.helm_provenance;
CREATE POLICY helm_provenance_read ON public.helm_provenance
  FOR SELECT TO authenticated USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS helm_provenance_insert ON public.helm_provenance;
CREATE POLICY helm_provenance_insert ON public.helm_provenance
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(org_id, 'member'));

-- helm_entity_versions needs one narrow UPDATE: closing the superseded version's
-- record-time window (setting recorded_to). RLS alone cannot express "only this
-- column may change", so a trigger enforces the rest — otherwise the
-- append-only guarantee would be a comment rather than a property.
DROP POLICY IF EXISTS helm_entity_versions_close ON public.helm_entity_versions;
CREATE POLICY helm_entity_versions_close ON public.helm_entity_versions
  FOR UPDATE TO authenticated
  USING (public.has_org_role(org_id, 'member') AND recorded_to IS NULL)
  WITH CHECK (public.has_org_role(org_id, 'member'));

CREATE OR REPLACE FUNCTION public.helm_entity_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Only recorded_to may transition, and only from NULL to a value. Everything
  -- describing what was believed is immutable once written.
  IF NEW.entity_id     IS DISTINCT FROM OLD.entity_id
  OR NEW.org_id        IS DISTINCT FROM OLD.org_id
  OR NEW.version       IS DISTINCT FROM OLD.version
  OR NEW.change_kind   IS DISTINCT FROM OLD.change_kind
  OR NEW.snapshot      IS DISTINCT FROM OLD.snapshot
  OR NEW.valid_from    IS DISTINCT FROM OLD.valid_from
  OR NEW.valid_to      IS DISTINCT FROM OLD.valid_to
  OR NEW.observed_at   IS DISTINCT FROM OLD.observed_at
  OR NEW.recorded_from IS DISTINCT FROM OLD.recorded_from
  OR NEW.changed_by    IS DISTINCT FROM OLD.changed_by
  THEN
    RAISE EXCEPTION
      'helm_entity_versions is append-only: only recorded_to may be set (version %, entity %)',
      OLD.version, OLD.entity_id;
  END IF;
  IF OLD.recorded_to IS NOT NULL THEN
    RAISE EXCEPTION 'helm_entity_versions row % for entity % is already closed',
      OLD.version, OLD.entity_id;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.helm_entity_versions_immutable() FROM anon, public;

DROP TRIGGER IF EXISTS helm_entity_versions_immutable_trg ON public.helm_entity_versions;
CREATE TRIGGER helm_entity_versions_immutable_trg
  BEFORE UPDATE ON public.helm_entity_versions
  FOR EACH ROW EXECUTE FUNCTION public.helm_entity_versions_immutable();

-- ------------------------------------------------------------------- grants
-- Grants are the outer gate; the RLS policies above are what actually decide.
-- A grant without a matching policy still returns nothing.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_entity_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_relationship_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helm_entity_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_relationships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.helm_entity_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helm_ingestion_events TO authenticated;
GRANT SELECT, INSERT ON public.helm_provenance TO authenticated;

-- ============================================================================
-- SEED: shipped ontology (org_id IS NULL, is_system = true)
--
-- Generated from packages/ontology/src/seed.ts. ON CONFLICT DO NOTHING keeps
-- this migration idempotent; re-running never duplicates or overwrites.
--
-- Causal relationship types (CAUSES / INFLUENCES / CORRELATES_WITH) are
-- deliberately absent. The Causal Graph is a separate specialised layer
-- (Phase 8), and folding causal assertions into generic relationships would
-- destroy the distinction between correlation and management causal hypothesis.
-- ============================================================================

INSERT INTO public.helm_entity_types
  (id, org_id, key, name, description, category, parent_type_id,
   attribute_schema, version, status, is_system)
VALUES
  ('et_enterprise', NULL, 'Enterprise', 'Enterprise', 'The whole group. Root of every organizational hierarchy.', 'organization', NULL, '{"type":"object","properties":{"baseCurrency":{"type":"string","description":"ISO 4217 reporting currency"},"fiscalYearStartMonth":{"type":"integer","description":"1-12"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_region', NULL, 'Region', 'Region', 'A multi-country grouping used for management reporting.', 'organization', NULL, '{"type":"object","properties":{"regionCode":{"type":"string","description":"Internal region code"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_country', NULL, 'Country', 'Country', 'A legal and geographic operating unit.', 'organization', NULL, '{"type":"object","properties":{"iso2":{"type":"string","description":"ISO 3166-1 alpha-2"},"currency":{"type":"string","description":"Local currency"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_businessunit', NULL, 'BusinessUnit', 'Business Unit', 'A P&L-bearing unit of the enterprise.', 'organization', NULL, '{"type":"object","properties":{"unitCode":{"type":"string","description":"Internal BU code"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_function', NULL, 'Function', 'Function', 'A functional organization: Commercial, Supply Chain, Finance, Service.', 'organization', NULL, '{"type":"object","properties":{"functionCode":{"type":"string","description":"Function identifier"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_team', NULL, 'Team', 'Team', 'An operating team within a function or business unit.', 'organization', NULL, '{"type":"object","properties":{"headcount":{"type":"integer","description":"Current headcount"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_role', NULL, 'Role', 'Role', 'A position carrying accountability and authority, independent of the person holding it. Authority attaches here so a change of seat never silently moves decision rights.', 'organization', NULL, '{"type":"object","properties":{"title":{"type":"string","description":"Role title"},"level":{"type":"string","description":"Seniority band"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_person', NULL, 'Person', 'Person', 'A named individual. Holds roles over time.', 'organization', NULL, '{"type":"object","properties":{"email":{"type":"string","description":"Work email"},"startDate":{"type":"string","description":"ISO date"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_market', NULL, 'Market', 'Market', 'An addressable market HELM tracks position in.', 'market', NULL, '{"type":"object","properties":{"sizeEstimate":{"type":"number","description":"Estimated value"},"currency":{"type":"string","description":"Currency"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_segment', NULL, 'Segment', 'Segment', 'A customer or product segment, e.g. Pharma, Laboratory, Industrial.', 'market', NULL, '{"type":"object","properties":{"segmentCode":{"type":"string","description":"Segment identifier"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_customer', NULL, 'Customer', 'Customer', 'A buying organization. Operational record stays in Memoire or ERP.', 'commercial', NULL, '{"type":"object","properties":{"tier":{"type":"string","description":"Account tier"},"country":{"type":"string","description":"ISO 3166-1 alpha-2"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_distributor', NULL, 'Distributor', 'Distributor', 'A channel partner that may hold stock on our behalf.', 'commercial', 'et_customer', '{"type":"object","properties":{"holdsConsignment":{"type":"boolean","description":"Holds consignment stock"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_opportunity', NULL, 'Opportunity', 'Opportunity', 'An identified revenue event. HELM holds a semantic projection; Memoire remains the operational system of record.', 'commercial', NULL, '{"type":"object","properties":{"value":{"type":"number","description":"Estimated value in currency"},"currency":{"type":"string","description":"ISO 4217"},"probability":{"type":"number","description":"0..1","minimum":0,"maximum":1},"expectedCloseDate":{"type":"string","description":"ISO date"},"stage":{"type":"string","description":"Commercial stage as reported by the source"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_tender', NULL, 'Tender', 'Tender', 'A formal competitive bid.', 'commercial', 'et_opportunity', '{"type":"object","properties":{"submissionDeadline":{"type":"string","description":"ISO date"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_product', NULL, 'Product', 'Product', 'A sellable item.', 'commercial', NULL, '{"type":"object","properties":{"sku":{"type":"string","description":"Stock keeping unit"},"listPrice":{"type":"number","description":"List price"},"standardCost":{"type":"number","description":"Standard unit cost"},"currency":{"type":"string","description":"ISO 4217"},"shelfLifeDays":{"type":"integer","description":"Shelf life in days"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_portfolio', NULL, 'Portfolio', 'Portfolio', 'A managed grouping of products.', 'commercial', NULL, '{"type":"object","properties":{"portfolioCode":{"type":"string","description":"Portfolio identifier"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_channel', NULL, 'Channel', 'Channel', 'A route to market.', 'commercial', NULL, '{"type":"object","properties":{"channelCode":{"type":"string","description":"Channel identifier"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_revenue', NULL, 'Revenue', 'Revenue', 'A revenue stream attributable to a cost object or product.', 'finance', NULL, '{"type":"object","properties":{"currency":{"type":"string","description":"ISO 4217"},"period":{"type":"string","description":"YYYY-MM"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_supplier', NULL, 'Supplier', 'Supplier', 'An upstream source of product or service.', 'operations', NULL, '{"type":"object","properties":{"leadTimeDays":{"type":"integer","description":"Typical lead time"},"reliabilityScore":{"type":"number","description":"0..1 on-time performance","minimum":0,"maximum":1},"country":{"type":"string","description":"ISO 3166-1 alpha-2"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_warehouse', NULL, 'Warehouse', 'Warehouse', 'A physical stock location.', 'operations', NULL, '{"type":"object","properties":{"locationCode":{"type":"string","description":"Site code"},"country":{"type":"string","description":"ISO alpha-2"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_inventory', NULL, 'Inventory', 'Inventory Position', 'Stock of a product at a location. The unit inventory decisions act on: four units in our warehouse and eight at a distributor are different assets.', 'operations', NULL, '{"type":"object","properties":{"sku":{"type":"string","description":"Product SKU"},"stockOnHand":{"type":"number","description":"Units on hand"},"stockInbound":{"type":"number","description":"Units inbound"},"unitCost":{"type":"number","description":"Unit cost"},"currency":{"type":"string","description":"ISO 4217"},"expiryDate":{"type":"string","description":"ISO date of earliest expiry"},"ownership":{"type":"string","description":"own | consignment | distributor"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_capacity', NULL, 'Capacity', 'Capacity Pool', 'A constrained resource: service engineers, QC, cold-chain, a line.', 'resource', NULL, '{"type":"object","properties":{"availableMinutesPerWeek":{"type":"number","description":"Available minutes"},"resourceCount":{"type":"integer","description":"Number of resources"},"unit":{"type":"string","description":"What the capacity is measured in"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_shipment', NULL, 'Shipment', 'Shipment', 'An in-transit consignment.', 'operations', NULL, '{"type":"object","properties":{"etaDate":{"type":"string","description":"ISO date"},"mode":{"type":"string","description":"air | sea | road"},"quantity":{"type":"number","description":"Units"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_servicelevel', NULL, 'ServiceLevel', 'Service Level Target', 'A promised service standard, and the exposure created by missing it.', 'operations', NULL, '{"type":"object","properties":{"targetPct":{"type":"number","description":"0..1","minimum":0,"maximum":1},"penaltyClause":{"type":"string","description":"Contractual consequence"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_cost', NULL, 'Cost', 'Cost Pool', 'A grouped cost with a behaviour. `behaviour` is load-bearing: it lets the relevant-cost engine decide relevance mechanically instead of asking a human.', 'finance', NULL, '{"type":"object","properties":{"behaviour":{"type":"string","description":"Cost behaviour","enum":["variable","traceable_fixed","allocated_fixed"]},"currency":{"type":"string","description":"ISO 4217"},"period":{"type":"string","description":"YYYY-MM"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_margin', NULL, 'Margin', 'Margin', 'A margin measure for a cost object.', 'finance', NULL, '{"type":"object","properties":{"basis":{"type":"string","description":"gross | contribution | segment | net"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_workingcapital', NULL, 'WorkingCapital', 'Working Capital Item', 'Inventory, receivable or payable position tying up capital.', 'finance', NULL, '{"type":"object","properties":{"kind":{"type":"string","description":"Working capital kind","enum":["inventory","receivable","payable"]},"daysOutstanding":{"type":"number","description":"DIO / DSO / DPO"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_cash', NULL, 'Cash', 'Cash Position', 'Cash at a point in time.', 'finance', NULL, '{"type":"object","properties":{"balance":{"type":"number","description":"Balance"},"currency":{"type":"string","description":"ISO 4217"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_ebitda', NULL, 'EBITDA', 'EBITDA', 'Earnings before interest, tax, depreciation and amortization.', 'finance', NULL, '{"type":"object","properties":{"currency":{"type":"string","description":"ISO 4217"},"period":{"type":"string","description":"YYYY-MM"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_investment', NULL, 'Investment', 'Investment', 'Committed capital carrying a return expectation.', 'finance', NULL, '{"type":"object","properties":{"amount":{"type":"number","description":"Committed amount"},"currency":{"type":"string","description":"ISO 4217"},"hurdleRate":{"type":"number","description":"Required return","minimum":0,"maximum":1}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_objective', NULL, 'Objective', 'Objective', 'What management is trying to achieve.', 'management', NULL, '{"type":"object","properties":{"targetValue":{"type":"number","description":"Target"},"targetDate":{"type":"string","description":"ISO date"},"unit":{"type":"string","description":"Unit of the target"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_kpi', NULL, 'KPI', 'KPI', 'A tracked measure with a target and a threshold.', 'management', NULL, '{"type":"object","properties":{"metricCode":{"type":"string","description":"Which metric"},"target":{"type":"number","description":"Target value"},"threshold":{"type":"number","description":"Alert threshold"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_constraint', NULL, 'Constraint', 'Constraint', 'A limit management must respect.', 'management', NULL, '{"type":"object","properties":{"kind":{"type":"string","description":"Constraint kind","enum":["policy","physical","contractual","regulatory"]},"limitValue":{"type":"number","description":"The limit"},"unit":{"type":"string","description":"Unit of the limit"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_assumption', NULL, 'Assumption', 'Assumption', 'An explicit belief an analysis depends on.', 'management', NULL, '{"type":"object","properties":{"statement":{"type":"string","description":"What is assumed"},"basis":{"type":"string","description":"Why we believe it"},"sensitivity":{"type":"string","description":"How much the conclusion moves with it","enum":["low","medium","high"]},"validated":{"type":"string","description":"Outcome of testing the assumption","enum":["pending","held","failed"]}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_risk', NULL, 'Risk', 'Risk', 'A potential adverse event with likelihood and impact.', 'risk', NULL, '{"type":"object","properties":{"likelihood":{"type":"number","description":"0..1","minimum":0,"maximum":1},"impact":{"type":"number","description":"Impact if it occurs"},"currency":{"type":"string","description":"ISO 4217"},"mitigation":{"type":"string","description":"Current mitigation"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_signal', NULL, 'Signal', 'Signal', 'A detected attention item carrying its rule, threshold and evidence.', 'management', NULL, '{"type":"object","properties":{"ruleCode":{"type":"string","description":"Which rule fired"},"severity":{"type":"string","description":"Severity","enum":["info","watch","warning","critical"]},"thresholdLabel":{"type":"string","description":"What it was judged against"},"measuredLabel":{"type":"string","description":"What was measured"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_issue', NULL, 'Issue', 'Issue', 'A confirmed problem under management.', 'management', NULL, '{"type":"object","properties":{"status":{"type":"string","description":"open | mitigating | resolved"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_scenario', NULL, 'Scenario', 'Scenario', 'A modelled alternative world. Overlays reality; never mutates it.', 'management', NULL, '{"type":"object","properties":{"kind":{"type":"string","description":"base | variant"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_decision', NULL, 'Decision', 'Decision', 'A managerial choice with a lifecycle. The relational helm_decisions record remains authoritative for governance; this is its semantic projection.', 'management', NULL, '{"type":"object","properties":{"decisionType":{"type":"string","description":"Template used"},"status":{"type":"string","description":"Lifecycle state"},"amountAtStake":{"type":"number","description":"Value at stake"},"currency":{"type":"string","description":"ISO 4217"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_action', NULL, 'Action', 'Action', 'An execution instruction produced by an approved decision.', 'management', NULL, '{"type":"object","properties":{"dueDate":{"type":"string","description":"ISO date"},"status":{"type":"string","description":"open | done | cancelled"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_outcome', NULL, 'Outcome', 'Outcome', 'What actually happened, against what was expected.', 'management', NULL, '{"type":"object","properties":{"expected":{"type":"string","description":"Expected outcome as stated before approval"},"actual":{"type":"string","description":"Observed outcome"},"score":{"type":"string","description":"better | as_expected | worse | mixed"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_lesson', NULL, 'Lesson', 'Lesson', 'Generalised learning derived from one or more outcomes.', 'management', NULL, '{"type":"object","properties":{"statement":{"type":"string","description":"What the organization should conclude"},"confidence":{"type":"number","description":"0..1","minimum":0,"maximum":1}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true),
  ('et_enterprisevalue', NULL, 'EnterpriseValue', 'Enterprise Value', 'The terminal node every value chain reaches. Phase 2 attaches value nodes; Phase 1 seeds the concept so the spine has an endpoint.', 'value', NULL, '{"type":"object","properties":{"currency":{"type":"string","description":"ISO 4217"}},"required":[],"additionalProperties":true}'::jsonb, 1, 'active', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.helm_relationship_types
  (id, org_id, key, name, description, category, is_directed, carries_weight,
   source_categories, target_categories, inverse_key, version, status, is_system)
VALUES
  ('rt_belongs_to', NULL, 'BELONGS_TO', 'belongs to', 'Primary hierarchy edge: this sits within that.', 'structural', true, false, NULL, NULL, 'CONTAINS', 1, 'active', true),
  ('rt_contains', NULL, 'CONTAINS', 'contains', 'Inverse of BELONGS_TO, for readable traversal in the other direction.', 'structural', true, false, NULL, NULL, 'BELONGS_TO', 1, 'active', true),
  ('rt_owns', NULL, 'OWNS', 'owns', 'Ownership or stewardship of an asset, portfolio or position.', 'structural', true, false, NULL, NULL, 'OWNED_BY', 1, 'active', true),
  ('rt_owned_by', NULL, 'OWNED_BY', 'owned by', 'Inverse of OWNS. Used for accountability lookups.', 'structural', true, false, NULL, ARRAY['organization']::text[], 'OWNS', 1, 'active', true),
  ('rt_responsible_for', NULL, 'RESPONSIBLE_FOR', 'responsible for', 'Management accountability. Attaches to a Role, not a Person.', 'structural', true, false, ARRAY['organization']::text[], NULL, NULL, 1, 'active', true),
  ('rt_holds_role', NULL, 'HOLDS_ROLE', 'holds role', 'A person occupies a role. Temporal: closed when they move on.', 'structural', true, false, ARRAY['organization']::text[], ARRAY['organization']::text[], NULL, 1, 'active', true),
  ('rt_reports_to', NULL, 'REPORTS_TO', 'reports to', 'The authority spine, role to role.', 'structural', true, false, ARRAY['organization']::text[], ARRAY['organization']::text[], NULL, 1, 'active', true),
  ('rt_located_in', NULL, 'LOCATED_IN', 'located in', 'Geographic placement, used for scoping.', 'structural', true, false, NULL, ARRAY['organization']::text[], NULL, 1, 'active', true),
  ('rt_serves', NULL, 'SERVES', 'serves', 'This unit, team or capacity serves that market, segment or customer.', 'commercial', true, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_sells', NULL, 'SELLS', 'sells', 'A commercial event or channel moves a product. Weight carries quantity.', 'commercial', true, true, NULL, ARRAY['commercial']::text[], NULL, 1, 'active', true),
  ('rt_held_by', NULL, 'HELD_BY', 'held by', 'An opportunity belongs to a customer.', 'commercial', true, false, ARRAY['commercial']::text[], ARRAY['commercial']::text[], NULL, 1, 'active', true),
  ('rt_supplies', NULL, 'SUPPLIES', 'supplies', 'A supplier provides a product. Lag carries lead time.', 'operational', true, false, ARRAY['operations']::text[], ARRAY['commercial']::text[], 'SUPPLIED_BY', 1, 'active', true),
  ('rt_supplied_by', NULL, 'SUPPLIED_BY', 'supplied by', 'Inverse of SUPPLIES — the direction a product-first traversal needs.', 'operational', true, false, ARRAY['commercial']::text[], ARRAY['operations']::text[], 'SUPPLIES', 1, 'active', true),
  ('rt_stocked_at', NULL, 'STOCKED_AT', 'stocked at', 'An inventory position sits at a warehouse or distributor.', 'operational', true, false, ARRAY['operations']::text[], NULL, NULL, 1, 'active', true),
  ('rt_positions', NULL, 'POSITIONS', 'positions', 'An inventory position is stock *of* this product.', 'operational', true, false, ARRAY['operations']::text[], ARRAY['commercial']::text[], NULL, 1, 'active', true),
  ('rt_generates', NULL, 'GENERATES', 'generates', 'This creates that: an opportunity generates demand or revenue.', 'commercial', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_consumes', NULL, 'CONSUMES', 'consumes', 'This draws on a finite resource. Two CONSUMES edges into one position is how HELM sees contention between competing demands.', 'operational', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_requires', NULL, 'REQUIRES', 'requires', 'This cannot proceed without that.', 'operational', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_depends_on', NULL, 'DEPENDS_ON', 'depends on', 'A softer dependency than REQUIRES: degraded, not blocked.', 'operational', true, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_constrains', NULL, 'CONSTRAINS', 'constrains', 'A constraint or capacity limits what this can do.', 'operational', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_affects', NULL, 'AFFECTS', 'affects', 'A declared impact surface — a decision or scenario changes this. NOT a causal assertion: causality is Phase 8 and lives in its own layer.', 'management', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_contributes_to', NULL, 'CONTRIBUTES_TO', 'contributes to', 'The terminal edge of a value chain, usually into EnterpriseValue.', 'financial', true, true, NULL, NULL, NULL, 1, 'active', true),
  ('rt_converts_to', NULL, 'CONVERTS_TO', 'converts to', 'Working capital becoming cash. Lag carries the conversion period.', 'financial', true, false, ARRAY['finance']::text[], ARRAY['finance']::text[], NULL, 1, 'active', true),
  ('rt_incurs', NULL, 'INCURS', 'incurs', 'This gives rise to a cost.', 'financial', true, true, NULL, ARRAY['finance']::text[], NULL, 1, 'active', true),
  ('rt_supports', NULL, 'SUPPORTS', 'supports', 'This advances that objective.', 'management', true, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_aligns_with', NULL, 'ALIGNS_WITH', 'aligns with', 'Strategic consistency without a direct contribution claim.', 'management', false, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_exposed_to', NULL, 'EXPOSED_TO', 'exposed to', 'This carries exposure to that risk.', 'management', true, true, NULL, ARRAY['risk']::text[], NULL, 1, 'active', true),
  ('rt_mitigates', NULL, 'MITIGATES', 'mitigates', 'A decision or action reduces a risk.', 'management', true, false, ARRAY['management']::text[], ARRAY['risk']::text[], NULL, 1, 'active', true),
  ('rt_derived_from', NULL, 'DERIVED_FROM', 'derived from', 'A lesson from an outcome, a figure from a source.', 'management', true, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_competes_with', NULL, 'COMPETES_WITH', 'competes with', 'Two demands contend for the same constrained resource. This is the edge that lets HELM price the cost of foreclosing a future option.', 'commercial', false, false, NULL, NULL, NULL, 1, 'active', true),
  ('rt_raised_by', NULL, 'RAISED_BY', 'raised by', 'A signal points at what the rule observed.', 'management', true, false, ARRAY['management']::text[], NULL, NULL, 1, 'active', true),
  ('rt_resolves', NULL, 'RESOLVES', 'resolves', 'A decision closes a signal or issue — the attention loop closing.', 'management', true, false, ARRAY['management']::text[], ARRAY['management']::text[], NULL, 1, 'active', true),
  ('rt_tracks', NULL, 'TRACKS', 'tracks', 'A KPI measures this.', 'management', true, false, ARRAY['management']::text[], NULL, NULL, 1, 'active', true),
  ('rt_assumes', NULL, 'ASSUMES', 'assumes', 'An analysis rests on this assumption.', 'management', true, false, ARRAY['management']::text[], ARRAY['management']::text[], NULL, 1, 'active', true)
ON CONFLICT (id) DO NOTHING;
