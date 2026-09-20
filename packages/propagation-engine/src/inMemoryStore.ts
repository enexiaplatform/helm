/**
 * InMemoryCalculationStore — runs and traces in memory.
 *
 * Append-only by construction: `appendStep` only pushes, and nothing in this
 * module mutates a recorded step. That is the same guarantee the Postgres
 * adapter gets from the absence of UPDATE/DELETE policies (§51).
 */

import {
  asRecordTime,
  fail,
  ok,
  type Clock,
  type IdGen,
  type Scope,
} from '@helm/shared';
import { CalculationErrors, type CalculationRun, type CalculationStep } from './types.ts';
import type { CalculationStore } from './port.ts';

export type InMemoryCalculationStoreOptions = { clock: Clock; idGen: IdGen };

export function createInMemoryCalculationStore(
  opts: InMemoryCalculationStoreOptions,
): CalculationStore {
  const { clock, idGen } = opts;
  const runs = new Map<string, CalculationRun>();
  const steps: CalculationStep[] = [];

  const inOrg = <T extends { orgId: string }>(scope: Scope, row: T) => row.orgId === scope.orgId;

  return {
    async createRun(scope, run) {
      const created: CalculationRun = {
        ...run,
        id: idGen.next(),
        orgId: scope.orgId,
        startedAt: asRecordTime(clock.now().toISOString()),
      };
      runs.set(created.id, created);
      return ok(created);
    },

    async completeRun(scope, runId, status, notes) {
      const run = runs.get(runId);
      if (!run || !inOrg(scope, run)) {
        return fail(CalculationErrors.READ_FAILED, `Calculation run ${runId} not found.`);
      }
      const next: CalculationRun = {
        ...run,
        status,
        notes: notes ?? run.notes,
        completedAt: asRecordTime(clock.now().toISOString()),
      };
      runs.set(runId, next);
      return ok(next);
    },

    async getRun(scope, runId) {
      const run = runs.get(runId);
      return ok(run && inOrg(scope, run) ? run : null);
    },

    async listRuns(scope, limit) {
      const rows = [...runs.values()]
        .filter((r) => inOrg(scope, r))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      return ok(rows.slice(0, limit));
    },

    async appendStep(scope, step) {
      const created: CalculationStep = {
        ...step,
        id: idGen.next(),
        orgId: scope.orgId,
        recordedAt: asRecordTime(clock.now().toISOString()),
      };
      steps.push(created);
      return ok(created);
    },

    async getSteps(scope, runId) {
      const rows = steps
        .filter((s) => inOrg(scope, s) && s.runId === runId)
        .sort((a, b) => a.sequence - b.sequence);
      return ok(rows);
    },

    async findStepByOutputObservation(scope, observationId) {
      const found = [...steps]
        .reverse()
        .find((s) => inOrg(scope, s) && s.outputObservationId === observationId);
      return ok(found ?? null);
    },

    async findLatestStepForNode(scope, nodeId) {
      const found = [...steps]
        .reverse()
        .find(
          (s) =>
            inOrg(scope, s) &&
            s.outputNodeId === nodeId &&
            (s.status === 'CALCULATED' || s.status === 'UNCHANGED'),
        );
      return ok(found ?? null);
    },

  };
}
