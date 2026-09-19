/**
 * The ValueGraph port — how the kernel reads and writes value structure.
 *
 * Separate from `GraphStore` by design (ADR-0015): the ontology holds nouns,
 * this holds quantities, and observations do not behave like entities.
 *
 * NOTHING HERE COMPUTES. `getValueChain` returns the structure through which
 * value flows and the observations attached to it; it does not evaluate the
 * chain. Changing an upstream observation does not change a downstream one.
 * That is Phase 3, and `verify:value-graph` asserts the absence.
 */

import type {
  Confidence,
  EntityId,
  ProvenanceRecord,
  ProvenanceInput,
  Result,
  Scope,
} from '@helm/shared';
import type {
  ObservationType,
  TimeHorizon,
  ValueDimension,
  ValueLink,
  ValueLinkInput,
  ValueLinkType,
  ValueMetricDefinition,
  ValueNode,
  ValueNodeInput,
  ValueObservation,
  ValueObservationInput,
} from './types.ts';

// ------------------------------------------------------------------ reads

export type MetricQuery = {
  dimensions?: readonly ValueDimension[];
  keys?: readonly string[];
  search?: string;
  includeInactive?: boolean;
};

export type ValueNodeQuery = {
  metricKeys?: readonly string[];
  dimensions?: readonly ValueDimension[];
  subjectEntityIds?: readonly EntityId[];
  scopeKind?: string;
  timeHorizon?: TimeHorizon;
  search?: string;
  limit?: number;
  offset?: number;
};

export type ValueLinkQuery = {
  linkTypes?: readonly ValueLinkType[];
  sourceNodeId?: string;
  targetNodeId?: string;
  eitherEndpoint?: string;
  asOf?: Date | string;
  minConfidence?: Confidence;
  limit?: number;
};

export type ObservationQuery = {
  nodeId: string;
  types?: readonly ObservationType[];
  /** null explicitly selects non-scenario (reality) observations. */
  scenarioEntityId?: EntityId | null;
  /** Valid-time window filter over effectiveAt / periodStart. */
  from?: Date | string;
  to?: Date | string;
  limit?: number;
};

export type LatestObservationQuery = {
  nodeId: string;
  type: ObservationType;
  scenarioEntityId?: EntityId | null;
  asOf?: Date | string;
};

// -------------------------------------------------------------- traversal

export type ValueDirection = 'upstream' | 'downstream' | 'both';

/**
 * A bounded walk over value links. `maxDepth` is required, exactly as in the
 * Phase 1 GraphStore — an unbounded traversal over an enterprise value graph is
 * a defect, not a convenience.
 */
export type ValueTraversalSpec = {
  start: readonly string[];
  maxDepth: number;
  direction: ValueDirection;
  linkTypes?: readonly ValueLinkType[];
  metricKeys?: readonly string[];
  dimensions?: readonly ValueDimension[];
  /** Valid-time context: which links were in force. */
  asOf?: Date | string;
  /** Observation context: which scenario's numbers to attach, null = reality. */
  scenarioEntityId?: EntityId | null;
  minConfidence?: Confidence;
  maxNodes?: number;
};

export type ValueChainNode = {
  node: ValueNode;
  metric: ValueMetricDefinition;
  depth: number;
  /** How this node was reached. Empty for the starting nodes. */
  path: readonly string[];
  /** Product of link confidences along `path`. Structural, not computed value. */
  pathConfidence: Confidence;
  /**
   * Observations attached to this node under the requested context. Present so
   * a reader can SEE the numbers along the chain — not because anything
   * combined them.
   */
  observations: readonly ValueObservation[];
};

export type ValueChain = {
  nodes: readonly ValueChainNode[];
  links: readonly ValueLink[];
  truncated: boolean;
};

/** A node reached in one hop, with the link that reached it. */
export type ValueNeighbor = {
  node: ValueNode;
  metric: ValueMetricDefinition;
  via: ValueLink;
  direction: 'upstream' | 'downstream';
};

