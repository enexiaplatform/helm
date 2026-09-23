/**
 * The Scenario Runtime port, and the ScenarioStore it persists through.
 *
 * Same shape as the propagation engine: one runtime implementation of pure
 * orchestration, over ports — the engine for simulation, the value graph for
 * reading states, and a ScenarioStore for what only scenarios have (identity,
 * revisions, overrides, simulations, constraint results). No Supabase or
 * Postgres concern appears here; the Postgres adapter lives in postgres.ts and
 * is held to the same conformance suite as the in-memory one.
 */

import type { EntityId, Period, Result, Scope, UserId } from '@helm/shared';
import type {
  Completeness,
  ForkPoint,
  FutureState,
  ModelRef,
  OverrideInput,
  RevisionReason,
  Scenario,
  ScenarioComparison,
  ScenarioConstraintResult,
  ScenarioExplanation,
  ScenarioOverride,
  ScenarioRevision,
  ScenarioRun,
  ScenarioRunKind,
  ScenarioRunStatus,
  ScenarioStatus,
  StateKind,
  ValidationReport,
} from './types.ts';

// ----------------------------------------------------------------- store

export type NewScenario = {
  key: string;
  name: string;
  description: string;
  parentScenarioId: string | null;
  scenarioEntityId: EntityId;
  metadata: Record<string, unknown>;
  createdBy: UserId | null;
};

export type NewRevision = {
  scenarioId: string;
  reason: RevisionReason;
  basedOnRevisionId: string | null;
  parentRevisionId: string | null;
  fork: ForkPoint;
  periods: readonly Period[];
  notes: string | null;
  createdBy: UserId | null;
};

export type NewOverride = Omit<ScenarioOverride, 'id' | 'orgId' | 'createdAt'>;

export type NewRun = {
  stateKind: StateKind;
  scenarioId: string | null;
  revisionId: string | null;
  kind: ScenarioRunKind;
  replayOfRunId: string | null;
  fork: ForkPoint;
  periods: readonly Period[];
  fingerprint: string;
  modelRef: ModelRef;
  createdBy: UserId | null;
  notes: string | null;
};

/**
 * Persistence for what the value graph and the calculation store have no
 * concept of. Every method is tenant-scoped by `scope.orgId`; an id from
 * another organization is simply not found.
 *
 * Immutability is the store's contract, not the runtime's courtesy: a SEALED
 * revision and its overrides reject every change, and a run's context never
 * changes after creation.
 */
export interface ScenarioStore {
  createScenario(scope: Scope, input: NewScenario): Promise<Result<Scenario>>;
  getScenario(scope: Scope, id: string): Promise<Result<Scenario | null>>;
  getScenarioByKey(scope: Scope, key: string): Promise<Result<Scenario | null>>;
  listScenarios(scope: Scope): Promise<Result<readonly Scenario[]>>;
  /** Enforces `scenarioTransitions`. */
  setScenarioStatus(
    scope: Scope,
    id: string,
    status: ScenarioStatus,
    reason?: string | null,
  ): Promise<Result<Scenario>>;

  createRevision(scope: Scope, input: NewRevision): Promise<Result<ScenarioRevision>>;
  getRevision(scope: Scope, id: string): Promise<Result<ScenarioRevision | null>>;
  listRevisions(scope: Scope, scenarioId: string): Promise<Result<readonly ScenarioRevision[]>>;
  /** DRAFT -> SEALED, once. */
  sealRevision(
    scope: Scope,
    id: string,
    seal: { modelRef: ModelRef; fingerprint: string },
  ): Promise<Result<ScenarioRevision>>;

  /** Only into a DRAFT revision. */
  addOverride(scope: Scope, input: NewOverride): Promise<Result<ScenarioOverride>>;
  /** Only from a DRAFT revision. */
  removeOverride(scope: Scope, id: string): Promise<Result<void>>;
  listOverrides(scope: Scope, revisionId: string): Promise<Result<readonly ScenarioOverride[]>>;

  createRun(scope: Scope, input: NewRun): Promise<Result<ScenarioRun>>;
  /** Appends one period's calculation run. */
  attachPeriodRun(
    scope: Scope,
    runId: string,
    periodRun: { period: Period; calculationRunId: string },
  ): Promise<Result<ScenarioRun>>;
  completeRun(
    scope: Scope,
    runId: string,
    outcome: { status: ScenarioRunStatus; completeness: Completeness },
  ): Promise<Result<ScenarioRun>>;
  getRun(scope: Scope, id: string): Promise<Result<ScenarioRun | null>>;
  listRuns(
    scope: Scope,
    filter?: { scenarioId?: string; revisionId?: string; stateKind?: StateKind },
  ): Promise<Result<readonly ScenarioRun[]>>;

