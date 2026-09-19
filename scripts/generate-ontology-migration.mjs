/**
 * Generates the Phase 1 ontology migration from the TypeScript seed.
 *
 * The seed in packages/ontology/src/seed.ts is the single source of truth. This
 * script renders it to SQL, so the database and the in-memory store can never
 * disagree about what types exist. `verify:ontology` regenerates and diffs, so
 * editing one without the other fails the build.
 *
 *   node scripts/generate-ontology-migration.mjs            # write
 *   node scripts/generate-ontology-migration.mjs --check    # diff only
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedEntityTypes, seedRelationshipTypes } from '../packages/ontology/src/seed.ts';
import { seedTypeId } from '../packages/ontology/src/registry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'supabase/migrations/20260919120000_helm_ontology.sql';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const jsonb = (v) => `${q(JSON.stringify(v))}::jsonb`;
const arr = (v) =>
  v === null || v === undefined ? 'NULL' : `ARRAY[${v.map(q).join(', ')}]::text[]`;
const bool = (v) => (v ? 'true' : 'false');

function entityTypeRows() {
  return seedEntityTypes
    .map((t) => {
      const id = seedTypeId('entity', t.key);
      const parent = t.parentKey ? seedTypeId('entity', t.parentKey) : null;
      return `  (${q(id)}, NULL, ${q(t.key)}, ${q(t.name)}, ${q(t.description)}, ` +
        `${q(t.category)}, ${q(parent)}, ${jsonb(t.attributeSchema)}, 1, ` +
        `${q(t.status ?? 'active')}, true)`;
    })
    .join(',\n');
}

function relationshipTypeRows() {
  return seedRelationshipTypes
    .map((t) => {
      const id = seedTypeId('relationship', t.key);
      return `  (${q(id)}, NULL, ${q(t.key)}, ${q(t.name)}, ${q(t.description)}, ` +
        `${q(t.category)}, ${bool(t.isDirected)}, ${bool(t.carriesWeight)}, ` +
        `${arr(t.sourceCategories)}, ${arr(t.targetCategories)}, ${q(t.inverseKey)}, ` +
        `1, 'active', true)`;
    })
    .join(',\n');
}

const sql = `-- ============================================================================
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
${entityTypeRows()}
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.helm_relationship_types
  (id, org_id, key, name, description, category, is_directed, carries_weight,
   source_categories, target_categories, inverse_key, version, status, is_system)
VALUES
${relationshipTypeRows()}
ON CONFLICT (id) DO NOTHING;
`;

const target = join(root, MIGRATION);

if (process.argv.includes('--check')) {
  if (!existsSync(target)) {
    console.error(`MISSING: ${MIGRATION} has not been generated.`);
    process.exit(1);
  }
  const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (current !== sql.replace(/\r\n/g, '\n')) {
    console.error(
      `DRIFT: ${MIGRATION} does not match packages/ontology/src/seed.ts.\n` +
        `Run: node scripts/generate-ontology-migration.mjs`,
    );
    process.exit(1);
  }
  console.log(`ok — ${MIGRATION} matches the TypeScript seed`);
} else {
  writeFileSync(target, sql, 'utf8');
  console.log(
    `wrote ${MIGRATION}\n` +
      `  ${seedEntityTypes.length} entity types, ${seedRelationshipTypes.length} relationship types`,
  );
}
