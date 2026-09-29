/**
 * The Management API foundation (brief §79) — a thin, stable vocabulary over
 * the twin, so later surfaces ask management questions rather than reach into
 * kernels:
 *
 *   helm.enterprise.state(scope)          the latest CURRENT snapshot
 *   helm.enterprise.snapshot(input)       build one under an explicit lens
 *   helm.enterprise.diff(from, to)        a categorised twin delta
 *   helm.customer.state(snapshot, id)     one customer, its items and relationships
 *   helm.product.state(snapshot, id)      one product, likewise
 *   helm.value.dependencies(snapshot, key) upstream / downstream / related
 *   helm.decision.state(snapshot, id)     a decision with its commitment, intents,
 *                                         assumptions and governance
 *   helm.governance.state(snapshot)       the GOVERNANCE category
 *
 * Deliberately small. It adds no logic of its own: every method is one call
 * into the twin runtime.
 */

import { ok, type Result, type Scope } from '@helm/shared';
import type { BuildSnapshotInput, Dependencies, TwinRuntime } from './port.ts';
import type { ComposedSnapshot, TwinDelta, TwinItem, TwinScope } from './types.ts';

export type ManagementApi = ReturnType<typeof createManagementApi>;

export function createManagementApi(twin: TwinRuntime, scope: Scope) {
  const entityState = (snapshotId: string, entityId: string) => twin.getEntityState(scope, snapshotId, entityId);
  return {
    enterprise: {
      state: (twinScope: TwinScope): Promise<Result<ComposedSnapshot | null>> => twin.currentState(scope, twinScope),
      snapshot: (input: BuildSnapshotInput): Promise<Result<ComposedSnapshot>> => twin.buildSnapshot(scope, input),
      diff: (fromId: string, toId: string): Promise<Result<TwinDelta>> => twin.compareSnapshots(scope, fromId, toId),
    },
    customer: { state: entityState },
    product: { state: entityState },
    value: {
      dependencies: (snapshotId: string, itemKey: string): Promise<Result<Dependencies>> => twin.getDependencies(scope, snapshotId, itemKey),
    },
    decision: {
      async state(snapshotId: string, decisionId: string): Promise<Result<readonly TwinItem[]>> {
        const s = await twin.getSnapshot(scope, snapshotId);
        if (!s.ok) return s;
        return ok(s.value.items.filter((i) => i.key === `decision:${decisionId}` || i.state.decisionId === decisionId || i.key.endsWith(`:${decisionId}`)));
      },
    },
    governance: {
      async state(snapshotId: string): Promise<Result<readonly TwinItem[]>> {
        const m = await twin.getManagementState(scope, snapshotId);
        if (!m.ok) return m;
        return ok(m.value.categories.GOVERNANCE);
      },
    },
  };
}
