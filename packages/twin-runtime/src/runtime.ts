/**
 * The Twin Runtime (ADR-0023).
 *
 *   build   compose under an explicit lens → fingerprint → store (write-once)
 *   load    read the stored manifest — no recomposition
 *   replay  recompose under the stored lens and prove the fingerprint again
 *   compare A → B by category; explain an item or a difference; the committed
 *           future of a commitment; the trajectory between now and it
 *
 * CURRENT is not a mutable row: current state is the latest CURRENT snapshot,
 * and building a new one leaves the previous one exactly as it was.
 */

import { fail, hasRole, ok, periodKey, type Clock, type Result, type Scope } from '@helm/shared';
import { canSeeSnapshot, projectForViewer } from './sensitivity.ts';
import { composeSnapshot, defaultPeriods, type TwinSources } from './compose.ts';
import { compareComposed } from './delta.ts';
import { createExplainer } from './explain.ts';
import { snapshotFingerprint } from './fingerprint.ts';
import { containerSensitivity } from './sensitivity.ts';
import { trajectoryOf } from './trajectory.ts';
import { scopeKeyOf, type Dependencies, type ReplayReport, type TwinRuntime, type TwinStore } from './port.ts';
import { TwinErrors, managementCategories, type ComposedSnapshot, type ManagementCategory, type SnapshotSpec, type TwinItem } from './types.ts';

export type TwinRuntimeOptions = {
  store: TwinStore;
  sources: TwinSources;
  clock: Clock;
};

