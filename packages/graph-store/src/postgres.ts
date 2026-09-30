/**
 * PostgresGraphStore — the production adapter, and the ONLY place in the kernel
 * that knows a database exists (ADR-0004).
 *
 * It implements exactly the same contract as InMemoryGraphStore and is held to
 * it by the shared conformance suite. Where the two could plausibly diverge —
 * valid-time filtering, undirected edges, path confidence, idempotency — the
 * in-memory adapter is the reference semantics and this one matches it.
 *
 * Tenant isolation is enforced twice: every query here filters on
 * `scope.orgId`, AND Postgres RLS filters again on the server. The duplication
 * is deliberate; a client is never trusted.
 *
 * Traversal note: implemented as bounded level-by-level BFS with one batched
 * query per level, rather than a recursive CTE. See docs/architecture/
 * docs/architecture/layers/ontology-and-graph-store.md for the reasoning and the trigger for revisiting it.
 */

import {
  ErrorCodes,
  asAliasId,
  asEntityId,
  asEntityTypeId,
  asIngestionEventId,
  asProvenanceId,
  asRecordTime,
  asRelationshipId,
  asRelationshipTypeId,
  asValidTime,
  chainConfidence,
  fail,
  isValidAt,
  ok,
  toIso,
  wasRecordedAt,
  type Clock,
  type Confidence,
  type EntityId,
  type IngestionEvent,
  type IngestionEventId,
  type OrgId,
  type ProvenanceInput,
  type ProvenanceRecord,
  type RelationshipId,
  type Scope,
  type SourceSystem,
  type UserId,
} from '@helm/shared';
import {
  normalizeAlias,
  type Entity,
  type EntityAlias,
  type EntityAliasInput,
  type EntityInput,
  type EntityPatch,
  type EntityVersion,
  type OntologyRegistry,
  type Relationship,
  type RelationshipInput,
} from '@helm/ontology';
import type {
  Direction,
  EntityQuery,
  EntityWriteResult,
  GraphPath,
  GraphStore,
  Neighbor,
  NeighborQuery,
  PathSpec,
  RelationshipQuery,
  TraversalNode,
  TraversalResult,
  TraversalSpec,
} from './port.ts';

const DEFAULT_MAX_NODES = 1000;
const MAX_ALLOWED_DEPTH = 12;

/**
 * The narrow slice of supabase-js this adapter uses. Typed structurally so the
 * package does not take a hard dependency on @supabase/supabase-js — the app
 * passes its existing client in.
 */
export type SupabaseLike = {
  // A fluent query builder cannot be usefully typed structurally: every chained
  // method returns a differently-shaped builder, and reproducing that here would
  // duplicate supabase-js's own generics without gaining safety. The escape
  // hatch is confined to these two lines — every row that comes back is cast to
  // an explicit *Row type below, which is where the real checking happens.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  from(table: string): any;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  rpc(fn: string, args?: Record<string, unknown>): any;
};

export type PostgresGraphStoreOptions = {
  client: SupabaseLike;
  registry: OntologyRegistry;
  clock: Clock;
};

type EntityRow = {
  id: string;
  org_id: string;
  entity_type_id: string;
  canonical_key: string;
  name: string;
  description: string | null;
  source_system: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  valid_from: string;
  valid_to: string | null;
  observed_at: string | null;
  ingested_at: string;
  updated_at: string;
  version: number;
  confidence: number | string | null;
  attributes: Record<string, unknown>;
  status: string;
  merged_into_id: string | null;
  created_by: string | null;
};

type RelationshipRow = {
  id: string;
  org_id: string;
  relationship_type_id: string;
  source_entity_id: string;
  target_entity_id: string;
  weight: number | string | null;
  confidence: number | string | null;
  valid_from: string;
  valid_to: string | null;
  observed_at: string | null;
  ingested_at: string;
  updated_at: string;
  source_system: string;
  source_object_type: string | null;
  source_object_id: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
};

type VersionRow = {
  entity_id: string;
  org_id: string;
  version: number;
  change_kind: EntityVersion['changeKind'];
  snapshot: EntityRow;
  valid_from: string;
  valid_to: string | null;
  observed_at: string | null;
  recorded_from: string;
  recorded_to: string | null;
  changed_by: UserId | null;
};

type ProvenanceRow = {
  id: string;
  org_id: string;
  subject_kind: ProvenanceRecord['subjectKind'];
  subject_id: string;
  source_field: string | null;
  method: ProvenanceRecord['method'];
  system: SourceSystem;
  connector: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  ingestion_event_id: string | null;
  transformation: string | null;
  inputs: Record<string, unknown> | null;
  actor_id: UserId | null;
  confidence: number | string | null;
  notes: string | null;
  payload: Record<string, unknown> | null;
  observed_at: string | null;
  recorded_at: string;
};

type IngestionEventRow = {
  id: string;
  org_id: string;
  system: SourceSystem;
  connector: string;
  cursor: string | null;
  started_at: string;
  finished_at: string | null;
  status: IngestionEvent['status'];
  record_count: number;
  notes: string | null;
};

type AliasRow = {
  id: string;
  org_id: string;
  entity_id: string;
  system: SourceSystem;
  alias_kind: EntityAlias['aliasKind'];
  alias_value: string;
  normalized_value: string;
  match_method: EntityAlias['matchMethod'];
  confidence: number | string | null;
  evidence: Record<string, unknown> | null;
  valid_from: string;
  valid_to: string | null;
  created_by: UserId | null;
};

