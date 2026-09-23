/**
 * InMemoryScenarioStore — scenarios, revisions, overrides and simulations in
 * memory, held to the same contract as the Postgres adapter
 * (`runScenarioStoreConformanceSuite`).
 *
 * The immutability rules live HERE, not only in the runtime: a sealed revision
 * and its overrides refuse every change whoever asks, which is the same
 * guarantee the database gives through its triggers.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import {
  ScenarioErrors,
  scenarioTransitions,
  type Scenario,
  type ScenarioConstraintResult,
  type ScenarioOverride,
  type ScenarioRevision,
  type ScenarioRun,
} from './types.ts';
import type { ScenarioStore } from './port.ts';

export type InMemoryScenarioStoreOptions = { clock: Clock; idGen: IdGen };

export function createInMemoryScenarioStore(opts: InMemoryScenarioStoreOptions): ScenarioStore {
  const { clock, idGen } = opts;
  const scenarios = new Map<string, Scenario>();
  const revisions = new Map<string, ScenarioRevision>();
  const overrides = new Map<string, ScenarioOverride>();
  const runs = new Map<string, ScenarioRun>();
  const constraintResults = new Map<string, readonly ScenarioConstraintResult[]>();

  const now = () => clock.now().toISOString();
  const mine = <T extends { orgId: string }>(scope: Scope, row: T | undefined): T | null =>
    row && row.orgId === scope.orgId ? row : null;

  return {
    async createScenario(scope, input) {
      for (const s of scenarios.values()) {
        if (s.orgId === scope.orgId && s.key === input.key) {
          return fail(ScenarioErrors.DUPLICATE_KEY, `A scenario with key "${input.key}" already exists.`);
        }
      }
      if (input.parentScenarioId && !mine(scope, scenarios.get(input.parentScenarioId))) {
        return fail(ScenarioErrors.NOT_FOUND, `Parent scenario ${input.parentScenarioId} not found.`);
      }
      const at = now();
      const s: Scenario = {
        id: idGen.next(),
        orgId: scope.orgId,
        key: input.key,
        name: input.name,
        description: input.description,
        parentScenarioId: input.parentScenarioId,
        scenarioEntityId: input.scenarioEntityId,
        status: 'DRAFT',
        statusReason: null,
        createdBy: input.createdBy,
        createdAt: at,
        updatedAt: at,
        metadata: { ...input.metadata },
      };
      scenarios.set(s.id, s);
      return ok(s);
    },

    async getScenario(scope, id) {
      return ok(mine(scope, scenarios.get(id)));
    },

    async getScenarioByKey(scope, key) {
      for (const s of scenarios.values()) {
        if (s.orgId === scope.orgId && s.key === key) return ok(s);
      }
      return ok(null);
    },

    async listScenarios(scope) {
      return ok(
        [...scenarios.values()]
          .filter((s) => s.orgId === scope.orgId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)),
      );
    },

    async setScenarioStatus(scope, id, status, reason = null) {
      const s = mine(scope, scenarios.get(id));
      if (!s) return fail(ScenarioErrors.NOT_FOUND, `Scenario ${id} not found.`);
      if (s.status !== status && !scenarioTransitions[s.status].includes(status)) {
        return fail(
          ScenarioErrors.INVALID_TRANSITION,
          `A ${s.status} scenario cannot become ${status}.`,
          { from: s.status, to: status },
        );
      }
      const updated: Scenario = { ...s, status, statusReason: reason, updatedAt: now() };
      scenarios.set(id, updated);
      return ok(updated);
    },

    async createRevision(scope, input) {
      if (!mine(scope, scenarios.get(input.scenarioId))) {
        return fail(ScenarioErrors.NOT_FOUND, `Scenario ${input.scenarioId} not found.`);
      }
      const existing = [...revisions.values()].filter((r) => r.scenarioId === input.scenarioId);
      if (existing.some((r) => r.state === 'DRAFT')) {
        return fail(ScenarioErrors.DRAFT_EXISTS, 'This scenario already has a draft revision.');
      }
      if (input.periods.length === 0) {
        return fail(ScenarioErrors.INVALID_INPUT, 'A revision must model at least one period.');
      }
      const r: ScenarioRevision = {
        id: idGen.next(),
        orgId: scope.orgId,
        scenarioId: input.scenarioId,
        revisionNumber: existing.length + 1,
        state: 'DRAFT',
        reason: input.reason,
        basedOnRevisionId: input.basedOnRevisionId,
        parentRevisionId: input.parentRevisionId,
        fork: { ...input.fork },
        periods: [...input.periods],
        modelRef: null,
        fingerprint: null,
        notes: input.notes,
        createdBy: input.createdBy,
        createdAt: now(),
        sealedAt: null,
      };
      revisions.set(r.id, r);
      return ok(r);
    },

    async getRevision(scope, id) {
      return ok(mine(scope, revisions.get(id)));
    },

    async listRevisions(scope, scenarioId) {
      return ok(
        [...revisions.values()]
          .filter((r) => r.orgId === scope.orgId && r.scenarioId === scenarioId)
          .sort((a, b) => a.revisionNumber - b.revisionNumber),
      );
    },

    async sealRevision(scope, id, seal) {
      const r = mine(scope, revisions.get(id));
      if (!r) return fail(ScenarioErrors.NOT_FOUND, `Revision ${id} not found.`);
      if (r.state === 'SEALED') {
        return fail(ScenarioErrors.REVISION_SEALED, `Revision ${id} is already sealed.`);
      }
      const sealed: ScenarioRevision = {
        ...r,
        state: 'SEALED',
        modelRef: seal.modelRef,
        fingerprint: seal.fingerprint,
        sealedAt: now(),
      };
      revisions.set(id, sealed);
      return ok(sealed);
    },

    async addOverride(scope, input) {
      const r = mine(scope, revisions.get(input.revisionId));
      if (!r) return fail(ScenarioErrors.NOT_FOUND, `Revision ${input.revisionId} not found.`);
      if (r.state !== 'DRAFT') {
        return fail(
          ScenarioErrors.REVISION_SEALED,
          'A sealed revision is immutable; create a new revision to change its assumptions.',
        );
      }
      if (r.scenarioId !== input.scenarioId) {
        return fail(ScenarioErrors.INVALID_INPUT, 'Override scenario does not match its revision.');
      }
      const o: ScenarioOverride = { ...input, id: idGen.next(), orgId: scope.orgId, createdAt: now() };
      overrides.set(o.id, o);
      return ok(o);
    },

    async removeOverride(scope, id) {
      const o = mine(scope, overrides.get(id));
      if (!o) return fail(ScenarioErrors.NOT_FOUND, `Override ${id} not found.`);
      const r = revisions.get(o.revisionId);
      if (!r || r.state !== 'DRAFT') {
        return fail(ScenarioErrors.REVISION_SEALED, 'Overrides of a sealed revision cannot be removed.');
      }
      overrides.delete(id);
      return ok(undefined);
    },

    async listOverrides(scope, revisionId) {
      return ok(
        [...overrides.values()]
          .filter((o) => o.orgId === scope.orgId && o.revisionId === revisionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      );
    },

    async createRun(scope, input) {
      if (input.stateKind === 'SCENARIO') {
        const r = input.revisionId ? mine(scope, revisions.get(input.revisionId)) : null;
        if (!r || r.scenarioId !== input.scenarioId) {
          return fail(ScenarioErrors.NOT_FOUND, 'A scenario run needs a revision of its scenario.');
        }
        if (r.state !== 'SEALED') {
          return fail(ScenarioErrors.NOT_EXECUTABLE, 'Only a sealed revision can be simulated.');
        }
        // The run executes the revision's boundary, exactly. A run that
        // claimed one revision and executed another fork would make replay a lie.
        if (
          r.fork.effectiveAsOf !== input.fork.effectiveAsOf ||
          r.fork.recordedThrough !== input.fork.recordedThrough ||
          r.fork.policy !== input.fork.policy
        ) {
          return fail(ScenarioErrors.INVALID_INPUT, 'A scenario run must use its revision\'s fork.');
        }
      } else if (input.scenarioId || input.revisionId) {
        return fail(ScenarioErrors.INVALID_INPUT, 'A baseline run carries no scenario.');
      }
      const run: ScenarioRun = {
        id: idGen.next(),
        orgId: scope.orgId,
        stateKind: input.stateKind,
        scenarioId: input.scenarioId,
        revisionId: input.revisionId,
        kind: input.kind,
        replayOfRunId: input.replayOfRunId,
        status: 'RUNNING',
        completeness: null,
        fork: { ...input.fork },
        periods: [...input.periods],
        fingerprint: input.fingerprint,
        modelRef: input.modelRef,
        periodRuns: [],
        startedAt: now(),
        completedAt: null,
        createdBy: input.createdBy,
        notes: input.notes,
      };
      runs.set(run.id, run);
      return ok(run);
    },

    async attachPeriodRun(scope, runId, periodRun) {
      const run = mine(scope, runs.get(runId));
      if (!run) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (run.status !== 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A completed simulation cannot gain periods.');
      }
      const updated = { ...run, periodRuns: [...run.periodRuns, periodRun] };
      runs.set(runId, updated);
      return ok(updated);
    },

    async completeRun(scope, runId, outcome) {
      const run = mine(scope, runs.get(runId));
      if (!run) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (run.status !== 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A simulation completes once.');
      }
      const updated: ScenarioRun = {
        ...run,
        status: outcome.status,
        completeness: outcome.completeness,
        completedAt: now(),
      };
      runs.set(runId, updated);
      return ok(updated);
    },

    async getRun(scope, id) {
      return ok(mine(scope, runs.get(id)));
    },

    async listRuns(scope, filter = {}) {
      return ok(
        [...runs.values()]
          .filter(
            (r) =>
              r.orgId === scope.orgId &&
              (filter.scenarioId === undefined || r.scenarioId === filter.scenarioId) &&
              (filter.revisionId === undefined || r.revisionId === filter.revisionId) &&
              (filter.stateKind === undefined || r.stateKind === filter.stateKind),
          )
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
      );
    },

    async recordConstraintResults(scope, runId, results) {
      const run = mine(scope, runs.get(runId));
      if (!run) return fail(ScenarioErrors.NOT_FOUND, `Run ${runId} not found.`);
      if (run.status === 'RUNNING') {
        return fail(ScenarioErrors.IMMUTABLE, 'A simulation is judged after it completes.');
      }
      if (constraintResults.has(runId)) {
        return fail(ScenarioErrors.IMMUTABLE, 'Constraint results are recorded once per simulation.');
      }
      constraintResults.set(runId, [...results]);
      return ok(undefined);
    },

    async listConstraintResults(scope, runId) {
      if (!mine(scope, runs.get(runId))) return ok([]);
      return ok(constraintResults.get(runId) ?? []);
    },
  };
}
