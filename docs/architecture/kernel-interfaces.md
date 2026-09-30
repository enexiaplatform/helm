# HELM Kernel Interfaces

The contracts every kernel package exposes. These are the **stable seams**: an
implementation may be replaced (Postgres → Neo4j, formula → Monte Carlo, rule →
model) without a caller changing, provided the contract holds.

Signatures here are the Phase 0 design. Phase 1 implements `shared`, `ontology`
and `graph-store` exactly as written; later phases refine their own interfaces
via ADR before implementation.

## 1. Conventions

- **Pure.** No I/O, no `Date.now()`, no `crypto.randomUUID()` inside a kernel
  function. Time and ids arrive through ports (§2).
- **`Result<T>` at boundaries.** Domain-rule failures are values, not thrown
  exceptions; only programmer errors throw.
- **Explicit scope.** Every read and write takes a `Scope` — the org, the actor
  and their visibility. There is no ambient tenant.
- **Every derived number carries a trace.** A function producing a value also
  produces how it got there.

```ts
// packages/shared
export type Result<T, E = HelmError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type HelmError = {
  code: string;          // 'ontology.unknown_type', 'authority.insufficient'
  message: string;       // manager-readable
  details?: Record<string, unknown>;
};

export type Scope = {
  orgId: OrgId;
  actorId: UserId;
  role: OrgRole;                 // admin > manager > member > viewer
  orgUnitIds: OrgUnitId[];       // units the actor may see
  functions: string[];           // functional visibility
};

export type Clock = { now(): Date };
export type IdGen = { next(): string };

export type Money = { amount: number; currency: string };
export type Horizon = 'current' | 'month' | 'quarter' | 'year';
export type Confidence = number; // 0..1

export type Provenance = {
  sourceSystem: 'memoire' | 'erp' | 'finance' | 'scm' | 'hris' | 'helm' | 'manual';
  sourceRef: string | null;
  observedAt: string;            // ISO
  ingestedAt: string;
};
```

## 2. `graph-store` — the persistence port

The single seam between the kernel and any database. Nothing else in the kernel
touches storage, which is what makes a graph-engine migration a new adapter
rather than a rewrite ([ADR-0004](../adr/0004-graph-abstraction-layer.md)).

```ts
export interface GraphStore {
  // --- entities ---
  getEntity(scope: Scope, id: EntityId): Promise<Entity | null>;
  findEntities(scope: Scope, q: EntityQuery): Promise<Entity[]>;
  upsertEntity(scope: Scope, input: EntityInput): Promise<Entity>;
  /** Closes validity rather than deleting; history is never destroyed. */
  supersedeEntity(scope: Scope, id: EntityId, at: Date): Promise<void>;

  // --- relationships ---
  findRelationships(scope: Scope, q: RelationshipQuery): Promise<Relationship[]>;
  upsertRelationship(scope: Scope, input: RelationshipInput): Promise<Relationship>;
  supersedeRelationship(scope: Scope, id: RelationshipId, at: Date): Promise<void>;

  // --- traversal (the reason this is a port and not a repository) ---
  traverse(scope: Scope, spec: TraversalSpec): Promise<TraversalResult>;
  /** Every distinct path between two nodes, for impact explanation. */
  paths(scope: Scope, from: EntityId, to: EntityId, spec: PathSpec): Promise<GraphPath[]>;

  // --- registry ---
  entityTypes(scope: Scope): Promise<EntityTypeDef[]>;
  relationshipTypes(scope: Scope): Promise<RelationshipTypeDef[]>;

  transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T>;
}

export type TraversalSpec = {
  start: EntityId[];
  relationshipTypes?: string[];
  direction: 'out' | 'in' | 'both';
  maxDepth: number;              // required — unbounded traversal is a bug
  asOf?: Date;                   // temporal query; default = now
  scenarioId?: ScenarioId | null;// null = base reality
  minConfidence?: Confidence;
  entityTypes?: string[];
};

export type GraphPath = {
  nodes: EntityId[];
  edges: RelationshipId[];
  /** Product of edge confidences — a long chain is never highly confident. */
  pathConfidence: Confidence;
  totalLag: number;              // days
};
```

Two adapters ship together from Phase 1:

- `PostgresGraphStore` — recursive CTEs over `helm_entities` /
  `helm_relationships`, via Supabase.
- `InMemoryGraphStore` — the same contract over plain objects, so every kernel
  package is testable without a database and the demo org runs offline.

Shipping both from day one is what proves the abstraction is real.

## 3. `ontology`