/** Postgres numeric arrives as a string over REST; normalise at the boundary. */
const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);

export function createPostgresGraphStore(opts: PostgresGraphStoreOptions): GraphStore {
  const { client, registry, clock } = opts;

  // Type ids and keys are a small fixed registry; resolving them locally avoids
  // a join on every single row read.
  const typeKeyById = new Map<string, string>();
  const typeIdByKey = new Map<string, string>();
  for (const t of registry.allEntityTypes()) {
    typeKeyById.set(t.id, t.key);
    typeIdByKey.set(t.key, t.id);
  }
  const relKeyById = new Map<string, string>();
  const relIdByKey = new Map<string, string>();
  for (const t of registry.allRelationshipTypes()) {
    relKeyById.set(t.id, t.key);
    relIdByKey.set(t.key, t.id);
  }

  const toEntity = (r: EntityRow): Entity => ({
    id: asEntityId(r.id),
    orgId: r.org_id as OrgId,
    entityTypeId: asEntityTypeId(r.entity_type_id),
    entityTypeKey: typeKeyById.get(r.entity_type_id) ?? r.entity_type_id,
    canonicalKey: r.canonical_key,
    name: r.name,
    description: r.description,
    sourceSystem: r.source_system as SourceSystem,
    sourceEntityType: r.source_entity_type,
    sourceEntityId: r.source_entity_id,
    validFrom: asValidTime(r.valid_from),
    validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
    observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
    ingestedAt: asRecordTime(r.ingested_at),
    updatedAt: asRecordTime(r.updated_at),
    version: r.version,
    confidence: num(r.confidence),
    attributes: r.attributes ?? {},
    status: r.status as Entity['status'],
    mergedIntoId: r.merged_into_id === null ? null : asEntityId(r.merged_into_id),
    createdBy: (r.created_by ?? null) as Entity['createdBy'],
  });

  const toRelationship = (r: RelationshipRow): Relationship => ({
    id: asRelationshipId(r.id),
    orgId: r.org_id as OrgId,
    relationshipTypeId: asRelationshipTypeId(r.relationship_type_id),
    relationshipTypeKey: relKeyById.get(r.relationship_type_id) ?? r.relationship_type_id,
    sourceEntityId: asEntityId(r.source_entity_id),
    targetEntityId: asEntityId(r.target_entity_id),
    weight: num(r.weight),
    confidence: num(r.confidence),
    validFrom: asValidTime(r.valid_from),
    validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
    observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
    ingestedAt: asRecordTime(r.ingested_at),
    updatedAt: asRecordTime(r.updated_at),
    sourceSystem: r.source_system as SourceSystem,
    sourceObjectType: r.source_object_type,
    sourceObjectId: r.source_object_id,
    metadata: r.metadata ?? {},
    createdBy: (r.created_by ?? null) as Relationship['createdBy'],
  });

  const ENTITY_COLS =
    'id, org_id, entity_type_id, canonical_key, name, description, source_system, ' +
    'source_entity_type, source_entity_id, valid_from, valid_to, observed_at, ' +
    'ingested_at, updated_at, version, confidence, attributes, status, ' +
    'merged_into_id, created_by';

  const REL_COLS =
    'id, org_id, relationship_type_id, source_entity_id, target_entity_id, weight, ' +
    'confidence, valid_from, valid_to, observed_at, ingested_at, updated_at, ' +
    'source_system, source_object_type, source_object_id, metadata, created_by';

  /** Valid-time predicate applied client-side, matching the in-memory adapter. */
  const validAt = (
    row: { valid_from: string; valid_to: string | null },
    asOf?: Date | string,
  ): boolean =>
    isValidAt(
      {
        validFrom: asValidTime(row.valid_from),
        validTo: row.valid_to === null ? null : asValidTime(row.valid_to),
      },
      asOf ?? clock.now(),
    );

  function entityMatchesType(
    e: Entity,
    keys: readonly string[],
    includeSubtypes = true,
  ): boolean {
    if (keys.length === 0) return true;
    if (keys.includes(e.entityTypeKey)) return true;
    return includeSubtypes ? keys.some((k) => registry.isA(e.entityTypeKey, k)) : false;
  }

  /** Every type id whose key is, or inherits from, one of `keys`. */
  function expandTypeIds(keys: readonly string[], includeSubtypes: boolean): string[] {
    const out = new Set<string>();
    for (const t of registry.allEntityTypes()) {
      const match =
        keys.includes(t.key) || (includeSubtypes && keys.some((k) => registry.isA(t.key, k)));
      if (match) out.add(t.id);
    }
    return [...out];
  }

  async function fetchEntitiesByIds(
    scope: Scope,
    ids: readonly string[],
  ): Promise<Map<string, Entity>> {
    const map = new Map<string, Entity>();
    if (ids.length === 0) return map;
    // Batched, so a traversal level costs one query rather than one per node.
    const { data, error } = await client
      .from('helm_entities')
      .select(ENTITY_COLS)
      .eq('org_id', scope.orgId)
      .in('id', [...ids]);
    if (error) throw new Error(`helm_entities read failed: ${error.message}`);
    for (const row of (data ?? []) as EntityRow[]) {
      map.set(row.id, toEntity(row));
    }
    return map;
  }

  /** All currently-selected edges touching `ids`, in one query. */
  async function fetchEdgesFor(
    scope: Scope,
    ids: readonly string[],
    // Direction is applied per-edge in stepsFrom, not here: an undirected type
    // must be fetched from both endpoints regardless of the requested direction.
    _direction: Direction,
    relTypeKeys: readonly string[] | undefined,
    asOf: Date | string | undefined,
    minConfidence: Confidence | undefined,
  ): Promise<RelationshipRow[]> {
    if (ids.length === 0) return [];
    const idList = `(${ids.join(',')})`;
    let q = client
      .from('helm_relationships')
      .select(REL_COLS)
      .eq('org_id', scope.orgId);

    // Undirected types must be walkable from either end regardless of which way
    // the row was written, so both endpoints are always fetched and direction is
    // applied per-edge below.
    q = q.or(`source_entity_id.in.${idList},target_entity_id.in.${idList}`);

    if (relTypeKeys && relTypeKeys.length > 0) {
      const typeIds = relTypeKeys
        .map((k) => relIdByKey.get(k))
        .filter((v): v is string => Boolean(v));
      if (typeIds.length === 0) return [];
      q = q.in('relationship_type_id', typeIds);
    }

    const { data, error } = await q;
    if (error) throw new Error(`helm_relationships read failed: ${error.message}`);

    return ((data ?? []) as RelationshipRow[]).filter((r) => {
      if (!validAt(r, asOf)) return false;
      if (minConfidence !== undefined && (num(r.confidence) ?? 1) < minConfidence) return false;
      return true;
    });
  }

  type Step = { rel: RelationshipRow; other: string; dir: 'out' | 'in' };

  function stepsFrom(
    edges: readonly RelationshipRow[],
    fromId: string,
    direction: Direction,
  ): Step[] {
    const out: Step[] = [];
    for (const rel of edges) {
      const key = relKeyById.get(rel.relationship_type_id);
      const def = key ? registry.relationshipType(key) : null;
      const undirected = def ? !def.isDirected : false;
      if (rel.source_entity_id === fromId && (direction !== 'in' || undirected)) {
        out.push({ rel, other: rel.target_entity_id, dir: 'out' });
      }
      if (rel.target_entity_id === fromId && (direction !== 'out' || undirected)) {
        out.push({ rel, other: rel.source_entity_id, dir: 'in' });
      }
    }
    return out;
  }

  const store: GraphStore = {
    async createEntity(scope, input) {
      const validation = registry.validateEntity(input);
      if (!validation.ok) return validation;

      const existing = await store.getEntityByCanonicalKey(
        scope,
        input.entityTypeKey,
        input.canonicalKey,
      );
      if (existing.ok && existing.value) {
        return fail(
          ErrorCodes.ONTOLOGY_DUPLICATE_TYPE,
          `An entity with canonical key "${input.canonicalKey}" already exists for type ` +
            `${input.entityTypeKey}. Use upsertEntity for idempotent ingestion.`,
          { canonicalKey: input.canonicalKey },
        );
      }
      return store.upsertEntity(scope, input);
    },

    async upsertEntity(scope, input) {
      const validation = registry.validateEntity(input);
      if (!validation.ok) return validation;

      const typeId = typeIdByKey.get(input.entityTypeKey);
      if (!typeId) {
        return fail(
          ErrorCodes.ONTOLOGY_UNKNOWN_ENTITY_TYPE,
          `Unknown entity type "${input.entityTypeKey}".`,
        );
      }

      // One RPC, so the entity write and its version row cannot be half-applied.
      const { data, error } = await client.rpc('helm_write_entity', {
        p_org_id: scope.orgId,
        p_entity_type_id: typeId,
        p_canonical_key: input.canonicalKey,
        p_name: input.name,
        p_description: input.description ?? null,
        p_source_system: input.sourceSystem,
        p_source_entity_type: input.sourceEntityType ?? null,
        p_source_entity_id: input.sourceEntityId ?? null,
        p_valid_from: input.validFrom ?? null,
        p_valid_to: input.validTo ?? null,
        p_observed_at: input.observedAt ?? null,
        p_confidence: input.confidence ?? null,
        p_attributes: input.attributes ?? {},
        p_status: 'active',
        p_actor: scope.actorId,
      });
      if (error) {
        return fail(ErrorCodes.GRAPH_WRITE_FAILED, `Entity write failed: ${error.message}`);
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        return fail(ErrorCodes.GRAPH_WRITE_FAILED, 'Entity write returned no row.');
      }
      const entity = await store.getEntity(scope, asEntityId(row.out_entity_id));
      if (!entity.ok) return entity;
      if (!entity.value) {
        return fail(ErrorCodes.GRAPH_WRITE_FAILED, 'Entity written but not readable.');
      }
      return ok({ entity: entity.value, outcome: row.out_outcome as EntityWriteResult['outcome'] });
    },

    async updateEntity(scope, id, patch: EntityPatch) {
      const current = await store.getEntity(scope, id);
      if (!current.ok) return current;
      if (!current.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${id} not found in this organization.`,
        );
      }
      const e = current.value;
      const typeId = typeIdByKey.get(e.entityTypeKey)!;

      const merged: EntityInput = {
        entityTypeKey: e.entityTypeKey,
        canonicalKey: e.canonicalKey,
        name: patch.name ?? e.name,
        description: patch.description ?? e.description,
        sourceSystem: e.sourceSystem,
        sourceEntityType: patch.sourceEntityType ?? e.sourceEntityType,
        sourceEntityId: patch.sourceEntityId ?? e.sourceEntityId,
        validFrom: patch.validFrom ?? e.validFrom,
        validTo: patch.validTo === undefined ? e.validTo : patch.validTo,
        observedAt: patch.observedAt ?? e.observedAt,
        confidence: patch.confidence === undefined ? e.confidence : patch.confidence,
        attributes: patch.attributes ?? { ...e.attributes },
      };
      const validation = registry.validateEntity(merged);
      if (!validation.ok) return validation;

      const { data, error } = await client.rpc('helm_write_entity', {
        p_org_id: scope.orgId,
        p_entity_type_id: typeId,
        p_canonical_key: e.canonicalKey,
        p_name: merged.name,
        p_description: merged.description ?? null,
        p_source_system: merged.sourceSystem,
        p_source_entity_type: merged.sourceEntityType ?? null,
        p_source_entity_id: merged.sourceEntityId ?? null,
        p_valid_from: merged.validFrom ?? null,
        p_valid_to: merged.validTo ?? null,
        p_observed_at: merged.observedAt ?? null,
        p_confidence: merged.confidence ?? null,
        p_attributes: merged.attributes ?? {},
        p_status: patch.status ?? e.status,
        p_actor: scope.actorId,
      });
      if (error) {
        return fail(ErrorCodes.GRAPH_WRITE_FAILED, `Entity update failed: ${error.message}`);
      }
      const row = Array.isArray(data) ? data[0] : data;
      const refreshed = await store.getEntity(scope, id);
      if (!refreshed.ok) return refreshed;
      return ok({
        entity: refreshed.value!,
        outcome: (row?.out_outcome ?? 'updated') as EntityWriteResult['outcome'],
      });
    },

    async getEntity(scope, id) {
      const { data, error } = await client
        .from('helm_entities')
        .select(ENTITY_COLS)
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Entity read failed: ${error.message}`);
      }
      return ok(data ? toEntity(data as EntityRow) : null);
    },

    async getEntityByCanonicalKey(scope, entityTypeKey, canonicalKey) {
      const typeId = typeIdByKey.get(entityTypeKey);
      if (!typeId) return ok(null);
      const { data, error } = await client
        .from('helm_entities')
        .select(ENTITY_COLS)
        .eq('org_id', scope.orgId)
        .eq('entity_type_id', typeId)
        .eq('canonical_key', canonicalKey)
        .maybeSingle();
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Entity read failed: ${error.message}`);
      }
      return ok(data ? toEntity(data as EntityRow) : null);
    },

    async findEntities(scope, query: EntityQuery) {
      let q = client.from('helm_entities').select(ENTITY_COLS).eq('org_id', scope.orgId);

      if (query.entityTypeKeys?.length) {
        const ids = expandTypeIds(query.entityTypeKeys, query.includeSubtypes !== false);
        if (ids.length === 0) return ok([]);
        q = q.in('entity_type_id', ids);
      }
      if (query.canonicalKeys?.length) q = q.in('canonical_key', [...query.canonicalKeys]);
      if (query.sourceSystem) q = q.eq('source_system', query.sourceSystem);
      if (query.sourceEntityId) q = q.eq('source_entity_id', query.sourceEntityId);
      if (!query.includeInactive) q = q.eq('status', 'active');

      const { data, error } = await q.limit(2000);
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Entity query failed: ${error.message}`);
      }

      let rows = ((data ?? []) as EntityRow[]).map(toEntity);

      if (query.search) {
        const s = query.search.toLowerCase();
        rows = rows.filter(
          (e) => e.name.toLowerCase().includes(s) || e.canonicalKey.toLowerCase().includes(s),
        );
      }
      // Same rule as the in-memory adapter: includeInactive with no explicit
      // asOf is an archival query and applies no valid-time filter.
      if (query.asOf !== undefined) {
        rows = rows.filter((e) =>
          validAt({ valid_from: e.validFrom, valid_to: e.validTo }, query.asOf),
        );
      } else if (!query.includeInactive) {
        rows = rows.filter((e) =>
          validAt({ valid_from: e.validFrom, valid_to: e.validTo }, undefined),
        );
      }

      rows.sort((a, b) => a.name.localeCompare(b.name));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 500;
      return ok(rows.slice(offset, offset + limit));
    },

    async retireEntity(scope, id, at) {
      const when = toIso(at ?? clock.now());
      const r = await store.updateEntity(scope, id, {
        status: 'retired',
        validTo: asValidTime(when),
      });
      if (!r.ok) return r;
      return ok(r.value.entity);
    },

    async getEntityHistory(scope, id) {
      const { data, error } = await client
        .from('helm_entity_versions')
        .select('entity_id, org_id, version, change_kind, snapshot, valid_from, valid_to, observed_at, recorded_from, recorded_to, changed_by')
        .eq('org_id', scope.orgId)
        .eq('entity_id', id)
        .order('version', { ascending: true });
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `History read failed: ${error.message}`);
      }
      const rows = (data ?? []).map(
        (v: VersionRow): EntityVersion => ({
          entityId: asEntityId(v.entity_id),
          orgId: v.org_id as OrgId,
          version: v.version,
          changeKind: v.change_kind,
          snapshot: toEntity(v.snapshot as EntityRow),
          validFrom: asValidTime(v.valid_from),
          validTo: v.valid_to === null ? null : asValidTime(v.valid_to),
          observedAt: v.observed_at === null ? null : asValidTime(v.observed_at),
          recordedFrom: asRecordTime(v.recorded_from),
          recordedTo: v.recorded_to === null ? null : asRecordTime(v.recorded_to),
          changedBy: v.changed_by ?? null,
        }),
      );
      return ok(rows);
    },

    async getEntityAsRecordedAt(scope, id, recordedAt) {
      const history = await store.getEntityHistory(scope, id);
      if (!history.ok) return history;
      const v = history.value.find((x) =>
        wasRecordedAt({ recordedFrom: x.recordedFrom, recordedTo: x.recordedTo }, recordedAt),
      );
      return ok(v ? v.snapshot : null);
    },

    async createRelationship(scope, input: RelationshipInput) {
      const [source, target] = await Promise.all([
        store.getEntity(scope, input.sourceEntityId),
        store.getEntity(scope, input.targetEntityId),
      ]);
      if (!source.ok) return source;
      if (!target.ok) return target;
      if (!source.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Source entity ${input.sourceEntityId} not found in this organization.`,
        );
      }
      if (!target.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Target entity ${input.targetEntityId} not found in this organization.`,
        );
      }

      const validation = registry.validateRelationship(
        input,
        source.value.entityTypeKey,
        target.value.entityTypeKey,
      );
      if (!validation.ok) return validation;

      const typeId = relIdByKey.get(input.relationshipTypeKey);
      if (!typeId) {
        return fail(
          ErrorCodes.ONTOLOGY_UNKNOWN_RELATIONSHIP_TYPE,
          `Unknown relationship type "${input.relationshipTypeKey}".`,
        );
      }

      const { data, error } = await client
        .from('helm_relationships')
        .insert({
          org_id: scope.orgId,
          relationship_type_id: typeId,
          source_entity_id: input.sourceEntityId,
          target_entity_id: input.targetEntityId,
          weight: input.weight ?? null,
          confidence: input.confidence ?? null,
          valid_from: input.validFrom ?? toIso(clock.now()),
          valid_to: input.validTo ?? null,
          observed_at: input.observedAt ?? null,
          source_system: input.sourceSystem,
          source_object_type: input.sourceObjectType ?? null,
          source_object_id: input.sourceObjectId ?? null,
          metadata: input.metadata ?? {},
          created_by: scope.actorId,
        })
        .select(REL_COLS)
        .single();
      if (error) {
        return fail(
          ErrorCodes.GRAPH_WRITE_FAILED,
          `Relationship write failed: ${error.message}`,
        );
      }
      return ok(toRelationship(data as RelationshipRow));
    },

    async removeRelationship(scope, id: RelationshipId, at) {
      const when = toIso(at ?? clock.now());
      const { data, error } = await client
        .from('helm_relationships')
        .update({ valid_to: when })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(REL_COLS)
        .maybeSingle();
      if (error) {
        return fail(
          ErrorCodes.GRAPH_WRITE_FAILED,
          `Relationship close failed: ${error.message}`,
        );
      }
      if (!data) {
        return fail(
          ErrorCodes.GRAPH_RELATIONSHIP_NOT_FOUND,
          `Relationship ${id} not found in this organization.`,
        );
      }
      return ok(toRelationship(data as RelationshipRow));
    },

    async findRelationships(scope, query: RelationshipQuery) {
      let q = client.from('helm_relationships').select(REL_COLS).eq('org_id', scope.orgId);

      if (query.relationshipTypeKeys?.length) {
        const ids = query.relationshipTypeKeys
          .map((k) => relIdByKey.get(k))
          .filter((v): v is string => Boolean(v));
        if (ids.length === 0) return ok([]);
        q = q.in('relationship_type_id', ids);
      }
      if (query.sourceEntityId) q = q.eq('source_entity_id', query.sourceEntityId);
      if (query.targetEntityId) q = q.eq('target_entity_id', query.targetEntityId);
      if (query.eitherEndpoint) {
        q = q.or(
          `source_entity_id.eq.${query.eitherEndpoint},target_entity_id.eq.${query.eitherEndpoint}`,
        );
      }

      const { data, error } = await q.limit(2000);
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Relationship query failed: ${error.message}`);
      }

      let rows = (data ?? []) as RelationshipRow[];
      if (!(query.includeClosed && query.asOf === undefined)) rows = rows.filter((r) => validAt(r, query.asOf));
      if (query.minConfidence !== undefined) {
        rows = rows.filter((r) => (num(r.confidence) ?? 1) >= query.minConfidence!);
      }
      const mapped = rows.map(toRelationship);
      mapped.sort((a, b) => a.relationshipTypeKey.localeCompare(b.relationshipTypeKey) || a.id.localeCompare(b.id));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 500;
      return ok(mapped.slice(offset, offset + limit));
    },

    async getNeighbors(scope, query: NeighborQuery) {
      const self = await store.getEntity(scope, query.entityId);
      if (!self.ok) return self;
      if (!self.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${query.entityId} not found in this organization.`,
        );
      }

      const edges = await fetchEdgesFor(
        scope,
        [query.entityId],
        query.direction,
        query.relationshipTypeKeys,
        query.asOf,
        query.minConfidence,
      );
      const steps = stepsFrom(edges, query.entityId, query.direction);
      const others = await fetchEntitiesByIds(scope, steps.map((s) => s.other));

      const out: Neighbor[] = [];
      for (const s of steps) {
        const entity = others.get(s.other);
        if (!entity) continue;
        if (!validAt({ valid_from: entity.validFrom, valid_to: entity.validTo }, query.asOf)) {
          continue;
        }
        if (query.entityTypeKeys?.length && !entityMatchesType(entity, query.entityTypeKeys)) {
          continue;
        }
        out.push({ entity, via: toRelationship(s.rel), direction: s.dir });
      }
      return ok(out);
    },

    async traverse(scope, spec: TraversalSpec) {
      if (spec.maxDepth === undefined || spec.maxDepth === null) {
        return fail(ErrorCodes.GRAPH_DEPTH_REQUIRED, 'traverse() requires maxDepth.');
      }
      if (spec.maxDepth < 0 || spec.maxDepth > MAX_ALLOWED_DEPTH) {
        return fail(
          ErrorCodes.GRAPH_DEPTH_EXCEEDED,
          `maxDepth must be between 0 and ${MAX_ALLOWED_DEPTH}, got ${spec.maxDepth}.`,
          { maxDepth: spec.maxDepth, limit: MAX_ALLOWED_DEPTH },
        );
      }

      const maxNodes = spec.maxNodes ?? DEFAULT_MAX_NODES;
      const visited = new Map<string, TraversalNode>();
      const usedRels = new Map<string, Relationship>();
      let truncated = false;

      const starts = await fetchEntitiesByIds(scope, [...spec.start]);
      let frontier: { id: string; path: string[]; conf: number[] }[] = [];
      for (const startId of spec.start) {
        const e = starts.get(startId);
        if (!e) continue;
        if (!validAt({ valid_from: e.validFrom, valid_to: e.validTo }, spec.asOf)) continue;
        visited.set(startId, { entity: e, depth: 0, path: [], pathConfidence: 1 });
        frontier.push({ id: startId, path: [], conf: [] });
      }

      // One batched query per level: round trips are bounded by maxDepth, not by
      // node count. A recursive CTE would be one round trip; see the note above.
      for (let depth = 0; depth < spec.maxDepth && frontier.length > 0; depth += 1) {
        const edges = await fetchEdgesFor(
          scope,
          frontier.map((f) => f.id),
          spec.direction,
          spec.relationshipTypeKeys,
          spec.asOf,
          spec.minConfidence,
        );
        if (edges.length === 0) break;

        const candidates: { other: string; rel: RelationshipRow; path: string[]; conf: number[] }[] = [];
        for (const f of frontier) {
          for (const s of stepsFrom(edges, f.id, spec.direction)) {
            candidates.push({
              other: s.other,
              rel: s.rel,
              path: [...f.path, s.rel.id],
              conf: [...f.conf, num(s.rel.confidence) ?? 1],
            });
          }
        }

        const nextEntities = await fetchEntitiesByIds(
          scope,
          candidates.map((c) => c.other),
        );
        const nextFrontier: typeof frontier = [];

        for (const c of candidates) {
          const entity = nextEntities.get(c.other);
          if (!entity) continue;
          if (!validAt({ valid_from: entity.validFrom, valid_to: entity.validTo }, spec.asOf)) {
            continue;
          }
          if (spec.entityTypeKeys?.length && !entityMatchesType(entity, spec.entityTypeKeys)) {
            continue;
          }
          usedRels.set(c.rel.id, toRelationship(c.rel));

          if (visited.has(c.other)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            break;
          }
          visited.set(c.other, {
            entity,
            depth: depth + 1,
            path: c.path.map(asRelationshipId),
            pathConfidence: chainConfidence(c.conf),
          });
          nextFrontier.push({ id: c.other, path: c.path, conf: c.conf });
        }
        if (truncated) break;
        frontier = nextFrontier;
      }

      const nodes = [...visited.values()].sort((a, b) =>
        a.depth === b.depth ? a.entity.name.localeCompare(b.entity.name) : a.depth - b.depth,
      );
      const relationships = [...usedRels.values()].sort((a, b) => a.id.localeCompare(b.id));
      const result: TraversalResult = { nodes, relationships, truncated };
      return ok(result);
    },

    async paths(scope, from: EntityId, to: EntityId, spec: PathSpec) {
      if (spec.maxDepth < 0 || spec.maxDepth > MAX_ALLOWED_DEPTH) {
        return fail(
          ErrorCodes.GRAPH_DEPTH_EXCEEDED,
          `maxDepth must be between 0 and ${MAX_ALLOWED_DEPTH}, got ${spec.maxDepth}.`,
        );
      }
      const start = await store.getEntity(scope, from);
      if (!start.ok) return start;
      if (!start.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${from} not found in this organization.`,
        );
      }

      // Pull the reachable subgraph once, then enumerate paths locally — the
      // alternative is a query per DFS branch, which is far worse.
      const reach = await store.traverse(scope, {
        start: [from],
        maxDepth: spec.maxDepth,
        direction: spec.direction,
        relationshipTypeKeys: spec.relationshipTypeKeys,
        asOf: spec.asOf,
        maxNodes: DEFAULT_MAX_NODES,
      });
      if (!reach.ok) return reach;

      const edges = reach.value.relationships;
      const byId = new Map(edges.map((r) => [r.id, r]));
      const maxPaths = spec.maxPaths ?? 25;
      const found: GraphPath[] = [];

      const stepsLocal = (id: string): { rel: Relationship; other: string }[] => {
        const out: { rel: Relationship; other: string }[] = [];
        for (const rel of edges) {
          const def = registry.relationshipType(rel.relationshipTypeKey);
          const undirected = def ? !def.isDirected : false;
          if (rel.sourceEntityId === id && (spec.direction !== 'in' || undirected)) {
            out.push({ rel, other: rel.targetEntityId });
          }
          if (rel.targetEntityId === id && (spec.direction !== 'out' || undirected)) {
            out.push({ rel, other: rel.sourceEntityId });
          }
        }
        return out;
      };

      const walk = (
        current: string,
        depth: number,
        entityPath: string[],
        relPath: string[],
        confs: number[],
        lags: number[],
        onPath: Set<string>,
      ): void => {
        if (found.length >= maxPaths) return;
        if (current === to && entityPath.length > 1) {
          found.push({
            entityIds: entityPath.map(asEntityId),
            relationshipIds: relPath.map(asRelationshipId),
            pathConfidence: chainConfidence(confs),
            totalLagDays: lags.reduce((a, b) => a + b, 0),
          });
          return;
        }
        if (depth >= spec.maxDepth) return;

        for (const { rel, other } of stepsLocal(current)) {
          if (onPath.has(other)) continue;
          const lag = Number(byId.get(rel.id)?.metadata?.lagDays ?? 0) || 0;
          onPath.add(other);
          walk(
            other,
            depth + 1,
            [...entityPath, other],
            [...relPath, rel.id],
            [...confs, rel.confidence ?? 1],
            [...lags, lag],
            onPath,
          );
          onPath.delete(other);
        }
      };

      walk(from, 0, [from], [], [], [], new Set([from]));
      found.sort((a, b) => b.pathConfidence - a.pathConfidence);
      return ok(found);
    },

    async recordProvenance(scope, input: ProvenanceInput) {
      const { data, error } = await client
        .from('helm_provenance')
        .insert({
          org_id: scope.orgId,
          subject_kind: input.subjectKind,
          subject_id: input.subjectId,
          source_field: input.sourceField,
          method: input.method,
          system: input.system,
          connector: input.connector,
          source_object_type: input.sourceObjectType,
          source_object_id: input.sourceObjectId,
          ingestion_event_id: input.ingestionEventId,
          transformation: input.transformation,
          inputs: input.inputs,
          actor_id: input.actorId,
          confidence: input.confidence,
          notes: input.notes,
          payload: input.payload,
          observed_at: input.observedAt,
        })
        .select('*')
        .single();
      if (error) {
        return fail(
          ErrorCodes.GRAPH_WRITE_FAILED,
          `Provenance write failed: ${error.message}`,
        );
      }
      const r = data as ProvenanceRow;
      return ok({
        id: asProvenanceId(r.id),
        orgId: r.org_id as OrgId,
        subjectKind: r.subject_kind,
        subjectId: r.subject_id,
        sourceField: r.source_field,
        method: r.method,
        system: r.system,
        connector: r.connector,
        sourceObjectType: r.source_object_type,
        sourceObjectId: r.source_object_id,
        ingestionEventId: r.ingestion_event_id
          ? asIngestionEventId(r.ingestion_event_id)
          : null,
        transformation: r.transformation,
        inputs: r.inputs,
        actorId: r.actor_id,
        confidence: num(r.confidence),
        notes: r.notes,
        payload: r.payload,
        observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
        recordedAt: asRecordTime(r.recorded_at),
      } as ProvenanceRecord);
    },

    async getProvenance(scope, subjectKind, subjectId) {
      const { data, error } = await client
        .from('helm_provenance')
        .select('*')
        .eq('org_id', scope.orgId)
        .eq('subject_kind', subjectKind)
        .eq('subject_id', subjectId)
        .order('recorded_at', { ascending: false });
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Provenance read failed: ${error.message}`);
      }
      const rows = (data ?? []).map(
        (r: ProvenanceRow): ProvenanceRecord => ({
          id: asProvenanceId(r.id),
          orgId: r.org_id as OrgId,
          subjectKind: r.subject_kind,
          subjectId: r.subject_id,
          sourceField: r.source_field,
          method: r.method,
          system: r.system,
          connector: r.connector,
          sourceObjectType: r.source_object_type,
          sourceObjectId: r.source_object_id,
          ingestionEventId: r.ingestion_event_id
            ? asIngestionEventId(r.ingestion_event_id)
            : null,
          transformation: r.transformation,
          inputs: r.inputs,
          actorId: r.actor_id,
          confidence: num(r.confidence),
          notes: r.notes,
          payload: r.payload,
          observedAt: r.observed_at === null ? null : asValidTime(r.observed_at),
          recordedAt: asRecordTime(r.recorded_at),
        }),
      );
      return ok(rows);
    },

    async startIngestionEvent(scope, system: SourceSystem, connector, cursor) {
      const { data, error } = await client
        .from('helm_ingestion_events')
        .insert({
          org_id: scope.orgId,
          system,
          connector,
          cursor: cursor ?? null,
          status: 'running',
          record_count: 0,
        })
        .select('*')
        .single();
      if (error) {
        return fail(
          ErrorCodes.GRAPH_WRITE_FAILED,
          `Ingestion event start failed: ${error.message}`,
        );
      }
      const r = data as IngestionEventRow;
      return ok({
        id: asIngestionEventId(r.id),
        orgId: r.org_id as OrgId,
        system: r.system,
        connector: r.connector,
        cursor: r.cursor,
        startedAt: asRecordTime(r.started_at),
        finishedAt: r.finished_at === null ? null : asRecordTime(r.finished_at),
        status: r.status,
        recordCount: r.record_count,
        notes: r.notes,
      } as IngestionEvent);
    },

    async finishIngestionEvent(
      scope,
      id: IngestionEventId,
      status,
      recordCount,
      notes,
    ) {
      const { data, error } = await client
        .from('helm_ingestion_events')
        .update({
          status,
          record_count: recordCount,
          notes: notes ?? null,
          finished_at: toIso(clock.now()),
        })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error) {
        return fail(
          ErrorCodes.GRAPH_WRITE_FAILED,
          `Ingestion event finish failed: ${error.message}`,
        );
      }
      if (!data) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Ingestion event ${id} not found.`);
      }
      const r = data as IngestionEventRow;
      return ok({
        id: asIngestionEventId(r.id),
        orgId: r.org_id as OrgId,
        system: r.system,
        connector: r.connector,
        cursor: r.cursor,
        startedAt: asRecordTime(r.started_at),
        finishedAt: r.finished_at === null ? null : asRecordTime(r.finished_at),
        status: r.status,
        recordCount: r.record_count,
        notes: r.notes,
      } as IngestionEvent);
    },

    async addAlias(scope, input: EntityAliasInput) {
      const entity = await store.getEntity(scope, input.entityId);
      if (!entity.ok) return entity;
      if (!entity.value) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${input.entityId} not found in this organization.`,
        );
      }
      // Idempotent: the same external identifier asserted twice is one alias,
      // not two. A unique index backs this server-side; the pre-read keeps the
      // adapter's return value consistent with the in-memory reference.
      const normalized = normalizeAlias(input.aliasValue);
      const { data: dupe } = await client
        .from('helm_entity_aliases')
        .select('*')
        .eq('org_id', scope.orgId)
        .eq('entity_id', input.entityId)
        .eq('system', input.system)
        .eq('alias_kind', input.aliasKind)
        .eq('normalized_value', normalized)
        .is('valid_to', null)
        .maybeSingle();
      if (dupe) {
        const d = dupe as AliasRow;
        return ok({
          id: asAliasId(d.id),
          orgId: d.org_id as OrgId,
          entityId: asEntityId(d.entity_id),
          system: d.system,
          aliasKind: d.alias_kind,
          aliasValue: d.alias_value,
          normalizedValue: d.normalized_value,
          matchMethod: d.match_method,
          confidence: num(d.confidence),
          evidence: d.evidence,
          validFrom: asValidTime(d.valid_from),
          validTo: d.valid_to === null ? null : asValidTime(d.valid_to),
          createdBy: d.created_by ?? null,
        } as EntityAlias);
      }

      const { data, error } = await client
        .from('helm_entity_aliases')
        .insert({
          org_id: scope.orgId,
          entity_id: input.entityId,
          system: input.system,
          alias_kind: input.aliasKind,
          alias_value: input.aliasValue,
          normalized_value: normalized,
          match_method: input.matchMethod,
          confidence: input.confidence ?? null,
          evidence: input.evidence ?? null,
          valid_from: input.validFrom ?? toIso(clock.now()),
          valid_to: input.validTo ?? null,
          created_by: scope.actorId,
        })
        .select('*')
        .single();
      if (error) {
        return fail(ErrorCodes.GRAPH_WRITE_FAILED, `Alias write failed: ${error.message}`);
      }
      const r = data as AliasRow;
      return ok({
        id: asAliasId(r.id),
        orgId: r.org_id as OrgId,
        entityId: asEntityId(r.entity_id),
        system: r.system,
        aliasKind: r.alias_kind,
        aliasValue: r.alias_value,
        normalizedValue: r.normalized_value,
        matchMethod: r.match_method,
        confidence: num(r.confidence),
        evidence: r.evidence,
        validFrom: asValidTime(r.valid_from),
        validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
        createdBy: r.created_by ?? null,
      } as EntityAlias);
    },

    async findByAlias(scope, system: SourceSystem, aliasValue) {
      const { data, error } = await client
        .from('helm_entity_aliases')
        .select('entity_id')
        .eq('org_id', scope.orgId)
        .eq('system', system)
        .eq('normalized_value', normalizeAlias(aliasValue))
        .is('valid_to', null);
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Alias lookup failed: ${error.message}`);
      }
      // Distinct entities: several alias rows may point at the same entity.
      const rows = (data ?? []) as { entity_id: string }[];
      const ids: string[] = [...new Set<string>(rows.map((r) => r.entity_id))];
      if (ids.length === 0) return ok([]);
      const map = await fetchEntitiesByIds(scope, ids);
      return ok([...map.values()]);
    },

    async getAliases(scope, entityId: EntityId) {
      const { data, error } = await client
        .from('helm_entity_aliases')
        .select('*')
        .eq('org_id', scope.orgId)
        .eq('entity_id', entityId)
        .order('alias_value', { ascending: true });
      if (error) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Alias read failed: ${error.message}`);
      }
      const rows = (data ?? []).map(
        (r: AliasRow): EntityAlias => ({
          id: asAliasId(r.id),
          orgId: r.org_id as OrgId,
          entityId: asEntityId(r.entity_id),
          system: r.system,
          aliasKind: r.alias_kind,
          aliasValue: r.alias_value,
          normalizedValue: r.normalized_value,
          matchMethod: r.match_method,
          confidence: num(r.confidence),
          evidence: r.evidence,
          validFrom: asValidTime(r.valid_from),
          validTo: r.valid_to === null ? null : asValidTime(r.valid_to),
          createdBy: r.created_by ?? null,
        }),
      );
      return ok(rows);
    },
  };

  return store;
}
