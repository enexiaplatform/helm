/**
 * The TwinStore port and the TwinRuntime interface (ADR-0023 §5).
 *
 * The store keeps snapshot HEADERS and their MANIFESTS. It never holds a
 * second copy of the enterprise: an item is a reference into the kernel plus
 * the reading materialized at composition, and the store refuses any snapshot
 * whose fingerprint does not match its own manifest. Write-once: a snapshot is
 * never updated or deleted; a correction is a new snapshot.
 *
 * No Postgres concept appears here.
 */

import type { OrgId, Result, Scope, UserId } from '@helm/shared';
import type { OrgUnit } from '@helm/authority-runtime';
import type { ProjectedSnapshot, SensitivityClearance, TwinViewer } from './sensitivity.ts';
import type {
  ComposedSnapshot,
  DifferenceExplanation,
  ManagementCategory,
  SnapshotKind,
  SnapshotSpec,
  Trajectory,
  TwinDelta,
  TwinItem,
  TwinItemExplanation,
  TwinLens,
  TwinScope,
  TwinSnapshot,
} from './types.ts';

export type NewSnapshot = Omit<TwinSnapshot, 'id' | 'orgId'>;
export type NewClearance = Omit<SensitivityClearance, 'id' | 'orgId'>;

export type SnapshotFilter = {
  kind?: SnapshotKind;
  /** 'ENTERPRISE', or an anchor entity id. */
  scopeKey?: string;
};

export interface TwinStore {
  /** Write-once. Refused when the fingerprint does not match the manifest. */
  saveSnapshot(scope: Scope, header: NewSnapshot, items: readonly TwinItem[]): Promise<Result<TwinSnapshot>>;
  getSnapshot(scope: Scope, id: string): Promise<Result<TwinSnapshot | null>>;
  getItems(scope: Scope, snapshotId: string): Promise<Result<readonly TwinItem[]>>;
  listSnapshots(scope: Scope, filter?: SnapshotFilter): Promise<Result<readonly TwinSnapshot[]>>;

  grantClearance(scope: Scope, input: NewClearance): Promise<Result<SensitivityClearance>>;
  listClearances(scope: Scope, userId?: UserId): Promise<Result<readonly SensitivityClearance[]>>;
}

export const scopeKeyOf = (s: TwinScope): string => (s.kind === 'ENTERPRISE' ? 'ENTERPRISE' : s.entityId);

export type BuildSnapshotInput = {
  kind: SnapshotKind;
  label: string;
  scope: TwinScope;
  /**
   * CURRENT takes the clock for both lenses and ignores this. Every other kind
   * states its lens; a knowledge boundary in the future is refused.
   */
  lens?: TwinLens;
  periods?: readonly string[];
  scenarioRunId?: string | null;
  commitmentId?: string | null;
  /** Org units whose members (and members of units above them) may read it. */
  grantedUnitIds?: readonly string[];
};

export type ReplayReport = {
  readonly snapshotId: string;
  readonly storedFingerprint: string;
  readonly replayedFingerprint: string;
  readonly identical: boolean;
  /** Item keys whose recomposition differs, and how. Empty when identical. */
  readonly differences: readonly { readonly itemKey: string; readonly change: 'ADDED' | 'REMOVED' | 'CHANGED' }[];
  readonly statement: string;
};

export type Dependencies = {
  readonly itemKey: string;
  readonly upstream: readonly { readonly itemKey: string | null; readonly label: string; readonly via: string; readonly nodeId: string | null }[];
  readonly downstream: readonly { readonly itemKey: string | null; readonly label: string; readonly via: string; readonly nodeId: string | null }[];
  readonly related: readonly { readonly itemKey: string; readonly label: string; readonly via: string }[];
};

export type ManagementState = {
  readonly snapshot: TwinSnapshot;
  readonly categories: Readonly<Record<ManagementCategory, readonly TwinItem[]>>;
};

export interface TwinRuntime {
  buildSnapshot(scope: Scope, input: BuildSnapshotInput): Promise<Result<ComposedSnapshot>>;
  getSnapshot(scope: Scope, id: string): Promise<Result<ComposedSnapshot>>;
  listSnapshots(scope: Scope, filter?: SnapshotFilter): Promise<Result<readonly TwinSnapshot[]>>;
  /** Current state = the latest CURRENT snapshot of the scope. Null when none has been built. */
  currentState(scope: Scope, twinScope: TwinScope): Promise<Result<ComposedSnapshot | null>>;
  /** Recomposes a stored snapshot under its own lens and compares fingerprints. */
  replaySnapshot(scope: Scope, id: string): Promise<Result<ReplayReport>>;

  compareSnapshots(scope: Scope, fromId: string, toId: string): Promise<Result<TwinDelta>>;
  getEntityState(scope: Scope, snapshotId: string, entityId: string): Promise<Result<{ entity: TwinItem | null; items: readonly TwinItem[] }>>;
  getValueState(scope: Scope, snapshotId: string, nodeId: string): Promise<Result<readonly TwinItem[]>>;
  getManagementState(scope: Scope, snapshotId: string): Promise<Result<ManagementState>>;
  getDependencies(scope: Scope, snapshotId: string, itemKey: string): Promise<Result<Dependencies>>;

  explainItem(scope: Scope, snapshotId: string, itemKey: string): Promise<Result<TwinItemExplanation>>;
  explainDifference(scope: Scope, fromId: string, toId: string, itemKey: string, toItemKey?: string): Promise<Result<DifferenceExplanation>>;

  /** The COMMITTED_FUTURE snapshot of a commitment, built on first request under the given boundary. */
  getCommittedFuture(scope: Scope, commitmentId: string, input?: { lens?: TwinLens; label?: string; scope?: TwinScope; grantedUnitIds?: readonly string[] }): Promise<Result<ComposedSnapshot>>;
  getTrajectory(scope: Scope, currentId: string, committedFutureId: string): Promise<Result<Trajectory>>;

  /** What one viewer may read of a snapshot: visibility first, then sensitivity per item. */
  projectForViewer(scope: Scope, snapshotId: string, viewer: TwinViewer, units: readonly OrgUnit[]): Promise<Result<ProjectedSnapshot>>;
  grantClearance(scope: Scope, input: Omit<NewClearance, 'grantedBy' | 'recordedAt'>): Promise<Result<SensitivityClearance>>;
  listClearances(scope: Scope, userId?: UserId): Promise<Result<readonly SensitivityClearance[]>>;
}

export type { OrgId, SnapshotSpec };