```ts
export interface OntologyRegistry {
  entityType(code: string): EntityTypeDef | null;
  relationshipType(code: string): RelationshipTypeDef | null;
  /** Includes inherited ancestors: isA('Account','Customer') === true. */
  isA(code: string, ancestorCode: string): boolean;
  validateEntity(input: EntityInput): Result<EntityInput>;
  /** Rejects endpoints violating the relationship type's domain constraints. */
  validateRelationship(input: RelationshipInput): Result<RelationshipInput>;
}

export type EntityTypeDef = {
  code: string;
  domain: 'organization' | 'commercial' | 'operations' | 'finance' | 'management' | 'value';
  parentCode: string | null;
  attributeSchema: JsonSchema;
  version: number;
};

export type Entity = {
  id: EntityId;
  orgId: OrgId;
  typeCode: string;
  naturalKey: string;            // unique per (orgId, typeCode)
  name: string;
  attributes: Record<string, unknown>;
  provenance: Provenance;
  validFrom: string;
  validTo: string | null;        // null = current
  confidence: Confidence;
};

export type Relationship = {
  id: RelationshipId;
  orgId: OrgId;
  typeCode: string;
  fromEntityId: EntityId;
  toEntityId: EntityId;
  weight: number | null;
  confidence: Confidence;
  lagDays: number | null;
  scenarioId: ScenarioId | null;
  provenance: Provenance;
  validFrom: string;
  validTo: string | null;
};
```

## 4. `value-graph`

```ts
export interface ValueGraph {
  nodesFor(scope: Scope, entityId: EntityId): Promise<ValueNode[]>;
  observe(scope: Scope, o: ObservationInput): Promise<ValueObservation>;
  valueOf(scope: Scope, nodeId: ValueNodeId, at: ValueQuery): Promise<ValueObservation | null>;
  /** Every path from a node to a target metric — the impact surface. */
  downstreamOf(scope: Scope, nodeId: ValueNodeId, spec: ImpactSpec): Promise<ValueImpactPath[]>;
  /** Inputs that feed a node, recursively — the audit surface. */
  driversOf(scope: Scope, nodeId: ValueNodeId, depth: number): Promise<ValueDriver[]>;
}

export type ValueObservation = {
  id: string;
  nodeId: ValueNodeId;
  kind: 'actual' | 'forecast' | 'derived' | 'override';
  value: number;
  currency: string | null;
  scenarioId: ScenarioId | null;
  calculationRunId: string | null;   // null only for actuals and overrides
  confidence: Confidence;
  asOf: string;
};
```

## 5. `propagation-engine`

The heart of Layer 2. A registry of calculations, a dependency graph derived
from it, and an execution that records everything it did.

```ts
export interface Calculation<I = unknown, O = number> {
  code: string;
  version: number;
  inputs: CalculationInput[];        // metric codes + how to resolve them
  outputMetric: string;
  unit: string;
  describe(): string;                // manager-readable, e.g. "value × probability"
  /** Pure. Same inputs and context always give the same result. */
  compute(inputs: I, ctx: CalculationContext): Result<CalculationOutput<O>>;
}

export type CalculationOutput<O> = {
  value: O;
  confidence: Confidence;
  /** The audit record. Never optional. */
  trace: {
    calculationCode: string;
    version: number;
    expression: string;              // rendered with actual numbers
    inputs: { label: string; value: number; nodeId?: ValueNodeId; provenance?: Provenance }[];
    assumptionsUsed: string[];
  };
};

export interface PropagationEngine {
  register(calc: Calculation): void;
  /** Topological order derived from the registry; throws on a cycle. */
  plan(scope: Scope, from: ValueNodeId[], spec: PropagationSpec): Promise<PropagationPlan>;
  run(scope: Scope, plan: PropagationPlan): Promise<PropagationRun>;
  /** Full provenance for one number: "why 4.2B?" */
  explain(scope: Scope, nodeId: ValueNodeId, runId: string): Promise<Explanation>;
}

export type PropagationSpec = {
  scenarioId: ScenarioId | null;
  horizon: Horizon;
  maxDepth: number;
  /** Deterministic now; monte_carlo / optimization / ml later, same contract. */
  mode: 'deterministic' | 'monte_carlo' | 'optimization';
  asOf?: Date;
};

export type Explanation = {
  nodeId: ValueNodeId;
  value: number;
  formula: string;
  inputs: { label: string; value: number; source: Provenance }[];
  assumptions: { statement: string; sensitivity: string }[];
  confidence: Confidence;
  upstream: Explanation[];           // recursive to the source facts
  computedAt: string;
};
```

`Explanation` is the §17 auditability requirement as a type. If a number cannot
produce one, it does not get displayed.

## 6. Governance and learning interfaces

