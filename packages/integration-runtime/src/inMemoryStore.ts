/**
 * InMemoryIntegrationStore — the reference adapter, held to the same
 * conformance suite as PostgresIntegrationStore.
 *
 * Every record is write-once; the store stamps record time from its own clock;
 * a writeback's idempotency key is unique (a second insert is refused); a
 * DRY_RUN is the only mode; a REFUSED request says why and carries no receipt.
 */

import { fail, ok, type Clock, type IdGen, type Scope } from '@helm/shared';
import type { IntegrationStore, NewSync, NewWriteback } from './port.ts';
import { IntegrationErrors, type SyncRecord, type WritebackRequest } from './types.ts';

export type InMemoryIntegrationStoreOptions = { clock: Clock; idGen: IdGen };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function createInMemoryIntegrationStore(opts: InMemoryIntegrationStoreOptions): IntegrationStore {
  const syncs = new Map<string, SyncRecord[]>();
  const writebacks = new Map<string, WritebackRequest[]>();
  const now = () => opts.clock.now().toISOString();
  const s = (scope: Scope) => syncs.get(scope.orgId) ?? syncs.set(scope.orgId, []).get(scope.orgId)!;
  const w = (scope: Scope) => writebacks.get(scope.orgId) ?? writebacks.set(scope.orgId, []).get(scope.orgId)!;

  return {
    async appendSync(scope, input: NewSync) {
      if (input.outcome === 'SUCCEEDED' && input.quarantined.length > 0) return fail(IntegrationErrors.INVALID, 'A run with quarantined records did not fully succeed.');
      if (input.outcome === 'BLOCKED_BY_DRIFT' && input.cursorAfter !== input.cursorBefore) return fail(IntegrationErrors.INVALID, 'A run blocked by drift does not move the checkpoint.');
      const rec: SyncRecord = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: now() });
      s(scope).push(rec);
      return ok(rec);
    },
    async listSyncs(scope, filter) {
      return ok(s(scope).filter((r) => (!filter?.system || r.system === filter.system) && (!filter?.connector || r.connector === filter.connector)));
    },
    async checkpointOf(scope, system, connector) {
      const mine = s(scope).filter((r) => r.system === system && r.connector === connector);
      const last = [...mine].reverse().find((r) => r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL');
      const lastOk = [...mine].reverse().find((r) => r.outcome === 'SUCCEEDED');
      return ok({ system, connector, cursor: last ? last.cursorAfter : null, lastSucceededAt: lastOk ? lastOk.recordedAt : null });
    },

    async insertWriteback(scope, input: NewWriteback) {
      if (input.mode !== 'DRY_RUN') return fail(IntegrationErrors.LIVE_WRITEBACK_DISABLED, 'Only DRY_RUN is recorded in v1.');
      if (input.outcome === 'REFUSED' && !input.refusalReason) return fail(IntegrationErrors.INVALID, 'A refused request says why.');
      if (input.outcome === 'WOULD_WRITE' && input.refusalReason) return fail(IntegrationErrors.INVALID, 'A request that would write carries no refusal.');
      if (!input.actionIntentId) return fail(IntegrationErrors.NO_INTENT, 'A request derives from an action intent.');
      if (input.outcome === 'WOULD_WRITE' && !['AUTHORIZED', 'APPROVED'].includes(input.governanceState)) return fail(IntegrationErrors.NOT_AUTHORIZED_TO_WRITE_BACK, 'A request that would write is recorded only for a commitment governance permits to be executed.');
      if (w(scope).some((r) => r.idempotencyKey === input.idempotencyKey)) return fail(IntegrationErrors.DUPLICATE, 'A request with this idempotency key is already recorded.');
      const rec: WritebackRequest = deepFreeze({ ...input, id: opts.idGen.next(), orgId: scope.orgId, recordedAt: now() });
      w(scope).push(rec);
      return ok(rec);
    },
    async findWriteback(scope, key) {
      return ok(w(scope).find((r) => r.idempotencyKey === key) ?? null);
    },
    async listWritebacks(scope, filter) {
      return ok(w(scope).filter((r) => !filter?.commitmentId || r.commitmentId === filter.commitmentId));
    },
  };
}
