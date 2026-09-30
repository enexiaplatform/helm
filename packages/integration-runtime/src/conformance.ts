/**
 * The IntegrationStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: records are write-once and stamped
 * with the store's own record time; the checkpoint is derived from the ledger
 * and a blocked or failed run never moves it; a dry-run writeback is unique on
 * its idempotency key, derives from an action intent, is DRY_RUN only, and a
 * refusal says why; nothing crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { IntegrationStore, NewSync, NewWriteback } from './port.ts';

export type IntegrationTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
};

export type IntegrationStoreHarness = {
  name: string;
  create(): Promise<{
    store: IntegrationStore;
    scopeA: Scope;
    scopeB: Scope;
    /** A commitment of scopeA's organization, its decision, and an action intent of that commitment. */
    commitmentId: string;
    decisionId: string;
    actionIntentId: string;
    userId: UserId;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const COUNTS = { records: 1, entitiesCreated: 1, entitiesUpdated: 0, entitiesUnchanged: 0, relationshipsCreated: 0, aliasesRegistered: 1, observationsRecorded: 1, observationsUnchanged: 0, quarantined: 0 };
let n = 0;
const unique = (p: string) => `${p}-${Date.now()}-${(n += 1)}`;

export function runIntegrationStoreConformanceSuite(api: IntegrationTestApi, harness: IntegrationStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`IntegrationStore conformance — ${harness.name}`, () => {
    const sync = (connector: string, over: Partial<NewSync> = {}): NewSync => ({
      system: 'memoire',
      connector,
      cursorBefore: null,
      cursorAfter: 'c1',
      outcome: 'SUCCEEDED',
      counts: COUNTS,
      drift: [],
      quarantined: [],
      ingestionEventId: null,
      startedBy: null,
      ...over,
    });
    const writeback = (h: Awaited<ReturnType<IntegrationStoreHarness['create']>>, key: string, over: Partial<NewWriteback> = {}): NewWriteback => ({
      commitmentId: h.commitmentId,
      decisionId: h.decisionId,
      actionIntentId: h.actionIntentId,
      targetSystem: 'memoire',
      operation: 'CREATE_ACTION',
      payload: { title: 'fixture' },
      payloadHash: 'h',
      idempotencyKey: key,
      mode: 'DRY_RUN',
      outcome: 'WOULD_WRITE',
      refusalReason: null,
      receipt: { sent: false, endpoint: 'memoire.actions' },
      governanceState: 'AUTHORIZED',
      requestedBy: h.userId,
      ...over,
    });

    it('a sync is recorded once, with a record time the store stamped; the checkpoint is the latest run that moved it', async () => {
      const h = await harness.create();
      try {
        const connector = unique('conformance');
        const first = expectOk(await h.store.appendSync(h.scopeA, sync(connector)), 'first sync');
        assert.ok(first.recordedAt, 'the store stamps record time');
        assert.equal(expectOk(await h.store.checkpointOf(h.scopeA, 'memoire', connector), 'checkpoint').cursor, 'c1');
        expectOk(await h.store.appendSync(h.scopeA, sync(connector, { cursorBefore: 'c1', cursorAfter: 'c2' })), 'second sync');
        assert.equal(expectOk(await h.store.checkpointOf(h.scopeA, 'memoire', connector), 'checkpoint 2').cursor, 'c2');
      } finally {
        await h.cleanup?.();
      }
    });

    it('a run blocked by drift or failed does not move the checkpoint, and cannot say it did', async () => {
      const h = await harness.create();
      try {
        const connector = unique('conformance');
        expectOk(await h.store.appendSync(h.scopeA, sync(connector)), 'sync');
        const moved = await h.store.appendSync(h.scopeA, sync(connector, { outcome: 'BLOCKED_BY_DRIFT', cursorBefore: 'c1', cursorAfter: 'c9' }));
        assert.equal(moved.ok, false, 'a blocked run that moved the cursor was accepted');
        expectOk(await h.store.appendSync(h.scopeA, sync(connector, { outcome: 'BLOCKED_BY_DRIFT', cursorBefore: 'c1', cursorAfter: 'c1' })), 'blocked, held');
        assert.equal(expectOk(await h.store.checkpointOf(h.scopeA, 'memoire', connector), 'checkpoint').cursor, 'c1');
        const dirty = await h.store.appendSync(h.scopeA, sync(connector, { quarantined: [{ externalId: 'x', reason: 'r' }] }));
        assert.equal(dirty.ok, false, 'a run with quarantined records claimed to have fully succeeded');
      } finally {
        await h.cleanup?.();
      }
    });

    it('a dry-run writeback is unique on its idempotency key', async () => {
      const h = await harness.create();
      try {
        const key = unique('wb');
        const w = expectOk(await h.store.insertWriteback(h.scopeA, writeback(h, key)), 'first writeback');
        assert.equal(w.mode, 'DRY_RUN');
        const again = await h.store.insertWriteback(h.scopeA, writeback(h, key));
        assert.equal(again.ok, false, 'the same idempotency key was recorded twice');
        assert.equal(again.ok ? '' : again.error.code, 'integration.duplicate');
        assert.equal(expectOk(await h.store.findWriteback(h.scopeA, key), 'find')?.id, w.id);
      } finally {
        await h.cleanup?.();
      }
    });

    it('a live mode is not recordable; a refusal says why; a would-write is governed', async () => {
      const h = await harness.create();
      try {
        const live = await h.store.insertWriteback(h.scopeA, writeback(h, unique('wb'), { mode: 'LIVE' as never }));
        assert.equal(live.ok, false, 'a LIVE writeback was recorded');
        const silent = await h.store.insertWriteback(h.scopeA, writeback(h, unique('wb'), { outcome: 'REFUSED', refusalReason: null, receipt: {} }));
        assert.equal(silent.ok, false, 'a refusal with no reason was recorded');
        expectOk(await h.store.insertWriteback(h.scopeA, writeback(h, unique('wb'), { outcome: 'REFUSED', refusalReason: 'Governance state is PENDING_APPROVAL.', governanceState: 'PENDING_APPROVAL', receipt: {} })), 'refusal with a reason');
        const ungoverned = await h.store.insertWriteback(h.scopeA, writeback(h, unique('wb'), { governanceState: 'PENDING_APPROVAL' }));
        assert.equal(ungoverned.ok, false, 'a would-write was recorded for a commitment that was not authorized or approved');
      } finally {
        await h.cleanup?.();
      }
    });

    it('nothing crosses a tenant wall', async () => {
      const h = await harness.create();
      try {
        const connector = unique('conformance');
        expectOk(await h.store.appendSync(h.scopeA, sync(connector)), 'sync');
        assert.equal(expectOk(await h.store.checkpointOf(h.scopeB, 'memoire', connector), 'B checkpoint').cursor, null);
        assert.equal(expectOk(await h.store.listSyncs(h.scopeB, { connector }), 'B list').length, 0);
      } finally {
        await h.cleanup?.();
      }
    });
  });
}
