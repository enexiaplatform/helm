/**
 * The TwinStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: a snapshot is stored only with the
 * manifest its fingerprint was computed from, it is never rewritten, a CURRENT
 * snapshot only follows a CURRENT snapshot of the same scope and only forward
 * in knowledge, a snapshot cannot claim knowledge recorded after it was built,
 * every item names a kernel object, the sensitivity label is derived from the
 * items, clearances name a real restricted class with a real window, and
 * nothing crosses a tenant boundary.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import { snapshotFingerprint } from './fingerprint.ts';
import { containerSensitivity } from './sensitivity.ts';
import type { NewSnapshot, TwinStore } from './port.ts';
import type { ModelIdentity, SnapshotSpec, TwinItem, TwinScope } from './types.ts';

export type TwinTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type TwinStoreHarness = {
  name: string;
  create(): Promise<{
    store: TwinStore;
    scopeA: Scope;
    scopeB: Scope;
    /** An entity id of scopeA's graph to anchor fixture scopes on. */
    anchorEntityId: string;
    /** A user of scopeA to grant clearances to. */
    userId: UserId;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const MODEL: ModelIdentity = { engineVersion: 'conformance', calculations: ['calc@1.0.0'], attentionRules: 'rules@1', composer: 'composer@1' };

function fixtureItems(anchor: string, marker: string): TwinItem[] {
  return [
    {
      key: `entity:${anchor}`,
      kind: 'ENTITY',
      categories: ['STRUCTURE'],
      label: `Conformance anchor ${marker}`,
      subjectEntityId: anchor,
      layer: null,
      status: 'KNOWN',
      state: { name: 'anchor', marker },
      refs: [{ kind: 'ENTITY_VERSION', id: anchor, pin: 'v1', label: 'anchor' }],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    },
    {
      key: `value:node-${marker}:ACTUAL:2026-Q4`,
      kind: 'VALUE',
      categories: ['VALUE', 'PERFORMANCE'],
      label: 'Gross margin — actual',
      subjectEntityId: anchor,
      layer: 'ACTUAL',
      status: 'KNOWN',
      state: { nodeId: `node-${marker}`, metricKey: 'GrossMarginPct', value: '31.7', unit: 'percentage', period: '2026-Q4' },
      refs: [{ kind: 'OBSERVATION', id: `obs-${marker}`, pin: '2027-01-12T03:00:00.000Z', label: 'ACTUAL' }],
      sensitivity: 'FINANCIAL_SENSITIVE',
      reason: null,
    },
  ];
}

function header(kind: SnapshotSpec['kind'], scope: TwinScope, recordedThrough: string, createdAt: string, items: readonly TwinItem[], previousSnapshotId: string | null = null): NewSnapshot {
  const spec: SnapshotSpec = {
    kind,
    label: `conformance ${kind}`,
    lens: { effectiveAsOf: recordedThrough, recordedThrough },
    scope,
    periods: ['2026-Q4'],
    scenarioRunId: null,
    commitmentId: null,
  };
  return {
    spec,
    model: MODEL,
    sourceReferences: [{ kind: 'CALCULATION_RUN', id: 'run-conformance', pin: null, label: null }],
    completeness: 'COMPLETE',
    completenessReasons: [],
    sensitivityClasses: containerSensitivity(items),
    grantedUnitIds: [],
    itemCount: items.length,
    fingerprint: snapshotFingerprint(spec, MODEL, items),
    previousSnapshotId,
    builtBy: null,
    createdAt,
  };
}

