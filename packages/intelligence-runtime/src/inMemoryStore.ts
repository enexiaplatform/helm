/**
 * InMemoryAiRunStore — the reference adapter, held to the same conformance suite
 * as PostgresAiRunStore.
 *
 * Every run is write-once; the store stamps record time from its clock; and the
 * shape of a run cannot hold a reasoning trace: its output has statements,
 * questions and unknowns, and its provider an id, a model and a version.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { AiRunStore, NewAiRun } from './port.ts';
import { IntelligenceErrors, type AiRun } from './types.ts';

export type InMemoryAiRunStoreOptions = { clock: Clock; idGen: IdGen };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const only = (o: object, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function createInMemoryAiRunStore(opts: InMemoryAiRunStoreOptions): AiRunStore {
  const runs = new Map<string, AiRun[]>();
  const mine = (scope: Scope) => runs.get(scope.orgId) ?? runs.set(scope.orgId, []).get(scope.orgId)!;
  return {
    async insertRun(scope, input: NewAiRun) {
      if (!input.userId || !input.task || !input.templateId || !input.promptHash) return fail(IntelligenceErrors.INVALID, 'A run names who asked, the task, the template and the prompt hash.');
      if (!only(input.output, ['statements', 'questions', 'unknowns'])) return fail(IntelligenceErrors.INVALID, 'A run records statements, questions and unknowns — there is no place for a reasoning trace.');
      if (!only(input.provider, ['id', 'model', 'modelVersion'])) return fail(IntelligenceErrors.INVALID, 'A provider is an id, a model and a version.');
      if (!only(input.resultMeta, ['statementsByClass', 'evidenceCount', 'fingerprint'])) return fail(IntelligenceErrors.INVALID, 'Result metadata is counts and a fingerprint.');
      const r: AiRun = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: opts.clock.now().toISOString() });
      mine(scope).push(r);
      return ok(r);
    },
    async getRun(scope, id) {
      return ok(mine(scope).find((r) => r.id === id) ?? null);
    },
    async listRuns(scope, filter) {
      return ok(mine(scope).filter((r) => (!filter?.userId || r.userId === filter.userId) && (!filter?.task || r.task === filter.task)));
    },
  };
}
