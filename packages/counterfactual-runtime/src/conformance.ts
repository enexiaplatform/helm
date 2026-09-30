/**
 * The CounterfactualStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: records are write-once and stamped
 * with the store's own record time; a case cannot be anchored after the
 * decision boundary; the two retrospective lenses cannot be blended in storage
 * (AS_KNOWN_THEN carries no hindsight and is read at or before the boundary,
 * WITH_HINDSIGHT carries some, each learned after it); a world is ESTIMATED
 * only where a scenario run stands behind it and says why when it is not;
 * a review states its limitations; nothing crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { CounterfactualStore, NewCase, NewWorld } from './port.ts';
import type { HindsightInput } from './types.ts';

export type CounterfactualTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type CounterfactualStoreHarness = {
  name: string;
  create(): Promise<{
    store: CounterfactualStore;
    scopeA: Scope;
    scopeB: Scope;
    /** A decision and its commitment in scopeA's organization, and a twin snapshot to anchor to. */
    decisionId: string;
    commitmentId: string;
    snapshotId: string;
    /** A real scenario run the fixture worlds may stand on. */
    scenario: { scenarioId: string; revisionId: string | null; runId: string };
    /** The instant the fixture decision was committed: the boundary the fixtures use. */
    boundaryIso: string;
    userId: UserId;
    now: () => Date;
    cleanup?: () => Promise<void>;
  }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

const BASIC_SCOPE = { kind: 'ENTERPRISE_WIDE', justification: 'A conformance fixture that claims nothing about any enterprise.' } as const;
const METRIC = { label: 'Gross margin %', metricKey: 'GrossMarginPct', nodeId: null, period: null, unit: null, currency: null } as const;