```ts
// authority-engine (Phase 6)
export interface AuthorityEngine {
  evaluate(scope: Scope, req: AuthorityRequest): AuthorityVerdict;
}
export type AuthorityRequest = {
  actionType: string;                // 'approve_discount', 'commit_inventory'
  decisionType: string;
  amount: Money | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  orgUnitId: OrgUnitId | null;
  countryId: EntityId | null;
  actorRoleId: EntityId;
};
export type AuthorityVerdict =
  | { allowed: true; ruleId: string; rationale: string }
  | { allowed: false; ruleId: string | null; rationale: string;
      requiredRoleIds: EntityId[]; approvalChain: EntityId[]; escalationPath: EntityId[] };

// causal-engine (Phase 8)
export interface CausalEngine {
  hypothesesFor(scope: Scope, entityId: EntityId): Promise<CausalHypothesis[]>;
  recordEvidence(scope: Scope, e: CausalEvidenceInput): Promise<CausalHypothesis>;
  /** Recomputes confidence from supporting vs contradicting evidence. */
  reassess(scope: Scope, hypothesisId: string): Promise<CausalHypothesis>;
};

// management-genome (Phase 9) — delivered as @helm/genome-runtime (src/port.ts); abridged.
// Every read takes the two-time lens; status is derived at it, never stored.
export interface ManagementGenome {
  openEpisode(scope: Scope, input: OpenEpisodeInput): Promise<Result<EpisodeView>>;
  /** Episodes agreeing on EVERY required feature, chronological, unscored. */
  findSimilar(scope: Scope, input: { episodeId?: string; decisionId?: string; require: FeatureName[]; lens?: GenomeLens }): Promise<Result<SimilarSituations>>;
  proposePattern(scope: Scope, input: ProposePatternInput): Promise<Result<PatternView>>;
  /** Refused unless the stance agrees with what HELM's own records show. */
  linkEpisode(scope: Scope, patternId: string, episodeId: string, stance: PatternStance, rationale: string): Promise<Result<PatternView>>;
  recordLesson(scope: Scope, input: RecordLessonInput): Promise<Result<LessonView>>;
  viewAt(scope: Scope, lens?: GenomeLens): Promise<Result<GenomeAtLens>>;
  projectForViewer(scope: Scope, viewer: TwinViewer, units: OrgUnit[], facts: GenomeVisibilityFacts, lens?: GenomeLens): Promise<Result<ProjectedGenome>>;
}

// counterfactual-engine (Phase 10)
export interface CounterfactualEngine {
  compare(scope: Scope, decisionId: string, alternativeId: string): Promise<Counterfactual>;
}
export type Counterfactual = {
  actual: OutcomeSummary;
  expected: OutcomeSummary;
  alternative: OutcomeSummary;
  deltas: { metric: string; actualVsExpected: number; actualVsAlternative: number }[];
  confidence: Confidence;
  assumptions: string[];
  method: 'scenario_comparison' | 'causal_inference';
};
```

`findSimilar` takes the **structured features** a caller requires to agree, not
a text blob — §2.7's "do not rely purely on embeddings". A feature the situation
does not state agrees with nothing, and the answer says so. Semantic similarity
may one day supplement this; it may never define similarity
([ADR-0028](../adr/0028-management-genome.md) §2).

## 7. Connector SDK

```ts
export interface SourceConnector {
  readonly sourceSystem: string;
  readonly version: string;
  /** Types this connector may create — the kernel enforces the whitelist. */
  readonly producesEntityTypes: string[];
  readonly producesRelationshipTypes: string[];

  healthCheck(): Promise<ConnectorHealth>;
  /** Pull changes since a cursor. Transport-agnostic: poll, webhook or queue. */
  pull(scope: Scope, since: Cursor | null): Promise<{ events: SourceEvent[]; cursor: Cursor }>;
  /** Translate a source event into ontology terms. Pure and unit-testable. */
  translate(event: SourceEvent): Result<OntologyMutation[]>;
}

export type SourceEvent = {
  eventType: string;                 // 'opportunity.updated'
  occurredAt: string;
  sourceSystem: string;
  sourceRef: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

export type OntologyMutation =
  | { kind: 'entity'; input: EntityInput }
  | { kind: 'relationship'; input: RelationshipInput }
  | { kind: 'observation'; input: ObservationInput };
```

`translate` being pure is what makes connectors testable with fixtures and no
network, and it is where every source-specific field name is confined.

## 8. LLM provider port (Phase 11)

```ts
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<Result<LlmResponse>>;
}

export type LlmRequest = {
  purpose: 'summarize' | 'explain' | 'generate_options' | 'critique' | 'synthesize';
  /** Grounding is required: the model may reference only what is in here. */
  context: GroundedContext;
  instruction: string;
  maxTokens: number;
  schema?: JsonSchema;               // structured output when applicable
};

export type GroundedContext = {
  scope: Scope;
  entities: Entity[];
  observations: ValueObservation[];
  explanations: Explanation[];
  assumptions: Assumption[];
  lessons: Lesson[];
  /** Assembled by the kernel, never by the model. */
  provenance: Provenance[];
};

export type LlmResponse = {
  text: string;
  structured?: unknown;
  /** Must resolve to ids present in the request context. */
  citedEntityIds: EntityId[];
  citedObservationIds: string[];
  uncertainty: 'low' | 'medium' | 'high';
  provider: string;
  model: string;
};
```

An AI answer that cites an id absent from its `GroundedContext` is rejected by
the runtime, not merely flagged. That check is the mechanical implementation of
"never present hallucinated business facts as truth".