  recordConstraintResults(
    scope: Scope,
    runId: string,
    results: readonly ScenarioConstraintResult[],
  ): Promise<Result<void>>;
  listConstraintResults(
    scope: Scope,
    runId: string,
  ): Promise<Result<readonly ScenarioConstraintResult[]>>;
}

// --------------------------------------------------------------- runtime

export type CreateScenarioInput = {
  key: string;
  name: string;
  description?: string;
  /** Inherit this scenario's overrides (its latest SEALED revision, pinned). */
  parentScenarioId?: string | null;
  /**
   * The fork point. Defaults, for a root scenario: effectiveAsOf and
   * recordedThrough = the clock NOW, pinned; policy SOURCE_TRUTH. A child
   * defaults to its parent revision's fork.
   */
  fork?: Partial<ForkPoint>;
  /** Business periods to simulate. A child defaults to its parent's. */
  periods?: readonly Period[];
  metadata?: Record<string, unknown>;
};

export type ScenarioExecution = {
  readonly run: ScenarioRun;
  readonly futureState: FutureState;
};

export interface ScenarioRuntime {
  /** Creates the scenario and its first (DRAFT) revision. Clones nothing. */
  createScenario(
    scope: Scope,
    input: CreateScenarioInput,
  ): Promise<Result<{ scenario: Scenario; revision: ScenarioRevision }>>;
  /** A new DRAFT revision carrying the latest revision's overrides forward. */
  createRevision(
    scope: Scope,
    scenarioId: string,
    options?: { notes?: string },
  ): Promise<Result<ScenarioRevision>>;
  addOverride(scope: Scope, revisionId: string, input: OverrideInput): Promise<Result<ScenarioOverride>>;
  removeOverride(scope: Scope, overrideId: string): Promise<Result<void>>;

  /** Checks a revision without changing anything. */
  validate(scope: Scope, revisionId: string): Promise<Result<ValidationReport>>;
  /** Validates and seals the revision: from here it is immutable. */
  markReady(scope: Scope, revisionId: string): Promise<Result<ScenarioRevision>>;

  /** Simulates the scenario's latest revision (sealing a valid draft first). */
  execute(scope: Scope, scenarioId: string): Promise<Result<ScenarioExecution>>;
  /** Simulates the baseline: the same fork and periods, no scenario, no overrides. */
  executeBaseline(
    scope: Scope,
    input: { fork: ForkPoint; periods: readonly Period[]; notes?: string },
  ): Promise<Result<ScenarioExecution>>;

  /** Same revision, same boundary: must reproduce the original future state. */
  replay(scope: Scope, runId: string): Promise<Result<ScenarioExecution>>;
  /**
   * Same overrides, NEW boundary: a new REBASED revision, sealed, whose fork
   * moves to `to` (defaulting to the clock now). It does not execute — a
   * rebase is a new question, and asking it is the caller's choice.
   */
  rebase(
    scope: Scope,
    scenarioId: string,
    to?: Partial<ForkPoint>,
  ): Promise<Result<ScenarioRevision>>;

  compare(
    scope: Scope,
    input: { baselineRunId: string; alternativeRunIds: readonly string[] },
  ): Promise<Result<ScenarioComparison>>;
  explain(
    scope: Scope,
    runId: string,
    nodeId: string,
    period?: Period,
  ): Promise<Result<ScenarioExplanation>>;
  getFutureState(scope: Scope, runId: string): Promise<Result<FutureState>>;

  archive(scope: Scope, scenarioId: string): Promise<Result<Scenario>>;
  invalidate(scope: Scope, scenarioId: string, reason: string): Promise<Result<Scenario>>;

  getScenario(scope: Scope, id: string): Promise<Result<Scenario | null>>;
  listScenarios(scope: Scope): Promise<Result<readonly Scenario[]>>;
  listRevisions(scope: Scope, scenarioId: string): Promise<Result<readonly ScenarioRevision[]>>;
  listOverrides(scope: Scope, revisionId: string): Promise<Result<readonly ScenarioOverride[]>>;
  listRuns(
    scope: Scope,
    filter?: { scenarioId?: string; revisionId?: string; stateKind?: StateKind },
  ): Promise<Result<readonly ScenarioRun[]>>;
}
