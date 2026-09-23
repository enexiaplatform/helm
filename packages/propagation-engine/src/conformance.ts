/**
 * The CalculationStore conformance suite.
 *
 * ONE contract, run against EVERY adapter — the same discipline as the Phase 1
 * GraphStore and Phase 2 ValueGraph suites, for the same reason: an
 * adapter-specific assumption fails here immediately rather than in production.
 *
 * The suite runs the real engine over the real canonical value chain against
 * whichever store it is handed, because the properties worth guaranteeing —
 * append-only traces, reproducible runs, tenant isolation, lineage from an
 * observation back to the step that made it — are properties of the store as
 * the engine actually uses it, not of its method signatures.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import { quarterPeriod, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph } from '@helm/value-graph';
import type { CalculationStore, PropagationEngine } from './port.ts';

export type TestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type CalculationAdapterHarness = {
  name: string;
  /**
   * A fresh stack: the canonical entity graph, the canonical value chain, a
   * store and an engine over both. `nodeIds` are the value-chain handles.
   */
  create(): Promise<{
    engine: PropagationEngine;
    store: CalculationStore;
    valueGraph: ValueGraph;
    graphStore: GraphStore;
    scopeA: Scope;
    scopeB: Scope;
    nodeIds: Record<string, string>;
    asOf: Date;
    cleanup?: () => Promise<void>;
  }>;
  skip?: readonly string[];
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

/** A successful read that returned nothing is a failure of this suite's premise. */
function present<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`${what} was expected to exist`);
  return v;
}

const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];

