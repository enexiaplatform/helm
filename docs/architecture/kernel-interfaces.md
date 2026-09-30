# HELM Kernel Interfaces

The contracts every kernel package exposes. These are the **stable seams**: an
implementation may be replaced (Postgres → Neo4j, formula → Monte Carlo, rule →
model) without a caller changing, provided the contract holds.

§1–5 are the design contracts of the semantic kernel; §6–8 abridge the runtime ports of
the layers above it. **The port file in each package is authoritative**: where this page
and a `port.ts` differ, the port is right and this page is stale.

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

## 6. Governance, belief, memory and review interfaces

Each layer above the propagation engine exposes a **runtime port** in its own
`src/port.ts` and a **store port** beside it, implemented twice (in memory and
Postgres) against one conformance suite. The runtime port is what the app and the
layers above call; every read that describes the world takes the two-time lens, and
status is derived at it, never stored. The files are the contract; this page names
the shape, abridged.

| Layer | Runtime port (`packages/<pkg>/src/port.ts`) | Shape |
| --- | --- | --- |
| `authority-runtime` | `AuthorityRuntime` | `recordPolicy` (a DOA version, never edited) · `recordOccupancy` · `createDelegation` · `declareGovernanceProfile` · `grantVisibility` · `evaluate(commitmentId)` → an immutable evaluation bound to the commitment fingerprint, with required approvals · `recordApproval` / `recordRejection` · `getGovernanceState`. The verdict is produced by the trusted service; a client cannot supply facts |
| `twin-runtime` | `TwinRuntime` | `buildSnapshot` (kind, scope, periods, lens) · `getSnapshot` · `currentState` · `replaySnapshot` · `compareSnapshots` → the twin delta · `getCommittedFuture` / `getTrajectory` (current against committed future) · `explainItem` / `explainDifference` (lineage) · `projectForViewer(snapshotId, viewer, units)` (what was withheld is stated) |
| `causal-runtime` | `CausalRuntime` | `defineVariable` · `createClaim` / `reviseClaim` / `retireClaim` · `recordEvidence` / `correctEvidence` · `linkEvidence` / `supportClaim` / `challengeClaim` · `recordCorrelation` (kept apart) · `askQuestion` / `proposeCandidate` / `investigate` · `getClaim` / `listClaims` / `evaluateClaim` / `explainClaim` at a lens · bounded `getCauses` / `getEffects`. Status is derived from the evidence policy, never stored |
| `counterfactual-runtime` | `CounterfactualRuntime` | `openCase` · `estimate` (one world per retrospective lens) · `recordReview` · `getCase` / `listCases` · `compare` → four layers, two named differences · `viewAt` · `projectForViewer` |
| `genome-runtime` | `ManagementGenome` | abridged below |
| `integration-runtime` | `SourceAdapter`, `IntegrationStore`, `IngestionPipeline`, `WritebackGateway` | §7 |
| `review-runtime` | `ReviewRuntime` | `openReview` · `addItem` · `closeReview` (one disposition per item) · `getReview` / `listReviews` at a lens · `prepare` · `closingPack` · `reproduce` · `preparedFor` / `projectForViewer` |
| `intelligence-runtime` | `IntelligenceRuntime`, `AiProvider` | §8 |
| `agent-runtime` | `Council` | `convene(scope, caller, { question, decisionId?, reviewId?, perspectives? })` — the only method |

```ts
// genome-runtime — abridged. Every read takes the two-time lens.
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
```

`findSimilar` takes the **structured features** a caller requires to agree, not a text
blob. A feature the situation does not state agrees with nothing, and the answer says
so. Semantic similarity may one day supplement this; it may never define similarity
([ADR-0028](../adr/0028-management-genome.md) §2).

## 7. Source adapters and write-back

```ts
// integration-runtime/src/port.ts
export interface SourceAdapter {
  readonly system: SourceSystem;
  /** 'memoire-connector@0.2.0' — recorded in provenance so a fact names the build that translated it. */
  readonly connector: string;
  /** What the adapter promises each object type looks like. Drift is detected against this. */
  readonly contracts: readonly SchemaContract[];
  /** READ-ONLY. */
  pull(scope: Scope, cursor: string | null, limit?: number): Promise<Result<PullResult>>;
  /** Pure: a source record in the source's own words -> ontology entities, relationships, aliases and SOURCE facts. */
  translate(record: SourceRecord): Result<Translation>;
}
```

`translate` being pure is what makes an adapter testable with fixtures and no network,
and it is where every source-specific field name is confined. A translation can only
produce `ACTUAL`, `FORECAST` or `TARGET` facts; one that produces anything else is
quarantined. Write-back is a separate object, `WritebackAdapter`, with `describe` (what a
live write *would* be) and `supportedOperations` — **no method that sends**
([ADR-0030](../adr/0030-integration-fabric.md)).

## 8. AI provider port

```ts
// intelligence-runtime/src/provider.ts
export interface AiProvider extends ProviderIdentity {   // { id, model, modelVersion }
  /** Only for open-ended asks: which of the catalogued tools to call. Contextual tasks use a fixed plan. */
  plan?(input: PlanInput): Promise<readonly ToolCall[]>;
  synthesize(input: SynthesisInput): Promise<Draft>;
}
```

The provider is handed **plain JSON evidence** (no function, runtime, store or client)
gathered by the governed read-only tools *as the caller*, and returns a `Draft` of
classed statements, questions and unknowns. It does not decide what survives: `groundDraft`
does — a figure no cited evidence returned is removed, a recommendation is removed, a
hypothesis stated as fact is downgraded, and evidence ids are local to the run. An answer
that cites anything else is rejected by the runtime, not merely flagged
([ADR-0032](../adr/0032-governed-intelligence-runtime.md)). The council uses the same port
with a perspective in the input ([ADR-0033](../adr/0033-agent-council.md)).
