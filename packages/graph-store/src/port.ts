/**
 * The GraphStore port — the single seam between the kernel and any database.
 *
 * Deliberately narrow and domain-oriented (Phase 1 §13): this is not a Cypher
 * clone. It exposes the traversals HELM's management questions actually need,
 * and nothing more. Every method that widens it should have to justify itself.
 *
 * No Postgres concept appears here: no SQL, no connection, no transaction
 * isolation level, no row type. An adapter that needs to leak one has found a
 * gap in the port, and the port changes — not the caller.
 */

import type {
  Confidence,
  EntityId,
  IngestionEvent,
  IngestionEventId,
  ProvenanceInput,
  ProvenanceRecord,
  RelationshipId,
  Result,
  Scope,
  SourceSystem,
} from '@helm/shared';
import type {
  Entity,
  EntityAlias,
  EntityAliasInput,
  EntityInput,
  EntityPatch,
  EntityVersion,
  Relationship,
  RelationshipInput,
} from '@helm/ontology';

// -------------------------------------------------------------------- reads

export type EntityQuery = {
  entityTypeKeys?: readonly string[];
  /** Inheritance-aware: 'Customer' also matches Distributor. */
  includeSubtypes?: boolean;
  canonicalKeys?: readonly string[];
  sourceSystem?: SourceSystem;
  sourceEntityId?: string;
  /** Case-insensitive substring over name and canonical key. */
  search?: string;
  /**
   * Valid-time filter. When set, only facts valid at that instant are returned.
   * When omitted, the default is current facts — unless `includeInactive` is
   * set, which makes this an archival query (see below).
   */
  asOf?: Date | string;
  /**
   * Include retired and merged entities. Default false.
   *
   * Status and valid time are separate axes, but retiring an entity closes its
   * validity window. So `includeInactive: true` with no explicit `asOf` means
   * "everything ever recorded" and applies NO valid-time filter — otherwise a
   * retired entity could never be retrieved at all. Passing `asOf` alongside it
   * still filters to that instant.
   */
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
};

export type RelationshipQuery = {
  relationshipTypeKeys?: readonly string[];
  sourceEntityId?: EntityId;
  targetEntityId?: EntityId;
  /** Matches either endpoint — the usual "everything touching X" question. */
  eitherEndpoint?: EntityId;
  asOf?: Date | string;
  /**
   * Return every relationship ever recorded, closed ones included, and apply no
   * valid-time filter. For readers that reconstruct the graph under their own
   * two-time lens (the digital twin); ignored when `asOf` is set.
   */
  includeClosed?: boolean;
  minConfidence?: Confidence;
  limit?: number;
  offset?: number;
};

export type Direction = 'out' | 'in' | 'both';

export type NeighborQuery = {
  entityId: EntityId;
  direction: Direction;
  relationshipTypeKeys?: readonly string[];
  entityTypeKeys?: readonly string[];
  asOf?: Date | string;
  minConfidence?: Confidence;
};

export type Neighbor = {
  entity: Entity;
  via: Relationship;
  /** Direction travelled to reach it, from the starting entity's perspective. */
  direction: 'out' | 'in';
};

/**
 * A bounded traversal. `maxDepth` is required, not optional: an unbounded walk
 * over an enterprise graph is a defect, and making the caller state a limit is
 * cheaper than discovering that in production.
 */
export type TraversalSpec = {
  start: readonly EntityId[];
  maxDepth: number;
  direction: Direction;
  relationshipTypeKeys?: readonly string[];
  entityTypeKeys?: readonly string[];
  asOf?: Date | string;
  minConfidence?: Confidence;
  /** Safety valve on breadth as well as depth. Default 1000. */
  maxNodes?: number;
};

export type TraversalNode = {
  entity: Entity;
  depth: number;
  /** How this node was reached. Empty for the starting nodes. */
  path: readonly RelationshipId[];
  /** Product of edge confidences along `path`. A long chain is never certain. */
  pathConfidence: Confidence;
};

export type TraversalResult = {
  nodes: readonly TraversalNode[];
  relationships: readonly Relationship[];
  /** True when maxNodes cut the walk short — the caller must be able to tell. */
  truncated: boolean;
};