export function runCalculationConformanceSuite(
  api: TestApi,
  harness: CalculationAdapterHarness,
): void {
  const { describe, it, assert } = api;
  const skip = new Set(harness.skip ?? []);
  const test = (name: string, fn: () => Promise<void>) => {
    if (skip.has(name)) return;
    it(name, fn);
  };

  describe(`CalculationStore conformance — ${harness.name}`, () => {
    // -------------------------------------------------------- runs

    test('a run records the full context it executed under', async () => {
      const h = await harness.create();
      try {
        const result = expectOk(
          await h.engine.execute(h.scopeA, {
            fromMetricKeys: ROOTS,
            asOf: h.asOf,
            horizon: 'quarter',
            notes: 'conformance baseline',
          }),
          'execute',
        );
        const run = present(
          expectOk(await h.store.getRun(h.scopeA, result.run.id), 'getRun'),
          'the persisted run',
        );
        assert.equal(
          run.context.effectiveAsOf,
          h.asOf.toISOString(),
          'the business time it modelled',
        );
        assert.ok(run.context.recordedThrough, 'and the knowledge cutoff it was bounded by');
        assert.equal(run.context.horizon, 'quarter');
        assert.equal(run.context.preference, 'SOURCE_TRUTH', 'a baseline run reads what the business says');
        assert.equal(run.context.scenarioEntityId, null, 'a baseline run names no scenario');
        assert.ok(run.context.engineVersion, 'and the engine version that produced it');
        assert.equal(run.notes, 'conformance baseline');
        assert.ok(run.completedAt, 'a finished run is closed');
        assert.ok(['COMPLETED', 'PARTIAL'].includes(run.status));
      } finally {
        await h.cleanup?.();
      }
    });

    test('a run stores its period and replay scope exactly, and replay restores them', async () => {
      const h = await harness.create();
      try {
        const q4 = quarterPeriod(2026, 4);
        const res = expectOk(
          await h.engine.execute(h.scopeA, {
            fromMetricKeys: ['AverageSellingPrice'],
            effectiveAsOf: h.asOf,
            period: q4,
            notes: 'conformance period',
          }),
          'period run',
        );
        const stored = present(expectOk(await h.store.getRun(h.scopeA, res.run.id), 'getRun'), 'run');
        assert.equal(stored.context.period?.start, q4.start, 'the period start round-trips');
        assert.equal(stored.context.period?.end, q4.end, 'the period end round-trips');
        assert.equal(stored.context.period?.grain, 'QUARTER');
        assert.deepEqual([...stored.context.rootMetricKeys], ['AverageSellingPrice'], 'the replay scope');
        assert.equal(stored.context.scenarioRevisionId, null, 'a baseline run executes no revision');
        const replay = expectOk(await h.engine.replay(h.scopeA, res.run.id), 'replay');
        assert.equal(replay.run.context.period?.start, q4.start, 'replay restores the period');
        assert.deepEqual([...replay.run.context.rootMetricKeys], ['AverageSellingPrice'], 'and the scope');
        assert.equal(replay.steps.length, res.steps.length, 'so it re-plans exactly the same steps');
      } finally {
        await h.cleanup?.();
      }
    });

    test('runs list newest first', async () => {
      const h = await harness.create();
      try {
        const first = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'first',
        );
        const second = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'second',
        );
        const runs = expectOk(await h.store.listRuns(h.scopeA, 10), 'listRuns');
        assert.ok(runs.length >= 2);
        assert.equal(runs[0].id, second.run.id, 'the most recent run is first');
        assert.ok(runs.some((r) => r.id === first.run.id));
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------- traces

    test('every step in the trace is complete enough to audit', async () => {
      const h = await harness.create();
      try {
        const result = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const steps = expectOk(await h.store.getSteps(h.scopeA, result.run.id), 'getSteps');
        assert.ok(steps.length > 0, 'the run left a trace');

        // Dense and ascending: a gap would mean a step was lost, and a trace
        // with a hole in it cannot be trusted to be the whole derivation.
        steps.forEach((s, i) =>
          assert.equal(s.sequence, steps[0].sequence + i, 'sequence is dense and ordered'),
        );

        for (const step of steps) {
          assert.ok(step.calculationKey, 'names its calculation');
          assert.ok(/^\d+\.\d+\.\d+$/.test(step.calculationVersion), 'and its exact version');
          assert.ok(step.outputNodeId, 'and the value position it wrote to');
          assert.ok(step.outputMetricKey, 'and the metric that position carries');
          if (step.status === 'CALCULATED') {
            assert.ok(step.outputValue, 'the exact value');
            assert.ok(step.outputObservationId, 'the observation it created');
            assert.ok(step.renderedExpression, 'the formula with real numbers');
            assert.ok(step.inputFingerprint, 'and a fingerprint of its inputs');
            assert.ok(step.inputs.length > 0);
            for (const input of step.inputs) {
              assert.ok(input.observationId, 'each input names its exact observation');
              assert.ok(input.value, 'and its exact value');
              assert.ok(input.sourceSystem, 'and where it came from');
            }
          }
          if (step.status === 'BLOCKED' || step.status === 'FAILED') {
            assert.ok(step.errorCode, 'a step that did not run says why');
            assert.ok(
              (step.errorMessage ?? '').length >= 20,
              'and says it in terms a manager can act on',
            );
          }
        }
      } finally {
        await h.cleanup?.();
      }
    });

    test('a recorded step is never rewritten — a second run appends', async () => {
      const h = await harness.create();
      try {
        const first = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'first',
        );
        const firstSteps = expectOk(await h.store.getSteps(h.scopeA, first.run.id), 'first steps');
        const second = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'second',
        );
        assert.notEqual(second.run.id, first.run.id, 'a new run, not an edit of the old one');

        const firstAgain = expectOk(
          await h.store.getSteps(h.scopeA, first.run.id),
          'first steps again',
        );
        assert.deepEqual(
          firstAgain.map((s) => [s.id, s.status, s.outputValue]),
          firstSteps.map((s) => [s.id, s.status, s.outputValue]),
          'the original trace is byte-for-byte what it was',
        );
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------------ lineage

    test('an observation resolves to the one step that produced it', async () => {
      const h = await harness.create();
      try {
        expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const obs = present(
          expectOk(
            await h.valueGraph.getLatestObservation(h.scopeA, {
              nodeId: h.nodeIds.expRevenue,
              type: 'DERIVED',
            }),
            'derived revenue',
          ),
          'a derived expected-revenue observation',
        );
        const step = present(
          expectOk(
            await h.store.findStepByOutputObservation(h.scopeA, present(obs, 'observation').id),
            'findStepByOutputObservation',
          ),
          'the step that produced it',
        );
        assert.equal(step.calculationKey, 'expected_revenue');
        assert.equal(step.outputObservationId, obs.id);
        assert.equal(step.outputValue, '2940000000');
      } finally {
        await h.cleanup?.();
      }
    });

    test('explain() reaches source facts through the store', async () => {
      const h = await harness.create();
      try {
        expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const obs = present(
          expectOk(
            await h.valueGraph.getLatestObservation(h.scopeA, {
              nodeId: h.nodeIds.expRevenue,
              type: 'DERIVED',
            }),
            'derived revenue',
          ),
          'a derived expected-revenue observation',
        );
        const explanation = expectOk(await h.engine.explain(h.scopeA, obs.id), 'explain');
        assert.equal(explanation.value, '2940000000');
        assert.ok(explanation.derivation, 'it was derived, not stated');
        assert.equal(explanation.derivation?.calculationKey, 'expected_revenue');
        assert.equal(explanation.inputs.length, 2, 'both inputs explained');
        for (const input of explanation.inputs) {
          assert.equal(input.derivation, null, 'the opportunity facts are stated, not derived');
          assert.ok(input.source?.system, 'and each says which system asserted it');
        }
      } finally {
        await h.cleanup?.();
      }
    });

    test('the latest step for a node drives freshness', async () => {
      const h = await harness.create();
      try {
        expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const step = present(
          expectOk(
            await h.store.findLatestStepForNode(h.scopeA, h.nodeIds.expRevenue),
            'findLatestStepForNode',
          ),
          'the latest step for the node',
        );
        assert.ok(['CALCULATED', 'UNCHANGED'].includes(step.status), 'and it is one that ran');

        const freshness = expectOk(
          await h.engine.checkFreshness(h.scopeA, [h.nodeIds.expRevenue], { asOf: h.asOf }),
          'checkFreshness',
        );
        assert.equal(freshness[0].state, 'CLEAN', 'nothing has changed yet');
        assert.equal(
          freshness[0].recordedFingerprint,
          freshness[0].currentFingerprint,
          'the fingerprint the store holds matches the one re-derived now',
        );
      } finally {
        await h.cleanup?.();
      }
    });

    // ------------------------------------------------- reproducibility

    test('replaying a run reproduces its fingerprints exactly', async () => {
      const h = await harness.create();
      try {
        const first = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'first',
        );
        const replayed = expectOk(await h.engine.replay(h.scopeA, first.run.id), 'replay');
        assert.equal(replayed.run.triggerType, 'REPLAY');
        assert.equal(
          replayed.run.replayOfRunId ?? first.run.id,
          first.run.id,
          'the replay points at what it replayed',
        );

        const original = expectOk(await h.store.getSteps(h.scopeA, first.run.id), 'original trace');
        const again = expectOk(await h.store.getSteps(h.scopeA, replayed.run.id), 'replay trace');
        assert.deepEqual(
          again.filter((s) => s.inputFingerprint).map((s) => s.inputFingerprint),
          original.filter((s) => s.inputFingerprint).map((s) => s.inputFingerprint),
          'identical inputs, identical fingerprints',
        );
      } finally {
        await h.cleanup?.();
      }
    });

    // --------------------------------------------------- provenance

    test('a derived observation carries provenance naming the calculation', async () => {
      const h = await harness.create();
      try {
        expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const obs = present(
          expectOk(
            await h.valueGraph.getLatestObservation(h.scopeA, {
              nodeId: h.nodeIds.expRevenue,
              type: 'DERIVED',
            }),
            'derived revenue',
          ),
          'a derived expected-revenue observation',
        );
        assert.ok(obs.provenanceId, 'the observation points at its provenance');

        // Asked the natural way — "where did this number come from?" — and it
        // answers, even though a derived value's provenance is subject-keyed to
        // the run rather than to the observation.
        const records = expectOk(
          await h.valueGraph.getObservationProvenance(h.scopeA, obs.id),
          'provenance',
        );
        assert.ok(records.length > 0, 'and that provenance is retrievable');
        const record = records[0];
        assert.equal(record.subjectKind, 'calculation_run', 'it names the run that produced it');
        assert.equal(record.method, 'calculated', 'it says the value was calculated');
        assert.equal(record.system, 'helm', 'by HELM, not by a source system');
        assert.ok(record.sourceObjectId?.includes('expected_revenue@'), 'and by which calculation');
        assert.ok(record.transformation, 'and records the formula');
      } finally {
        await h.cleanup?.();
      }
    });

    // ----------------------------------------------- tenant isolation

    test('another organization sees none of these runs or steps', async () => {
      const h = await harness.create();
      try {
        const result = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        assert.equal(expectOk(await h.store.getRun(h.scopeB, result.run.id), 'cross-org run'), null);
        assert.equal(
          expectOk(await h.store.getSteps(h.scopeB, result.run.id), 'cross-org steps').length,
          0,
        );
        assert.equal(expectOk(await h.store.listRuns(h.scopeB, 50), 'cross-org list').length, 0);

        const obs = present(
          expectOk(
            await h.valueGraph.getLatestObservation(h.scopeA, {
              nodeId: h.nodeIds.expRevenue,
              type: 'DERIVED',
            }),
            'derived revenue',
          ),
          'a derived expected-revenue observation',
        );
        assert.equal(
          expectOk(
            await h.store.findStepByOutputObservation(h.scopeB, obs.id),
            'cross-org lineage',
          ),
          null,
          'and cannot walk lineage into another tenant',
        );
      } finally {
        await h.cleanup?.();
      }
    });

    test('a completed run cannot be closed from another organization', async () => {
      const h = await harness.create();
      try {
        const result = expectOk(
          await h.engine.execute(h.scopeA, { fromMetricKeys: ROOTS, asOf: h.asOf, horizon: 'quarter' }),
          'execute',
        );
        const r = await h.store.completeRun(h.scopeB, result.run.id, 'FAILED', 'tampering');
        assert.equal(r.ok, false, 'a cross-tenant write is refused');

        const untouched = expectOk(await h.store.getRun(h.scopeA, result.run.id), 'run');
        assert.notEqual(untouched?.status, 'FAILED', 'and the run is unchanged');
      } finally {
        await h.cleanup?.();
      }
    });
  });
}
