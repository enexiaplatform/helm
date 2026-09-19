/**
 * InMemoryGraphStore — the reference implementation.
 *
 * It exists for two reasons beyond testing convenience:
 *
 *   1. It defines the *semantics* the Postgres adapter must match. When the two
 *      disagree, this one is usually right, because it is the one you can read.
 *   2. It lets every kernel package above graph-store be unit-tested with no
 *      database at all, which is what keeps the test suite in milliseconds.
 *
 * Org scoping is enforced here too, not just in RLS: a store that ignored
 * `scope.orgId` would pass its own tests while being catastrophically wrong.
 */

import {
  ErrorCodes,
  asAliasId,
  asEntityId,
  asIngestionEventId,
  asProvenanceId,
  asRelationshipId,
  asValidTime,
  asRecordTime,
  chainConfidence,
  clampConfidence,
  fail,
  isValidAt,
  ok,
  toIso,
  wasRecordedAt,
  type Clock,
  type Confidence,
  type EntityId,
  type IdGen,
  type IngestionEvent,
  type IngestionEventId,
  type ProvenanceInput,
  type ProvenanceRecord,
  type RelationshipId,
  type Result,
  type Scope,
  type SourceSystem,
} from '@helm/shared';
import {
  normalizeAlias,
  type Entity,
  type EntityAlias,
  type EntityAliasInput,
  type EntityInput,
  type EntityVersion,
  type OntologyRegistry,
  type Relationship,
  type RelationshipInput,
} from '@helm/ontology';
import type {
  Direction,
  EntityQuery,
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

export type InMemoryGraphStoreOptions = {
  registry: OntologyRegistry;
  clock: Clock;
  idGen: IdGen;
};

type Stored = {
  entities: Map<string, Entity>;
  versions: EntityVersion[];
  relationships: Map<string, Relationship>;
  provenance: ProvenanceRecord[];
  ingestionEvents: Map<string, IngestionEvent>;
  aliases: Map<string, EntityAlias>;
};

/** Attribute comparison for idempotency: order-insensitive, value-sensitive. */
function sameAttributes(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  if (ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export function createInMemoryGraphStore(opts: InMemoryGraphStoreOptions): GraphStore {
  const { registry, clock, idGen } = opts;
  const db: Stored = {
    entities: new Map(),
    versions: [],
    relationships: new Map(),
    provenance: [],
    ingestionEvents: new Map(),
    aliases: new Map(),
  };

  const nowIso = () => clock.now().toISOString();

  // ------------------------------------------------------------- scoping

  const inOrg = <T extends { orgId: string }>(scope: Scope, row: T): boolean =>
    row.orgId === scope.orgId;

  const liveEntities = (scope: Scope): Entity[] =>
    [...db.entities.values()].filter((e) => inOrg(scope, e));

  const liveRelationships = (scope: Scope): Relationship[] =>
    [...db.relationships.values()].filter((r) => inOrg(scope, r));

  function entityMatchesType(e: Entity, keys: readonly string[], includeSub = true): boolean {
    if (keys.length === 0) return true;
    if (keys.includes(e.entityTypeKey)) return true;
    return includeSub ? keys.some((k) => registry.isA(e.entityTypeKey, k)) : false;
  }

  const validAt = (
    row: { validFrom: string; validTo: string | null },
    asOf?: Date | string,
  ): boolean =>
    isValidAt(
      { validFrom: asValidTime(row.validFrom), validTo: row.validTo === null ? null : asValidTime(row.validTo) },
      asOf ?? clock.now(),
    );

  // ------------------------------------------------------------ versioning

  function pushVersion(
    entity: Entity,
    changeKind: EntityVersion['changeKind'],
    recordedFrom: string,
  ): void {
    // Close the previous open version — this is the record-time chain.
    const prev = db.versions.find(
      (v) => v.entityId === entity.id && v.recordedTo === null,
    );
    if (prev) {
      const idx = db.versions.indexOf(prev);
      db.versions[idx] = { ...prev, recordedTo: asRecordTime(recordedFrom) };
    }
    db.versions.push({
      entityId: entity.id,
      orgId: entity.orgId,
      version: entity.version,
      changeKind,
      snapshot: { ...entity, attributes: { ...entity.attributes } },
      validFrom: entity.validFrom,
      validTo: entity.validTo,
      observedAt: entity.observedAt,
      recordedFrom: asRecordTime(recordedFrom),
      recordedTo: null,
      changedBy: entity.createdBy,
    });
  }

  // -------------------------------------------------------------- traversal

  function edgesFrom(
    scope: Scope,
    entityId: EntityId,
    direction: Direction,
    relTypeKeys: readonly string[] | undefined,
    asOf: Date | string | undefined,
    minConfidence: Confidence | undefined,
  ): { rel: Relationship; other: EntityId; dir: 'out' | 'in' }[] {
    const out: { rel: Relationship; other: EntityId; dir: 'out' | 'in' }[] = [];
    for (const rel of liveRelationships(scope)) {
      if (!validAt(rel, asOf)) continue;
      if (relTypeKeys && relTypeKeys.length > 0 && !relTypeKeys.includes(rel.relationshipTypeKey)) {
        continue;
      }
      if (minConfidence !== undefined && (rel.confidence ?? 1) < minConfidence) continue;

      const typeDef = registry.relationshipType(rel.relationshipTypeKey);
      const undirected = typeDef ? !typeDef.isDirected : false;

      // An undirected type (COMPETES_WITH, ALIGNS_WITH) is walkable from either
      // end regardless of which way the row was written.
      if (rel.sourceEntityId === entityId && (direction !== 'in' || undirected)) {
        out.push({ rel, other: rel.targetEntityId, dir: 'out' });
      }
      if (rel.targetEntityId === entityId && (direction !== 'out' || undirected)) {
        out.push({ rel, other: rel.sourceEntityId, dir: 'in' });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ store

  const store: GraphStore = {
    async createEntity(scope, input) {
      const validation = registry.validateEntity(input);
      if (!validation.ok) return validation;

      const existing = liveEntities(scope).find(
        (e) =>
          e.entityTypeKey === input.entityTypeKey && e.canonicalKey === input.canonicalKey,
      );
      if (existing) {
        return fail(
          ErrorCodes.ONTOLOGY_DUPLICATE_TYPE,
          `An entity with canonical key "${input.canonicalKey}" already exists for type ` +
            `${input.entityTypeKey}. Use upsertEntity for idempotent ingestion.`,
          { canonicalKey: input.canonicalKey },
        );
      }

      const typeDef = registry.entityType(input.entityTypeKey)!;
      const now = nowIso();
      const entity: Entity = {
        id: asEntityId(idGen.next()),
        orgId: scope.orgId,
        entityTypeId: typeDef.id,
        entityTypeKey: typeDef.key,
        canonicalKey: input.canonicalKey,
        name: input.name,
        description: input.description ?? null,
        sourceSystem: input.sourceSystem,
        sourceEntityType: input.sourceEntityType ?? null,
        sourceEntityId: input.sourceEntityId ?? null,
        validFrom: input.validFrom ?? asValidTime(now),
        validTo: input.validTo ?? null,
        observedAt: input.observedAt ?? null,
        ingestedAt: asRecordTime(now),
        updatedAt: asRecordTime(now),
        version: 1,
        confidence: input.confidence ?? null,
        attributes: { ...(input.attributes ?? {}) },
        status: 'active',
        mergedIntoId: null,
        createdBy: input.createdBy ?? null,
      };

      db.entities.set(entity.id, entity);
      pushVersion(entity, 'created', now);
      return ok({ entity, outcome: 'created' as const });
    },

    async updateEntity(scope, id, patch) {
      const current = db.entities.get(id);
      if (!current || !inOrg(scope, current)) {
        return fail(ErrorCodes.GRAPH_ENTITY_NOT_FOUND, `Entity ${id} not found in this organization.`);
      }

      const merged: EntityInput = {
        entityTypeKey: current.entityTypeKey,
        canonicalKey: current.canonicalKey,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        sourceSystem: current.sourceSystem,
        sourceEntityType: patch.sourceEntityType ?? current.sourceEntityType,
        sourceEntityId: patch.sourceEntityId ?? current.sourceEntityId,
        validFrom: patch.validFrom ?? current.validFrom,
        validTo: patch.validTo === undefined ? current.validTo : patch.validTo,
        observedAt: patch.observedAt ?? current.observedAt,
        confidence: patch.confidence === undefined ? current.confidence : patch.confidence,
        attributes: patch.attributes ?? { ...current.attributes },
      };
      const validation = registry.validateEntity(merged);
      if (!validation.ok) return validation;

      const unchanged =
        merged.name === current.name &&
        (merged.description ?? null) === current.description &&
        merged.validFrom === current.validFrom &&
        (merged.validTo ?? null) === current.validTo &&
        (merged.observedAt ?? null) === current.observedAt &&
        (merged.confidence ?? null) === current.confidence &&
        (patch.status ?? current.status) === current.status &&
        sameAttributes(merged.attributes ?? {}, current.attributes);

      if (unchanged) return ok({ entity: current, outcome: 'unchanged' as const });

      const now = nowIso();
      const next: Entity = {
        ...current,
        name: merged.name,
        description: merged.description ?? null,
        sourceEntityType: merged.sourceEntityType ?? null,
        sourceEntityId: merged.sourceEntityId ?? null,
        validFrom: merged.validFrom!,
        validTo: merged.validTo ?? null,
        observedAt: merged.observedAt ?? null,
        confidence: merged.confidence ?? null,
        attributes: { ...(merged.attributes ?? {}) },
        status: patch.status ?? current.status,
        updatedAt: asRecordTime(now),
        version: current.version + 1,
      };
      db.entities.set(next.id, next);
      pushVersion(next, patch.status === 'retired' ? 'retired' : 'updated', now);
      return ok({ entity: next, outcome: 'updated' as const });
    },

    async upsertEntity(scope, input) {
      const existing = liveEntities(scope).find(
        (e) =>
          e.entityTypeKey === input.entityTypeKey && e.canonicalKey === input.canonicalKey,
      );
      if (!existing) return store.createEntity(scope, input);
      return store.updateEntity(scope, existing.id, {
        name: input.name,
        description: input.description,
        validFrom: input.validFrom,
        validTo: input.validTo,
        observedAt: input.observedAt,
        confidence: input.confidence,
        attributes: input.attributes,
        sourceEntityId: input.sourceEntityId,
        sourceEntityType: input.sourceEntityType,
      });
    },

    async getEntity(scope, id) {
      const e = db.entities.get(id);
      return ok(e && inOrg(scope, e) ? e : null);
    },

    async getEntityByCanonicalKey(scope, entityTypeKey, canonicalKey) {
      const e = liveEntities(scope).find(
        (x) => x.entityTypeKey === entityTypeKey && x.canonicalKey === canonicalKey,
      );
      return ok(e ?? null);
    },

    async findEntities(scope, query: EntityQuery) {
      let rows = liveEntities(scope);

      if (query.entityTypeKeys?.length) {
        rows = rows.filter((e) =>
          entityMatchesType(e, query.entityTypeKeys!, query.includeSubtypes !== false),
        );
      }
      if (query.canonicalKeys?.length) {
        rows = rows.filter((e) => query.canonicalKeys!.includes(e.canonicalKey));
      }
      if (query.sourceSystem) {
        rows = rows.filter((e) => e.sourceSystem === query.sourceSystem);
      }
      if (query.sourceEntityId) {
        rows = rows.filter((e) => e.sourceEntityId === query.sourceEntityId);
      }
      if (query.search) {
        const q = query.search.toLowerCase();
        rows = rows.filter(
          (e) =>
            e.name.toLowerCase().includes(q) || e.canonicalKey.toLowerCase().includes(q),
        );
      }
      // Status and valid time are separate axes, but retiring closes validity —
      // so an archival query (includeInactive, no explicit asOf) must not also
      // apply a current-time filter, or retired rows could never be retrieved.
      if (!query.includeInactive) {
        rows = rows.filter((e) => e.status === 'active');
      }
      if (query.asOf !== undefined) {
        rows = rows.filter((e) => validAt(e, query.asOf));
      } else if (!query.includeInactive) {
        rows = rows.filter((e) => validAt(e, undefined));
      }

      rows.sort((a, b) => a.name.localeCompare(b.name));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 500;
      return ok(rows.slice(offset, offset + limit));
    },

    async retireEntity(scope, id, at) {
      const current = db.entities.get(id);
      if (!current || !inOrg(scope, current)) {
        return fail(ErrorCodes.GRAPH_ENTITY_NOT_FOUND, `Entity ${id} not found in this organization.`);
      }
      const when = toIso(at ?? clock.now());
      const next: Entity = {
        ...current,
        status: 'retired',
        validTo: asValidTime(when),
        updatedAt: asRecordTime(when),
        version: current.version + 1,
      };
      db.entities.set(id, next);
      pushVersion(next, 'retired', when);
      return ok(next);
    },

    async getEntityHistory(scope, id) {
      const rows = db.versions
        .filter((v) => v.entityId === id && v.orgId === scope.orgId)
        .sort((a, b) => a.version - b.version);
      return ok(rows);
    },

    async getEntityAsRecordedAt(scope, id, recordedAt) {
      const v = db.versions.find(
        (x) =>
          x.entityId === id &&
          x.orgId === scope.orgId &&
          wasRecordedAt({ recordedFrom: x.recordedFrom, recordedTo: x.recordedTo }, recordedAt),
      );
      return ok(v ? v.snapshot : null);
    },

    async createRelationship(scope, input: RelationshipInput) {
      const source = db.entities.get(input.sourceEntityId);
      const target = db.entities.get(input.targetEntityId);
      if (!source || !inOrg(scope, source)) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Source entity ${input.sourceEntityId} not found in this organization.`,
        );
      }
      if (!target || !inOrg(scope, target)) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Target entity ${input.targetEntityId} not found in this organization.`,
        );
      }

      const validation = registry.validateRelationship(
        input,
        source.entityTypeKey,
        target.entityTypeKey,
      );
      if (!validation.ok) return validation;

      const typeDef = registry.relationshipType(input.relationshipTypeKey)!;
      const now = nowIso();
      const rel: Relationship = {
        id: asRelationshipId(idGen.next()),
        orgId: scope.orgId,
        relationshipTypeId: typeDef.id,
        relationshipTypeKey: typeDef.key,
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        weight: input.weight ?? null,
        confidence: input.confidence ?? null,
        validFrom: input.validFrom ?? asValidTime(now),
        validTo: input.validTo ?? null,
        observedAt: input.observedAt ?? null,
        ingestedAt: asRecordTime(now),
        updatedAt: asRecordTime(now),
        sourceSystem: input.sourceSystem,
        sourceObjectType: input.sourceObjectType ?? null,
        sourceObjectId: input.sourceObjectId ?? null,
        metadata: { ...(input.metadata ?? {}) },
        createdBy: input.createdBy ?? null,
      };
      db.relationships.set(rel.id, rel);
      return ok(rel);
    },

    async removeRelationship(scope, id, at) {
      const rel = db.relationships.get(id);
      if (!rel || !inOrg(scope, rel)) {
        return fail(
          ErrorCodes.GRAPH_RELATIONSHIP_NOT_FOUND,
          `Relationship ${id} not found in this organization.`,
        );
      }
      const when = toIso(at ?? clock.now());
      const next: Relationship = {
        ...rel,
        validTo: asValidTime(when),
        updatedAt: asRecordTime(when),
      };
      db.relationships.set(id, next);
      return ok(next);
    },

    async findRelationships(scope, query: RelationshipQuery) {
      let rows = liveRelationships(scope);
      if (query.relationshipTypeKeys?.length) {
        rows = rows.filter((r) =>
          query.relationshipTypeKeys!.includes(r.relationshipTypeKey),
        );
      }
      if (query.sourceEntityId) {
        rows = rows.filter((r) => r.sourceEntityId === query.sourceEntityId);
      }
      if (query.targetEntityId) {
        rows = rows.filter((r) => r.targetEntityId === query.targetEntityId);
      }
      if (query.eitherEndpoint) {
        rows = rows.filter(
          (r) =>
            r.sourceEntityId === query.eitherEndpoint ||
            r.targetEntityId === query.eitherEndpoint,
        );
      }
      if (query.minConfidence !== undefined) {
        rows = rows.filter((r) => (r.confidence ?? 1) >= query.minConfidence!);
      }
      rows = rows.filter((r) => validAt(r, query.asOf));
      rows.sort((a, b) => a.relationshipTypeKey.localeCompare(b.relationshipTypeKey));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 500;
      return ok(rows.slice(offset, offset + limit));
    },

    async getNeighbors(scope, query: NeighborQuery) {
      const self = db.entities.get(query.entityId);
      if (!self || !inOrg(scope, self)) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${query.entityId} not found in this organization.`,
        );
      }
      const out: Neighbor[] = [];
      for (const { rel, other, dir } of edgesFrom(
        scope,
        query.entityId,
        query.direction,
        query.relationshipTypeKeys,
        query.asOf,
        query.minConfidence,
      )) {
        const entity = db.entities.get(other);
        if (!entity || !inOrg(scope, entity)) continue;
        if (!validAt(entity, query.asOf)) continue;
        if (
          query.entityTypeKeys?.length &&
          !entityMatchesType(entity, query.entityTypeKeys)
        ) {
          continue;
        }
        out.push({ entity, via: rel, direction: dir });
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

      type QueueItem = { id: EntityId; depth: number; path: RelationshipId[]; conf: number[] };
      const queue: QueueItem[] = [];

      for (const startId of spec.start) {
        const e = db.entities.get(startId);
        if (!e || !inOrg(scope, e)) continue;
        if (!validAt(e, spec.asOf)) continue;
        visited.set(startId, { entity: e, depth: 0, path: [], pathConfidence: 1 });
        queue.push({ id: startId, depth: 0, path: [], conf: [] });
      }

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.depth >= spec.maxDepth) continue;

        for (const { rel, other } of edgesFrom(
          scope,
          item.id,
          spec.direction,
          spec.relationshipTypeKeys,
          spec.asOf,
          spec.minConfidence,
        )) {
          const entity = db.entities.get(other);
          if (!entity || !inOrg(scope, entity)) continue;
          if (!validAt(entity, spec.asOf)) continue;
          if (spec.entityTypeKeys?.length && !entityMatchesType(entity, spec.entityTypeKeys)) {
            continue;
          }
          usedRels.set(rel.id, rel);

          if (visited.has(other)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            break;
          }

          const path = [...item.path, rel.id];
          const conf = [...item.conf, rel.confidence ?? 1];
          visited.set(other, {
            entity,
            depth: item.depth + 1,
            path,
            pathConfidence: chainConfidence(conf),
          });
          queue.push({ id: other, depth: item.depth + 1, path, conf });
        }
        if (truncated) break;
      }

      const nodes = [...visited.values()].sort((a, b) =>
        a.depth === b.depth ? a.entity.name.localeCompare(b.entity.name) : a.depth - b.depth,
      );
      const relationships = [...usedRels.values()].sort((a, b) => a.id.localeCompare(b.id));
      const result: TraversalResult = { nodes, relationships, truncated };
      return ok(result);
    },

    async paths(scope, from, to, spec: PathSpec) {
      if (spec.maxDepth < 0 || spec.maxDepth > MAX_ALLOWED_DEPTH) {
        return fail(
          ErrorCodes.GRAPH_DEPTH_EXCEEDED,
          `maxDepth must be between 0 and ${MAX_ALLOWED_DEPTH}, got ${spec.maxDepth}.`,
        );
      }
      const start = db.entities.get(from);
      if (!start || !inOrg(scope, start)) {
        return fail(ErrorCodes.GRAPH_ENTITY_NOT_FOUND, `Entity ${from} not found in this organization.`);
      }

      const maxPaths = spec.maxPaths ?? 25;
      const found: GraphPath[] = [];

      const walk = (
        current: EntityId,
        depth: number,
        entityPath: EntityId[],
        relPath: RelationshipId[],
        confs: number[],
        lags: number[],
        onPath: Set<string>,
      ): void => {
        if (found.length >= maxPaths) return;
        if (current === to && entityPath.length > 1) {
          found.push({
            entityIds: [...entityPath],
            relationshipIds: [...relPath],
            pathConfidence: chainConfidence(confs),
            totalLagDays: lags.reduce((a, b) => a + b, 0),
          });
          return;
        }
        if (depth >= spec.maxDepth) return;

        for (const { rel, other } of edgesFrom(
          scope,
          current,
          spec.direction,
          spec.relationshipTypeKeys,
          spec.asOf,
          undefined,
        )) {
          if (onPath.has(other)) continue; // no cycles within one path
          const entity = db.entities.get(other);
          if (!entity || !inOrg(scope, entity)) continue;
          if (!validAt(entity, spec.asOf)) continue;

          const lag = Number(rel.metadata?.lagDays ?? 0) || 0;
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
      const record: ProvenanceRecord = {
        ...input,
        id: asProvenanceId(idGen.next()),
        orgId: scope.orgId,
        confidence: input.confidence === null || input.confidence === undefined
          ? null
          : clampConfidence(input.confidence),
        recordedAt: input.recordedAt ?? asRecordTime(nowIso()),
      };
      db.provenance.push(record);
      return ok(record);
    },

    async getProvenance(scope, subjectKind, subjectId) {
      const rows = db.provenance
        .filter(
          (p) =>
            p.orgId === scope.orgId &&
            p.subjectKind === subjectKind &&
            p.subjectId === subjectId,
        )
        .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
      return ok(rows);
    },

    async startIngestionEvent(scope, system: SourceSystem, connector, cursor) {
      const evt: IngestionEvent = {
        id: asIngestionEventId(idGen.next()),
        orgId: scope.orgId,
        system,
        connector,
        cursor: cursor ?? null,
        startedAt: asRecordTime(nowIso()),
        finishedAt: null,
        status: 'running',
        recordCount: 0,
        notes: null,
      };
      db.ingestionEvents.set(evt.id, evt);
      return ok(evt);
    },

    async finishIngestionEvent(scope, id: IngestionEventId, status, recordCount, notes) {
      const evt = db.ingestionEvents.get(id);
      if (!evt || evt.orgId !== scope.orgId) {
        return fail(ErrorCodes.GRAPH_READ_FAILED, `Ingestion event ${id} not found.`);
      }
      const next: IngestionEvent = {
        ...evt,
        status,
        recordCount,
        notes: notes ?? null,
        finishedAt: asRecordTime(nowIso()),
      };
      db.ingestionEvents.set(id, next);
      return ok(next);
    },

    async addAlias(scope, input: EntityAliasInput) {
      const entity = db.entities.get(input.entityId);
      if (!entity || !inOrg(scope, entity)) {
        return fail(
          ErrorCodes.GRAPH_ENTITY_NOT_FOUND,
          `Entity ${input.entityId} not found in this organization.`,
        );
      }

      // Idempotent: the same external identifier asserted twice is one alias,
      // not two. Re-running a connector must not multiply identity records.
      const normalized = normalizeAlias(input.aliasValue);
      const existing = [...db.aliases.values()].find(
        (a) =>
          a.orgId === scope.orgId &&
          a.entityId === input.entityId &&
          a.system === input.system &&
          a.aliasKind === input.aliasKind &&
          a.normalizedValue === normalized &&
          a.validTo === null,
      );
      if (existing) return ok(existing);

      const now = nowIso();
      const alias: EntityAlias = {
        id: asAliasId(idGen.next()),
        orgId: scope.orgId,
        entityId: input.entityId,
        system: input.system,
        aliasKind: input.aliasKind,
        aliasValue: input.aliasValue,
        normalizedValue: normalized,
        matchMethod: input.matchMethod,
        confidence: input.confidence ?? null,
        evidence: input.evidence ?? null,
        validFrom: input.validFrom ?? asValidTime(now),
        validTo: input.validTo ?? null,
        createdBy: input.createdBy ?? null,
      };
      db.aliases.set(alias.id, alias);
      return ok(alias);
    },

    async findByAlias(scope, system: SourceSystem, aliasValue) {
      const normalized = normalizeAlias(aliasValue);
      // Distinct entities: several alias rows (different kinds) may point at one.
      const ids = [
        ...new Set(
          [...db.aliases.values()]
            .filter(
              (a) =>
                a.orgId === scope.orgId &&
                a.system === system &&
                a.normalizedValue === normalized &&
                a.validTo === null,
            )
            .map((a) => a.entityId),
        ),
      ];
      const entities = ids
        .map((id) => db.entities.get(id))
        .filter((e): e is Entity => Boolean(e) && inOrg(scope, e!));
      return ok(entities);
    },

    async getAliases(scope, entityId: EntityId) {
      const rows = [...db.aliases.values()]
        .filter((a) => a.orgId === scope.orgId && a.entityId === entityId)
        .sort((a, b) => a.aliasValue.localeCompare(b.aliasValue));
      return ok(rows);
    },
  };

  return store;
}

export type { Result };