export function createTwinRuntime(opts: TwinRuntimeOptions): TwinRuntime {
  const { store, sources, clock } = opts;
  const explainer = createExplainer(sources);
  const now = () => clock.now().toISOString();

  async function load(scope: Scope, id: string): Promise<Result<ComposedSnapshot>> {
    const snapshot = await store.getSnapshot(scope, id);
    if (!snapshot.ok) return snapshot;
    if (!snapshot.value) return fail(TwinErrors.NOT_FOUND, `Snapshot ${id} not found.`);
    const items = await store.getItems(scope, id);
    if (!items.ok) return items;
    return ok({ snapshot: snapshot.value, items: items.value });
  }

  async function build(scope: Scope, spec: SnapshotSpec, grantedUnitIds: readonly string[], previousSnapshotId: string | null): Promise<Result<ComposedSnapshot>> {
    const composed = await composeSnapshot(sources, scope, spec);
    if (!composed.ok) return composed;
    const c = composed.value;
    const fingerprint = snapshotFingerprint(spec, c.model, c.items);
    const saved = await store.saveSnapshot(
      scope,
      {
        spec,
        model: c.model,
        sourceReferences: c.sourceReferences,
        completeness: c.completeness,
        completenessReasons: c.reasons,
        sensitivityClasses: containerSensitivity(c.items),
        grantedUnitIds: [...grantedUnitIds].sort(),
        itemCount: c.items.length,
        fingerprint,
        previousSnapshotId,
        builtBy: scope.actorId ?? null,
        createdAt: now(),
      },
      c.items,
    );
    if (!saved.ok) return saved;
    return ok({ snapshot: saved.value, items: c.items });
  }

  const runtime: TwinRuntime = {
    async buildSnapshot(scope, input) {
      if (!hasRole(scope, 'member')) return fail(TwinErrors.INVALID_INPUT, 'Building a snapshot needs member access.');
      const at = now();
      const lens = input.kind === 'CURRENT' ? { effectiveAsOf: at, recordedThrough: at } : input.lens;
      if (!lens) return fail(TwinErrors.INVALID_INPUT, `A ${input.kind} snapshot states its lens: effectiveAsOf and recordedThrough.`);
      if (Date.parse(lens.recordedThrough) > Date.parse(at)) {
        return fail(TwinErrors.INVALID_INPUT, 'A snapshot cannot know what has not been recorded yet: recordedThrough is in the future.');
      }
      if (input.kind === 'HISTORICAL' && Date.parse(lens.recordedThrough) >= Date.parse(at)) {
        return fail(TwinErrors.INVALID_INPUT, 'A HISTORICAL snapshot reads an earlier knowledge boundary than now.');
      }
      const spec: SnapshotSpec = {
        kind: input.kind,
        label: input.label,
        lens: { effectiveAsOf: new Date(lens.effectiveAsOf).toISOString(), recordedThrough: new Date(lens.recordedThrough).toISOString() },
        scope: input.scope,
        periods: [...(input.periods ?? defaultPeriods(lens.effectiveAsOf))].sort(),
        scenarioRunId: input.scenarioRunId ?? null,
        commitmentId: input.commitmentId ?? null,
      };
      let previous: string | null = null;
      if (input.kind === 'CURRENT') {
        const list = await store.listSnapshots(scope, { kind: 'CURRENT', scopeKey: scopeKeyOf(input.scope) });
        if (!list.ok) return list;
        previous = list.value[list.value.length - 1]?.id ?? null;
      }
      return build(scope, spec, input.grantedUnitIds ?? [], previous);
    },

    getSnapshot: load,

    async listSnapshots(scope, filter) {
      return store.listSnapshots(scope, filter);
    },

    async currentState(scope, twinScope) {
      const list = await store.listSnapshots(scope, { kind: 'CURRENT', scopeKey: scopeKeyOf(twinScope) });
      if (!list.ok) return list;
      const latest = list.value[list.value.length - 1];
      return latest ? load(scope, latest.id) : ok(null);
    },

    async replaySnapshot(scope, id): Promise<Result<ReplayReport>> {
      const stored = await load(scope, id);
      if (!stored.ok) return stored;
      const again = await composeSnapshot(sources, scope, stored.value.snapshot.spec);
      if (!again.ok) return again;
      const replayed = snapshotFingerprint(stored.value.snapshot.spec, again.value.model, again.value.items);
      const identical = replayed === stored.value.snapshot.fingerprint;
      const differences: ReplayReport['differences'][number][] = [];
      if (!identical) {
        const delta = compareComposed(stored.value, { snapshot: stored.value.snapshot, items: again.value.items });
        for (const list of [delta.structuralChanges, delta.valueChanges, delta.knowledgeChanges, delta.decisionChanges, delta.assumptionChanges, delta.governanceChanges, delta.constraintChanges, delta.attentionChanges]) {
          for (const c of list) differences.push({ itemKey: c.itemKey, change: c.change });
        }
      }
      return ok({
        snapshotId: id,
        storedFingerprint: stored.value.snapshot.fingerprint,
        replayedFingerprint: replayed,
        identical,
        differences: differences.sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
        statement: identical
          ? `Recomposed under its own lens (effective ${stored.value.snapshot.spec.lens.effectiveAsOf}, known through ${stored.value.snapshot.spec.lens.recordedThrough}), the snapshot is byte-identical.`
          : `Recomposition differs in ${differences.length} item${differences.length === 1 ? '' : 's'}: something the snapshot rested on was rewritten after it was taken, or the model changed.`,
      });
    },

    async compareSnapshots(scope, fromId, toId) {
      const [a, b] = await Promise.all([load(scope, fromId), load(scope, toId)]);
      if (!a.ok) return a;
      if (!b.ok) return b;
      return ok(compareComposed(a.value, b.value));
    },

    async getEntityState(scope, snapshotId, entityId) {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      const entity = s.value.items.find((i) => i.key === `entity:${entityId}`) ?? null;
      const items = s.value.items.filter(
        (i) => i.key !== `entity:${entityId}` && (i.subjectEntityId === entityId || i.state.sourceEntityId === entityId || i.state.targetEntityId === entityId),
      );
      return ok({ entity, items });
    },

    async getValueState(scope, snapshotId, nodeId) {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      return ok(s.value.items.filter((i) => (i.kind === 'VALUE' || i.kind === 'OBJECTIVE') && i.state.nodeId === nodeId));
    },

    async getManagementState(scope, snapshotId) {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      const categories = Object.fromEntries(managementCategories.map((c) => [c, [] as TwinItem[]])) as Record<ManagementCategory, TwinItem[]>;
      for (const i of s.value.items) for (const c of i.categories) categories[c].push(i);
      return ok({ snapshot: s.value.snapshot, categories });
    },

    async getDependencies(scope, snapshotId, itemKey): Promise<Result<Dependencies>> {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      const item = s.value.items.find((i) => i.key === itemKey);
      if (!item) return fail(TwinErrors.NOT_FOUND, `No item ${itemKey} in this snapshot.`);
      const upstream: Dependencies['upstream'][number][] = [];
      const downstream: Dependencies['downstream'][number][] = [];
      const related: Dependencies['related'][number][] = [];
      const valueKeyOf = (nodeId: string) => s.value.items.find((i) => i.kind === 'VALUE' && i.state.nodeId === nodeId)?.key ?? null;
      if (item.kind === 'VALUE' && typeof item.state.nodeId === 'string') {
        const around = await sources.valueGraph.getValueNeighborhood(scope, item.state.nodeId, 'both', s.value.snapshot.spec.lens.effectiveAsOf);
        if (!around.ok) return around;
        for (const n of around.value) {
          const entry = { itemKey: valueKeyOf(n.node.id), label: n.node.label, via: n.via.linkType, nodeId: n.node.id };
          (n.direction === 'upstream' ? upstream : downstream).push(entry);
        }
      }
      if (item.subjectEntityId) {
        for (const r of s.value.items.filter((i) => i.kind === 'RELATIONSHIP' && (i.state.sourceEntityId === item.subjectEntityId || i.state.targetEntityId === item.subjectEntityId))) {
          related.push({ itemKey: r.key, label: r.label, via: String(r.state.type) });
        }
      }
      const decisionId = (item.state.decisionId as string | undefined) ?? (item.kind === 'DECISION' ? item.key.replace(/^decision:/, '') : undefined);
      if (decisionId) {
        for (const r of s.value.items.filter((i) => i.key !== item.key && (i.state.decisionId === decisionId || i.key.endsWith(`:${decisionId}`)))) {
          related.push({ itemKey: r.key, label: r.label, via: r.kind });
        }
      }
      return ok({ itemKey, upstream, downstream, related: related.sort((a, b) => a.itemKey.localeCompare(b.itemKey)) });
    },

    async explainItem(scope, snapshotId, itemKey) {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      const ex = await explainer.explainItem(scope, s.value, itemKey);
      if (!ex.ok) return ex;
      return ex.value ? ok(ex.value) : fail(TwinErrors.NOT_FOUND, `No item ${itemKey} in this snapshot.`);
    },

    async explainDifference(scope, fromId, toId, itemKey, toItemKey) {
      const [a, b] = await Promise.all([load(scope, fromId), load(scope, toId)]);
      if (!a.ok) return a;
      if (!b.ok) return b;
      return explainer.explainDifference(scope, a.value, b.value, itemKey, toItemKey ?? itemKey);
    },

    async getCommittedFuture(scope, commitmentId, input) {
      const existing = await store.listSnapshots(scope, { kind: 'COMMITTED_FUTURE' });
      if (!existing.ok) return existing;
      const lensWanted = input?.lens;
      const found = existing.value.find(
        (s) =>
          s.spec.commitmentId === commitmentId &&
          (!input?.scope || scopeKeyOf(s.spec.scope) === scopeKeyOf(input.scope)) &&
          (!lensWanted || (s.spec.lens.effectiveAsOf === new Date(lensWanted.effectiveAsOf).toISOString() && s.spec.lens.recordedThrough === new Date(lensWanted.recordedThrough).toISOString())),
      );
      if (found) return load(scope, found.id);
      const commitment = await sources.decisions.getCommitment(scope, commitmentId);
      if (!commitment.ok) return commitment;
      if (!commitment.value) return fail(TwinErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
      const decision = await sources.decisions.getDecision(scope, commitment.value.decisionId);
      if (!decision.ok) return decision;
      const periods = commitment.value.expectedOutcomes.filter((e) => e.period).map((e) => e.period!);
      const horizon = decision.value?.horizon.expectedOutcomeHorizon ?? null;
      const at = now();
      const lens = lensWanted ?? { effectiveAsOf: horizon ? new Date(horizon).toISOString() : commitment.value.committedAt, recordedThrough: at };
      return runtime.buildSnapshot(scope, {
        kind: 'COMMITTED_FUTURE',
        label: input?.label ?? `Committed future: ${decision.value?.title ?? commitmentId}`,
        scope: input?.scope ?? { kind: 'ENTERPRISE', label: 'Committed future' },
        lens,
        periods: periods.length > 0 ? [...new Set(periods.map(periodKey))] : undefined,
        commitmentId,
        grantedUnitIds: input?.grantedUnitIds,
      });
    },

    async getTrajectory(scope, currentId, committedFutureId) {
      const [a, b] = await Promise.all([load(scope, currentId), load(scope, committedFutureId)]);
      if (!a.ok) return a;
      if (!b.ok) return b;
      if (b.value.snapshot.spec.kind !== 'COMMITTED_FUTURE') return fail(TwinErrors.NOT_COMPARABLE, 'A trajectory runs from a state to a COMMITTED_FUTURE snapshot.');
      if (a.value.snapshot.spec.kind === 'COMMITTED_FUTURE' || a.value.snapshot.spec.kind === 'SCENARIO') {
        return fail(TwinErrors.NOT_COMPARABLE, 'A trajectory starts from a CURRENT, HISTORICAL or EXPECTED state, never from another future.');
      }
      return ok(trajectoryOf(a.value, b.value));
    },

    async projectForViewer(scope, snapshotId, viewer, units) {
      const s = await load(scope, snapshotId);
      if (!s.ok) return s;
      const visible = canSeeSnapshot(viewer, s.value.snapshot, units);
      if (!visible.visible) return fail(TwinErrors.NOT_VISIBLE, `This snapshot is not visible to the viewer: ${visible.reason}.`);
      return ok(projectForViewer(s.value.items, viewer, now()));
    },

    async grantClearance(scope, input) {
      if (!hasRole(scope, 'admin')) return fail(TwinErrors.INVALID_INPUT, 'Only an organization admin grants a sensitivity clearance.');
      return store.grantClearance(scope, { ...input, grantedBy: scope.actorId ?? null, recordedAt: now() });
    },

    async listClearances(scope, userId) {
      return store.listClearances(scope, userId);
    },
  };
  return runtime;
}