export function runTwinStoreConformanceSuite(api: TwinTestApi, harness: TwinStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`TwinStore conformance — ${harness.name}`, () => {
    const setup = async () => {
      const h = await harness.create();
      const marker = `${h.now().getTime()}-${Math.floor(h.now().getTime() % 997)}`;
      const scope: TwinScope = { kind: 'ENTITY', entityId: h.anchorEntityId, entityTypeKey: 'Country', label: 'Conformance' };
      const items = fixtureItems(h.anchorEntityId, marker);
      const at = (offsetMinutes: number) => new Date(h.now().getTime() + offsetMinutes * 60_000).toISOString();
      return { ...h, scope, items, at, marker };
    };

    it('stores a snapshot with its manifest and reads both back unchanged', async () => {
      const h = await setup();
      const created = h.at(0);
      const saved = expectOk(await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-1), created, h.items), h.items), 'save');
      assert.equal(saved.itemCount, 2);
      const read = expectOk(await h.store.getSnapshot(h.scopeA, saved.id), 'get');
      assert.equal(read?.fingerprint, saved.fingerprint);
      assert.deepEqual(read?.spec.lens, saved.spec.lens);
      assert.deepEqual(read?.sensitivityClasses, ['GENERAL_MANAGEMENT', 'FINANCIAL_SENSITIVE']);
      const items = expectOk(await h.store.getItems(h.scopeA, saved.id), 'items');
      assert.deepEqual(
        [...items].sort((a, b) => a.key.localeCompare(b.key)).map((i) => [i.key, i.kind, i.layer, i.sensitivity, i.state.value ?? null]),
        [...h.items].sort((a, b) => a.key.localeCompare(b.key)).map((i) => [i.key, i.kind, i.layer, i.sensitivity, i.state.value ?? null]),
      );
      assert.equal(snapshotFingerprint(read!.spec, read!.model, items), saved.fingerprint, 'the stored manifest still produces the stored fingerprint');
      await h.cleanup?.();
    });

    it('refuses a fingerprint that does not match the manifest, a wrong count, a duplicate key, a free-standing item and a declared label', async () => {
      const h = await setup();
      const good = header('CURRENT', h.scope, h.at(-1), h.at(0), h.items);
      assert.equal((await h.store.saveSnapshot(h.scopeA, { ...good, fingerprint: 'tws_forged_1' }, h.items)).ok, false, 'forged fingerprint');
      assert.equal((await h.store.saveSnapshot(h.scopeA, { ...good, itemCount: 3 }, h.items)).ok, false, 'wrong item count');
      const dup = [h.items[0], { ...h.items[0] }];
      assert.equal((await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-1), h.at(0), dup), dup)).ok, false, 'duplicate key');
      const bare = [{ ...h.items[0], refs: [] }];
      assert.equal((await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-1), h.at(0), bare), bare)).ok, false, 'item naming no kernel object');
      assert.equal((await h.store.saveSnapshot(h.scopeA, { ...good, sensitivityClasses: ['GENERAL_MANAGEMENT'] }, h.items)).ok, false, 'a label that hides a class the items carry');
      await h.cleanup?.();
    });

    it('refuses a snapshot that claims knowledge recorded after it was built', async () => {
      const h = await setup();
      const r = await h.store.saveSnapshot(h.scopeA, header('HISTORICAL', h.scope, h.at(10), h.at(0), h.items), h.items);
      assert.equal(r.ok, false);
      await h.cleanup?.();
    });

    it('a CURRENT snapshot follows only a CURRENT snapshot of its scope, and only forward in knowledge', async () => {
      const h = await setup();
      const first = expectOk(await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-10), h.at(-9), h.items), h.items), 'first');
      const next = expectOk(await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-5), h.at(-4), h.items, first.id), h.items), 'next');
      assert.equal(next.previousSnapshotId, first.id);
      const backwards = await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-20), h.at(-3), h.items, next.id), h.items);
      assert.equal(backwards.ok, false, 'current state moved backwards in knowledge');
      const historical = expectOk(await h.store.saveSnapshot(h.scopeA, header('HISTORICAL', h.scope, h.at(-30), h.at(-2), h.items), h.items), 'historical');
      const afterHistorical = await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-1), h.at(0), h.items, historical.id), h.items);
      assert.equal(afterHistorical.ok, false, 'a CURRENT snapshot followed a HISTORICAL one');
      const listed = expectOk(await h.store.listSnapshots(h.scopeA, { kind: 'CURRENT', scopeKey: h.anchorEntityId }), 'list');
      assert.ok(listed.some((s) => s.id === first.id) && listed.some((s) => s.id === next.id));
      assert.ok(!listed.some((s) => s.id === historical.id), 'the kind filter holds');
      await h.cleanup?.();
    });

    it('nothing crosses a tenant boundary', async () => {
      const h = await setup();
      const saved = expectOk(await h.store.saveSnapshot(h.scopeA, header('CURRENT', h.scope, h.at(-1), h.at(0), h.items), h.items), 'save');
      assert.equal(expectOk(await h.store.getSnapshot(h.scopeB, saved.id), 'get as B'), null);
      assert.equal((await h.store.getItems(h.scopeB, saved.id)).ok, false);
      assert.ok(!expectOk(await h.store.listSnapshots(h.scopeB), 'list as B').some((s) => s.id === saved.id));
      const chained = await h.store.saveSnapshot(h.scopeB, header('CURRENT', h.scope, h.at(-1), h.at(0), h.items, saved.id), h.items);
      assert.equal(chained.ok, false, 'a snapshot of B followed one of A');
      await h.cleanup?.();
    });

    it('a clearance names a restricted class, a real window and a reason, and stays in its tenant', async () => {
      const h = await setup();
      const base = { userId: h.userId, validFrom: h.at(-60), validTo: null, reason: 'conformance clearance', grantedBy: null, recordedAt: h.at(0) };
      const granted = expectOk(await h.store.grantClearance(h.scopeA, { ...base, sensitivity: 'FINANCIAL_SENSITIVE' }), 'grant');
      assert.equal(granted.sensitivity, 'FINANCIAL_SENSITIVE');
      assert.equal((await h.store.grantClearance(h.scopeA, { ...base, sensitivity: 'GENERAL_MANAGEMENT' })).ok, false, 'general needs no clearance');
      assert.equal((await h.store.grantClearance(h.scopeA, { ...base, sensitivity: 'TOP_SECRET' as never })).ok, false, 'an unknown class');
      assert.equal((await h.store.grantClearance(h.scopeA, { ...base, sensitivity: 'HR_RESTRICTED', validTo: h.at(-120) })).ok, false, 'ends before it starts');
      assert.equal((await h.store.grantClearance(h.scopeA, { ...base, sensitivity: 'HR_RESTRICTED', reason: '' })).ok, false, 'no reason');
      const mine = expectOk(await h.store.listClearances(h.scopeA, h.userId), 'list');
      assert.ok(mine.some((c) => c.id === granted.id));
      assert.ok(!expectOk(await h.store.listClearances(h.scopeB), 'list as B').some((c) => c.id === granted.id));
      await h.cleanup?.();
    });
  });
}