/**
 * Two or more value nodes drawing on one constrained resource.
 * This is what makes the cost of saying yes visible.
 */
export type ContentionPoint = {
  /** The contended node — an inventory position's availability, a capacity pool. */
  node: ValueNode;
  metric: ValueMetricDefinition;
  /** Everything consuming or constraining it. */
  claimants: readonly ValueNeighbor[];
  /** Sum of claimant link weights, where present. Arithmetic, not propagation. */
  totalClaimedWeight: number | null;
};

// -------------------------------------------------------------------- port

export interface ValueGraph {
  // --- metric definitions ---
  createMetricDefinition(
    scope: Scope,
    input: Omit<ValueMetricDefinition, 'id' | 'orgId' | 'isSystem' | 'version'>,
  ): Promise<Result<ValueMetricDefinition>>;
  getMetricDefinition(scope: Scope, key: string): Promise<Result<ValueMetricDefinition | null>>;
  findMetricDefinitions(
    scope: Scope,
    query?: MetricQuery,
  ): Promise<Result<readonly ValueMetricDefinition[]>>;

  // --- value nodes ---
  createValueNode(scope: Scope, input: ValueNodeInput): Promise<Result<ValueNode>>;
  /** Create-or-return by (metric, subject, scope, horizon). Idempotent. */
  upsertValueNode(scope: Scope, input: ValueNodeInput): Promise<Result<ValueNode>>;
  getValueNode(scope: Scope, id: string): Promise<Result<ValueNode | null>>;
  findValueNodes(scope: Scope, query?: ValueNodeQuery): Promise<Result<readonly ValueNode[]>>;
  /** Every value node about one ontology entity — its value profile. */
  findNodesForEntity(scope: Scope, entityId: EntityId): Promise<Result<readonly ValueNode[]>>;

  // --- value links ---
  createValueLink(scope: Scope, input: ValueLinkInput): Promise<Result<ValueLink>>;
  /** Closes validity; never deletes. Same discipline as Phase 1 relationships. */
  removeValueLink(scope: Scope, id: string, at?: Date): Promise<Result<ValueLink>>;
  findValueLinks(scope: Scope, query?: ValueLinkQuery): Promise<Result<readonly ValueLink[]>>;

  // --- observations ---
  recordObservation(
    scope: Scope,
    input: ValueObservationInput,
  ): Promise<Result<ValueObservation>>;
  getObservations(
    scope: Scope,
    query: ObservationQuery,
  ): Promise<Result<readonly ValueObservation[]>>;
  /** The most recent observation of one type, by valid time. */
  getLatestObservation(
    scope: Scope,
    query: LatestObservationQuery,
  ): Promise<Result<ValueObservation | null>>;

  // --- traversal ---
  getValueNeighborhood(
    scope: Scope,
    nodeId: string,
    direction: ValueDirection,
    asOf?: Date | string,
  ): Promise<Result<readonly ValueNeighbor[]>>;
  getValueChain(scope: Scope, spec: ValueTraversalSpec): Promise<Result<ValueChain>>;
  findUpstreamValueNodes(
    scope: Scope,
    nodeId: string,
    maxDepth: number,
  ): Promise<Result<ValueChain>>;
  findDownstreamValueNodes(
    scope: Scope,
    nodeId: string,
    maxDepth: number,
  ): Promise<Result<ValueChain>>;
  /** Nodes drawn on by more than one claimant — shared constrained resources. */
  findContention(
    scope: Scope,
    opts?: { minClaimants?: number; asOf?: Date | string },
  ): Promise<Result<readonly ContentionPoint[]>>;

  // --- provenance (reuses the Phase 1 mechanism) ---
  recordProvenance(scope: Scope, input: ProvenanceInput): Promise<Result<ProvenanceRecord>>;
  getObservationProvenance(
    scope: Scope,
    observationId: string,
  ): Promise<Result<readonly ProvenanceRecord[]>>;
}