export type PathSpec = {
  maxDepth: number;
  direction: Direction;
  relationshipTypeKeys?: readonly string[];
  asOf?: Date | string;
  maxPaths?: number;
};

export type GraphPath = {
  entityIds: readonly EntityId[];
  relationshipIds: readonly RelationshipId[];
  pathConfidence: Confidence;
  /** Summed lead time along the path, in days, where edges carry one. */
  totalLagDays: number;
};

// ------------------------------------------------------------------- writes

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

export type EntityWriteResult = {
  entity: Entity;
  outcome: UpsertOutcome;
};

// -------------------------------------------------------------------- port

export interface GraphStore {
  // --- entities ---
  createEntity(scope: Scope, input: EntityInput): Promise<Result<EntityWriteResult>>;
  updateEntity(
    scope: Scope,
    id: EntityId,
    patch: EntityPatch,
  ): Promise<Result<EntityWriteResult>>;
  /**
   * Create-or-update by canonical key. Idempotent: re-ingesting identical
   * values returns 'unchanged' and writes no version row.
   */
  upsertEntity(scope: Scope, input: EntityInput): Promise<Result<EntityWriteResult>>;
  getEntity(scope: Scope, id: EntityId): Promise<Result<Entity | null>>;
  getEntityByCanonicalKey(
    scope: Scope,
    entityTypeKey: string,
    canonicalKey: string,
  ): Promise<Result<Entity | null>>;
  findEntities(scope: Scope, query: EntityQuery): Promise<Result<readonly Entity[]>>;
  /** Closes validity and marks retired. Never deletes — see ADR-0014. */
  retireEntity(scope: Scope, id: EntityId, at?: Date): Promise<Result<Entity>>;

  // --- record-time history ---
  getEntityHistory(scope: Scope, id: EntityId): Promise<Result<readonly EntityVersion[]>>;
  /** What HELM believed about this entity at a given record time. */
  getEntityAsRecordedAt(
    scope: Scope,
    id: EntityId,
    recordedAt: Date | string,
  ): Promise<Result<Entity | null>>;

  // --- relationships ---
  createRelationship(
    scope: Scope,
    input: RelationshipInput,
  ): Promise<Result<Relationship>>;
  /** Closes validity. Soft by design: history stays intact. */
  removeRelationship(
    scope: Scope,
    id: RelationshipId,
    at?: Date,
  ): Promise<Result<Relationship>>;
  findRelationships(
    scope: Scope,
    query: RelationshipQuery,
  ): Promise<Result<readonly Relationship[]>>;

  // --- traversal ---
  getNeighbors(scope: Scope, query: NeighborQuery): Promise<Result<readonly Neighbor[]>>;
  traverse(scope: Scope, spec: TraversalSpec): Promise<Result<TraversalResult>>;
  paths(
    scope: Scope,
    from: EntityId,
    to: EntityId,
    spec: PathSpec,
  ): Promise<Result<readonly GraphPath[]>>;

  // --- provenance ---
  recordProvenance(scope: Scope, input: ProvenanceInput): Promise<Result<ProvenanceRecord>>;
  getProvenance(
    scope: Scope,
    subjectKind: ProvenanceRecord['subjectKind'],
    subjectId: string,
  ): Promise<Result<readonly ProvenanceRecord[]>>;
  startIngestionEvent(
    scope: Scope,
    system: SourceSystem,
    connector: string,
    cursor?: string | null,
  ): Promise<Result<IngestionEvent>>;
  finishIngestionEvent(
    scope: Scope,
    id: IngestionEventId,
    status: IngestionEvent['status'],
    recordCount: number,
    notes?: string | null,
  ): Promise<Result<IngestionEvent>>;

  // --- identity ---
  addAlias(scope: Scope, input: EntityAliasInput): Promise<Result<EntityAlias>>;
  findByAlias(
    scope: Scope,
    system: SourceSystem,
    aliasValue: string,
  ): Promise<Result<readonly Entity[]>>;
  getAliases(scope: Scope, entityId: EntityId): Promise<Result<readonly EntityAlias[]>>;
}