const shift = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export function runCounterfactualStoreConformanceSuite(api: CounterfactualTestApi, harness: CounterfactualStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`CounterfactualStore conformance — ${harness.name}`, () => {
    const caseOf = (h: Awaited<ReturnType<CounterfactualStoreHarness['create']>>, title: string, anchorAt?: string): NewCase => ({
      decisionId: h.decisionId,
      commitmentId: h.commitmentId,
      title,
      question: 'What might have happened under the alternative?',
      intervention: { kind: 'OVERRIDES', label: 'Fixture intervention', overrides: [] },
      anchor: { snapshotId: h.snapshotId, lens: { effectiveAsOf: anchorAt ?? shift(h.boundaryIso, -10), recordedThrough: anchorAt ?? shift(h.boundaryIso, -10) } },
      boundary: { effectiveAsOf: shift(h.boundaryIso, -5), recordedThrough: h.boundaryIso },
      compared: [METRIC],
      scope: BASIC_SCOPE,
      sensitivityClasses: ['GENERAL_MANAGEMENT'],
      visibility: 'ORG_WIDE',
      grantedUnitIds: [],
      authoredBy: h.userId,
      authoredByLabel: 'conformance',
    });
    const worldOf = (h: Awaited<ReturnType<CounterfactualStoreHarness['create']>>, caseId: string, over: Partial<NewWorld> = {}): NewWorld => ({
      caseId,
      lens: 'AS_KNOWN_THEN',
      method: 'MODEL_COUNTERFACTUAL',
      estimability: 'ESTIMATED',
      notEstimableReasons: [],
      anchorFork: { effectiveAsOf: shift(h.boundaryIso, -10), recordedThrough: shift(h.boundaryIso, -10), policy: 'SOURCE_TRUTH' },
      knowledge: { effectiveAsOf: shift(h.boundaryIso, -5), recordedThrough: h.boundaryIso },
      origin: 'BOUND_TO_DECISION',
      scenario: h.scenario,
      model: { engineVersion: 'fixture', calculations: [] },
      readings: [],
      movedInputs: [],
      assumptions: [],
      constraints: [],
      hindsightInputs: [],
      uncertainty: ['A fixture.'],
      statement: 'A fixture world.',
      fingerprint: 'cfw_fixture',
      createdBy: h.userId,
      createdByLabel: 'conformance',
      ...over,
    });
    const hindsight = (_h: Awaited<ReturnType<CounterfactualStoreHarness['create']>>, learnedAt: string): HindsightInput => ({
      label: 'A fact learned later',
      source: { kind: 'EXTERNAL_RECORD', ref: 'fixture' },
      learnedAt,
      override: { overrideType: 'VALUE_OVERRIDE', targetNodeId: '00000000-0000-4000-8000-0000000000cc', operation: 'SET', value: '0', unit: 'units', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'A fixture.' },
      exogeneity: 'A fixture: nothing about any enterprise.',
    });

    it('stamps record time itself; a case is write-once and cannot be anchored after the boundary', async () => {
      const h = await harness.create();
      const before = h.now().getTime() - 5 * 60_000;
      const c = expectOk(await h.store.insertCase(h.scopeA, caseOf(h, 'conformance case')), 'case');
      assert.ok(Date.parse(c.recordedAt) >= before, "record time is the store's, not a caller's");
      const late = await h.store.insertCase(h.scopeA, caseOf(h, 'anchored in hindsight', shift(h.boundaryIso, 30)));
      assert.equal(late.ok, false, 'an anchor known after the decision boundary is refused');
      const bare = await h.store.insertCase(h.scopeA, { ...caseOf(h, 'no question'), question: '   ' });
      assert.equal(bare.ok, false, 'a case states its question');
      const listed = expectOk(await h.store.listCases(h.scopeA, { decisionId: h.decisionId }), 'list');
      assert.ok(listed.some((x) => x.id === c.id));
      await h.cleanup?.();
    });

    it('the two lenses cannot be blended in storage', async () => {
      const h = await harness.create();
      const c = expectOk(await h.store.insertCase(h.scopeA, caseOf(h, 'lens case')), 'case');
      const then = expectOk(await h.store.insertWorld(h.scopeA, worldOf(h, c.id)), 'as known then');
      assert.equal(then.lens, 'AS_KNOWN_THEN');
      const blended = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { hindsightInputs: [hindsight(h, shift(h.boundaryIso, 60))] }));
      assert.equal(blended.ok, false, 'AS_KNOWN_THEN carries no hindsight input');
      const late = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { knowledge: { effectiveAsOf: shift(h.boundaryIso, 60), recordedThrough: shift(h.boundaryIso, 60) } }));
      assert.equal(late.ok, false, 'AS_KNOWN_THEN is read at or before the decision boundary');
      const none = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { lens: 'WITH_HINDSIGHT', hindsightInputs: [] }));
      assert.equal(none.ok, false, 'WITH_HINDSIGHT carries at least one hindsight input');
      const knowable = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { lens: 'WITH_HINDSIGHT', hindsightInputs: [hindsight(h, shift(h.boundaryIso, -1))] }));
      assert.equal(knowable.ok, false, 'a fact knowable at the boundary is not hindsight');
      const good = expectOk(
        await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { lens: 'WITH_HINDSIGHT', origin: 'COMPUTED_FOR_CASE', knowledge: { effectiveAsOf: shift(h.boundaryIso, 90), recordedThrough: shift(h.boundaryIso, 90) }, hindsightInputs: [hindsight(h, shift(h.boundaryIso, 60))] })),
        'with hindsight',
      );
      assert.equal(good.lens, 'WITH_HINDSIGHT');
      await h.cleanup?.();
    });

    it('a world is ESTIMATED only where a scenario run stands behind it, and says why when it is not; its state is anchored in the past', async () => {
      const h = await harness.create();
      const c = expectOk(await h.store.insertCase(h.scopeA, caseOf(h, 'estimability case')), 'case');
      const unbacked = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { scenario: null, origin: null }));
      assert.equal(unbacked.ok, false, 'ESTIMATED without a scenario run is refused');
      const mute = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { estimability: 'NOT_ESTIMABLE', scenario: null, origin: null, model: null, notEstimableReasons: [] }));
      assert.equal(mute.ok, false, 'NOT_ESTIMABLE says why');
      const honest = expectOk(
        await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { estimability: 'NOT_ESTIMABLE', scenario: null, origin: null, model: null, notEstimableReasons: ['The alternative was never modelled.'] })),
        'not estimable',
      );
      assert.deepEqual(honest.notEstimableReasons, ['The alternative was never modelled.']);
      const today = await h.store.insertWorld(h.scopeA, worldOf(h, c.id, { anchorFork: { effectiveAsOf: shift(h.boundaryIso, 60), recordedThrough: shift(h.boundaryIso, 60), policy: 'SOURCE_TRUTH' } }));
      assert.equal(today.ok, false, "a world's state is never anchored after the decision boundary");
      const worlds = expectOk(await h.store.listWorlds(h.scopeA, c.id), 'worlds');
      assert.equal(worlds.length, 1, 'refused worlds left nothing behind');
      await h.cleanup?.();
    });

    it('a review states its reading and its limitations, is pinned to a comparison, and is appended — never edited', async () => {
      const h = await harness.create();
      const c = expectOk(await h.store.insertCase(h.scopeA, caseOf(h, 'review case')), 'case');
      const early = await h.store.insertReview(h.scopeA, { caseId: c.id, comparisonFingerprint: 'cfc_x', statement: 'Reading.', limitations: 'None.', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(early.ok, false, 'there is no world yet to review');
      expectOk(await h.store.insertWorld(h.scopeA, worldOf(h, c.id)), 'a world to read');
      const bare = await h.store.insertReview(h.scopeA, { caseId: c.id, comparisonFingerprint: 'cfc_x', statement: 'Reading.', limitations: '  ', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(bare.ok, false, 'a review without limitations is refused');
      const mute = await h.store.insertReview(h.scopeA, { caseId: c.id, comparisonFingerprint: 'cfc_x', statement: ' ', limitations: 'None.', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(mute.ok, false, 'a review states a reading');
      expectOk(await h.store.insertReview(h.scopeA, { caseId: c.id, comparisonFingerprint: 'cfc_x', statement: 'Reading one.', limitations: 'A fixture.', reviewedBy: h.userId, reviewedByLabel: 'conformance' }), 'review 1');
      expectOk(await h.store.insertReview(h.scopeA, { caseId: c.id, comparisonFingerprint: 'cfc_y', statement: 'Reading two.', limitations: 'A fixture.', reviewedBy: h.userId, reviewedByLabel: 'conformance' }), 'review 2');
      const reviews = expectOk(await h.store.listReviews(h.scopeA, c.id), 'reviews');
      assert.deepEqual(reviews.map((r) => r.statement).sort(), ['Reading one.', 'Reading two.']);
      await h.cleanup?.();
    });

    it('nothing crosses the tenant wall', async () => {
      const h = await harness.create();
      const c = expectOk(await h.store.insertCase(h.scopeA, caseOf(h, 'tenant A case')), 'case');
      const w = expectOk(await h.store.insertWorld(h.scopeA, worldOf(h, c.id)), 'world');
      const seen = expectOk(await h.store.listCases(h.scopeB), 'B cases');
      assert.ok(!seen.some((x) => x.id === c.id), "B does not see A's cases");
      const worlds = expectOk(await h.store.listWorlds(h.scopeB), 'B worlds');
      assert.ok(!worlds.some((x) => x.id === w.id), "B does not see A's worlds");
      const cross = await h.store.insertWorld(h.scopeB, worldOf(h, c.id));
      assert.equal(cross.ok, false, "B cannot add a world to A's case");
      const review = await h.store.insertReview(h.scopeB, { caseId: c.id, comparisonFingerprint: 'cfc_x', statement: 'Reading.', limitations: 'None.', reviewedBy: h.userId, reviewedByLabel: 'conformance' });
      assert.equal(review.ok, false, "B cannot review A's case");
      await h.cleanup?.();
    });
  });
}
