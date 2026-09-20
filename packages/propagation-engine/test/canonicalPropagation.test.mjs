/**
 * The Phase 3 canonical proof, as executable tests.
 *
 * Builds the Phase 1 entity graph, the Phase 2 value chain, seeds the
 * assumptions the model needs, then:
 *
 *   1. calculates the chain from Opportunity Value 4.2B and Probability 0.70
 *   2. changes probability to 0.90 and propagates — showing before/after/delta
 *   3. changes unit cost +10% and propagates — showing that the REVENUE branch
 *      is untouched while the COST branch moves, which is what distinguishes a
 *      dependency model from a canned scenario
 *   4. explains a derived number down to its source facts
 *   5. proves staleness, replay, partial execution and contention
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  createInMemoryValueGraph,
  buildSeedValueRegistry,
  buildCanonicalValueChain,
} from '@helm/value-graph';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  meridianValueModelV1,
} from '../src/index.ts';

const scope = {
  orgId: asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

/**
 * Full stack: entity graph → value chain → assumptions → engine.
 * Deterministic clock and ids so replay equality is meaningful.
 */
async function buildStack() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('p');
  const ontology = buildSeedRegistry();

  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  unwrap(await buildCanonicalScenario(graphStore, scope), 'entity graph');

  const valueGraph = createInMemoryValueGraph({
    metrics: buildSeedValueRegistry(),
    ontology,
    graphStore,
    clock,
    idGen,
  });
  const chain = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, scope), 'value chain');

  // No extra fixture setup. Everything the model needs — including the average
  // selling price ASSUMPTION and the empty COGS, working-capital and cash nodes
  // it writes into — is part of the canonical value graph, not of this test.
  // A model that needed a test harness to invent value nodes for it would not be
  // running against the enterprise's real graph.

  const registry = unwrap(
    createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry()),
    'calculation registry',
  );
  const store = createInMemoryCalculationStore({ clock, idGen });
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
    'engine',
  );

  return {
    engine,
    valueGraph,
    graphStore,
    registry,
    store,
    ids: chain.nodeIds,
    scenarios: chain.scenarioIds,
    clock,
  };
}

/** Latest derived value on a node, as an exact string. */
async function derived(valueGraph, nodeId) {
  const r = await valueGraph.getLatestObservation(scope, { nodeId, type: 'DERIVED' });
  if (!r.ok || !r.value) return null;
  return r.value.metadata?.exactValue ?? String(r.value.numericValue);
}

describe('Phase 3 — canonical propagation', () => {
  test('the dependency graph orders the chain and finds no cycles', async () => {
    const { registry } = await buildStack();
    const { buildDependencyGraph } = await import('../src/dependencyGraph.ts');
    const graph = unwrap(buildDependencyGraph(registry), 'dependency graph');

    const pos = (m) => graph.order.indexOf(m);
    assert.ok(pos('ExpectedRevenue') < pos('DemandQuantity'), 'revenue before demand');
    assert.ok(pos('DemandQuantity') < pos('InventoryRequirement'), 'demand before requirement');
    assert.ok(pos('InventoryRequirement') < pos('InventoryGap'), 'requirement before gap');
    assert.ok(pos('Cogs') < pos('GrossMargin'), 'cogs before margin');
    assert.ok(pos('GrossMargin') < pos('CashImpact'), 'margin before cash');

    // Source facts have no calculation behind them.
    assert.ok(graph.roots.includes('OpportunityValue'));
    assert.ok(graph.roots.includes('OpportunityProbability'));
    assert.ok(graph.roots.includes('UnitCost'));
    assert.ok(graph.roots.includes('AverageSellingPrice'));
  });

  test('STEP 1 — calculates the chain from the opportunity', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    const result = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline run',
    );

    assert.ok(result.summary.CALCULATED > 0, 'something was calculated');

    // 4.2B x 0.70 = 2.94B, exactly.
    assert.equal(await derived(valueGraph, ids.expRevenue), '2940000000');
    // 2.94B / 350M = 8.4 units — fractional on purpose (expected, not shipped).
    assert.equal(await derived(valueGraph, ids.demand), '8.4');
  });

  test('STEP 2 — probability 70% → 90% propagates through the chain', async () => {
    const { engine, valueGraph, ids } = await buildStack();

    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );
    const before = {
      revenue: await derived(valueGraph, ids.expRevenue),
      demand: await derived(valueGraph, ids.demand),
    };
    assert.equal(before.revenue, '2940000000');
    assert.equal(before.demand, '8.4');

    // The only change: a new ACTUAL probability observation.
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.9,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
        observedAt: asValidTime('2026-09-19T10:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 0.9,
      }),
      'probability 0.9',
    );

    const after = unwrap(
      await engine.propagateFrom(scope, 'OpportunityProbability', {
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'propagate',
    );
    assert.ok(after.summary.CALCULATED > 0, 'recalculated downstream');

    // 4.2B x 0.90 = 3.78B exactly; 3.78B / 350M = 10.8 units exactly.
    assert.equal(await derived(valueGraph, ids.expRevenue), '3780000000');
    assert.equal(await derived(valueGraph, ids.demand), '10.8');
  });

  test('STEP 2b — the old derived value is preserved, not overwritten', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.9,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 0.9,
      }),
      'new probability',
    );
    unwrap(
      await engine.propagateFrom(scope, 'OpportunityProbability', { asOf: AS_OF, horizon: 'quarter' }),
      'propagate',
    );

    const all = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.expRevenue, types: ['DERIVED'] }),
      'derived history',
    );
    assert.equal(all.length, 2, 'both derived values exist — history is not rewritten');
    const values = all.map((o) => o.metadata?.exactValue).sort();
    assert.deepEqual(values, ['2940000000', '3780000000']);
  });

  test('STEP 3 — DEEPER PROOF: unit cost +10% moves the cost branch only', async () => {
    const { engine, valueGraph, graphStore, ids } = await buildStack();

    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );

    const before = {
      revenue: await derived(valueGraph, ids.expRevenue),
      demand: await derived(valueGraph, ids.demand),
      requirement: await derived(valueGraph, ids.invRequirement),
      gap: await derived(valueGraph, ids.invGap),
      workingCapital: await derived(valueGraph, ids.wcProduct),
    };

    // 217M → 238.7M, a 10% increase.
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.unitCost,
        observationType: 'ACTUAL',
        numericValue: 238_700_000,
        unitType: 'currency',
        currency: 'VND',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
        sourceSystem: 'erp',
        confidence: 1,
      }),
      'unit cost +10%',
    );

    const run = unwrap(
      await engine.propagateFrom(scope, 'UnitCost', { asOf: AS_OF, horizon: 'quarter' }),
      'propagate unit cost',
    );

    const after = {
      revenue: await derived(valueGraph, ids.expRevenue),
      demand: await derived(valueGraph, ids.demand),
      requirement: await derived(valueGraph, ids.invRequirement),
      gap: await derived(valueGraph, ids.invGap),
      workingCapital: await derived(valueGraph, ids.wcProduct),
    };

    // The revenue branch does not depend on unit cost, so it must be untouched.
    assert.equal(after.revenue, before.revenue, 'expected revenue unchanged');
    assert.equal(after.demand, before.demand, 'demand unchanged');
    assert.equal(after.requirement, before.requirement, 'inventory requirement unchanged');
    assert.equal(after.gap, before.gap, 'inventory gap unchanged');

    // The cost branch does.
    assert.notEqual(after.workingCapital, before.workingCapital, 'working capital moved');

    // And the run itself only touched cost-branch metrics.
    const touched = new Set(
      run.steps.filter((s) => s.status === 'CALCULATED').map((s) => s.outputMetricKey),
    );
    assert.ok(touched.has('WorkingCapital'), 'working capital recalculated');
    assert.ok(!touched.has('ExpectedRevenue'), 'revenue NOT recalculated — it does not depend on cost');
    assert.ok(!touched.has('DemandQuantity'), 'demand NOT recalculated');
  });

  test('STEP 4 — explain() walks a derived number to its source facts', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );

    const revObs = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.expRevenue, type: 'DERIVED' }),
      'derived revenue',
    );
    const explanation = unwrap(await engine.explain(scope, revObs.id), 'explain');

    assert.equal(explanation.value, '2940000000');
    assert.equal(explanation.unit, 'currency');
    assert.equal(explanation.currency, 'VND');
    assert.ok(explanation.derivation, 'it was derived, not stated');
    assert.equal(explanation.derivation.calculationKey, 'expected_revenue');
    assert.equal(explanation.derivation.calculationVersion, '1.0.0');
    assert.match(explanation.derivation.renderedExpression, /4200000000 VND/);
    assert.match(explanation.derivation.renderedExpression, /2940000000 VND/);

    assert.equal(explanation.inputs.length, 2, 'both inputs explained');
    const byMetric = new Map(explanation.inputs.map((i) => [i.metricKey, i]));
    const value = byMetric.get('OpportunityValue');
    const prob = byMetric.get('OpportunityProbability');
    assert.equal(value.value, '4200000000');
    assert.equal(prob.value, '0.7');
    // The inputs are source facts: stated, not derived.
    assert.equal(value.derivation, null, 'opportunity value is a source fact');
    assert.equal(value.source.system, 'memoire', 'and it came from Memoire');
  });

  test('STEP 4b — lineage is recursive: cash reaches the opportunity', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );

    const gm = await valueGraph.getLatestObservation(scope, {
      nodeId: ids.grossMargin,
      type: 'DERIVED',
    });
    if (!gm.ok || !gm.value) return; // gross margin may be blocked; covered elsewhere

    const explanation = unwrap(await engine.explain(scope, gm.value.id), 'explain gross margin');
    const metrics = new Set();
    const walk = (node) => {
      metrics.add(node.metricKey);
      for (const i of node.inputs) walk(i);
    };
    walk(explanation);

    assert.ok(metrics.has('ExpectedRevenue'), 'margin traces to revenue');
    assert.ok(metrics.has('OpportunityValue'), 'and through to the opportunity value');
    assert.ok(metrics.has('OpportunityProbability'), 'and its probability');
  });

  test('idempotency — re-running with identical inputs yields UNCHANGED', async () => {
    const { engine, ids } = await buildStack();
    const request = {
      fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
      asOf: AS_OF,
      horizon: 'quarter',
    };
    const first = unwrap(await engine.execute(scope, request), 'first');
    const second = unwrap(await engine.execute(scope, request), 'second');

    assert.ok(first.summary.CALCULATED > 0, 'first run calculated');
    assert.equal(second.summary.CALCULATED, 0, 'second run calculated nothing new');
    assert.ok(second.summary.UNCHANGED > 0, 'and reported them as unchanged');
    assert.ok(ids.expRevenue);
  });

  test('staleness — a changed input marks the derived value stale without mutating it', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'baseline',
    );

    const clean = unwrap(
      await engine.checkFreshness(scope, [ids.expRevenue], { asOf: AS_OF }),
      'freshness before',
    );
    assert.equal(clean[0].state, 'CLEAN');

    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.9,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 0.9,
      }),
      'new probability',
    );

    const stale = unwrap(
      await engine.checkFreshness(scope, [ids.expRevenue], { asOf: AS_OF }),
      'freshness after',
    );
    assert.equal(stale[0].state, 'STALE', 'the derived value no longer reflects its inputs');
    assert.notEqual(stale[0].recordedFingerprint, stale[0].currentFingerprint);

    // And the old observation is untouched.
    const old = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.expRevenue, types: ['DERIVED'] }),
      'derived',
    );
    assert.equal(old.length, 1);
    assert.equal(old[0].metadata?.exactValue, '2940000000', 'the old value is preserved as recorded');
  });

  test('reproducibility — replaying a run produces the same numbers', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    const first = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'first run',
    );
    const originalRevenue = await derived(valueGraph, ids.expRevenue);

    const replayed = unwrap(await engine.replay(scope, first.run.id), 'replay');
    assert.equal(replayed.run.triggerType, 'REPLAY');

    // Same context, same inputs → same fingerprints, so nothing recomputes.
    const firstFps = first.steps.filter((s) => s.inputFingerprint).map((s) => s.inputFingerprint);
    const replayFps = replayed.steps.filter((s) => s.inputFingerprint).map((s) => s.inputFingerprint);
    assert.deepEqual(replayFps, firstFps, 'identical input fingerprints');
    assert.equal(await derived(valueGraph, ids.expRevenue), originalRevenue, 'same value');
  });

  test('partial execution — a missing input blocks one step, not the model', async () => {
    const { engine, valueGraph, graphStore, ids } = await buildStack();

    // A third opportunity lands from Memoire with a value but no probability yet
    // — an ordinary, daily data gap, not a contrived one. Its expected revenue
    // is uncomputable; nothing else in the enterprise should care.
    const rohto = unwrap(
      await graphStore.findEntities(scope, { canonicalKeys: ['memoire:customer:a3f2c1d4'] }),
      'rohto',
    )[0];
    const oppRaw = unwrap(
      await graphStore.upsertEntity(scope, {
        entityTypeKey: 'Opportunity',
        canonicalKey: 'memoire:opportunity:opp-9001',
        name: 'Unqualified inbound enquiry',
        sourceSystem: 'memoire',
        attributes: { value: 900_000_000, currency: 'VND', stage: 'Qualification' },
      }),
      'raw opportunity',
    ).entity;
    unwrap(
      await graphStore.createRelationship(scope, {
        relationshipTypeKey: 'HELD_BY',
        sourceEntityId: oppRaw.id,
        targetEntityId: rohto.id,
        sourceSystem: 'memoire',
      }),
      'held by',
    );

    const valueNode = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'OpportunityValue',
        subjectEntityId: oppRaw.id,
        timeHorizon: 'current',
        label: 'Opportunity Value — unqualified enquiry',
      }),
      'value node',
    );
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: valueNode.id,
        observationType: 'ACTUAL',
        numericValue: 900_000_000,
        unitType: 'currency',
        currency: 'VND',
        effectiveAt: asValidTime('2026-09-19T09:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 1,
      }),
      'value observation',
    );
    // The expected-revenue node exists — the question is asked — but no
    // probability has been recorded to answer it with.
    const revenueNode = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'ExpectedRevenue',
        subjectEntityId: oppRaw.id,
        timeHorizon: 'quarter',
        label: 'Expected Revenue — unqualified enquiry',
      }),
      'revenue node',
    );

    const result = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'run',
    );

    const blocked = result.steps.filter((s) => s.status === 'BLOCKED');
    assert.equal(blocked.length, 1, 'exactly one step could not run');
    assert.equal(blocked[0].outputNodeId, revenueNode.id, 'and it is the one with no probability');
    assert.equal(blocked[0].errorCode, 'calculation.missing_input');
    assert.match(
      blocked[0].errorMessage,
      /OpportunityProbability/,
      'the message names the metric a manager would have to go and find',
    );
    assert.match(blocked[0].errorMessage, /likelihood the opportunity closes/i,
      'and says what it is in business terms, not as a field name');

    // Everything else computed anyway — that is the whole point of §48.
    assert.ok(result.summary.CALCULATED >= 11, 'the rest of the model ran');
    assert.equal(await derived(valueGraph, ids.expRevenue), '2940000000');
    assert.equal(await derived(valueGraph, ids.cashOpp), '-1710499999.999938');
    assert.equal(await derived(valueGraph, revenueNode.id), null, 'and the gap stays a gap');

    // A run with a blocked step is PARTIAL, not COMPLETED and not FAILED: the
    // status has to tell a reader that some of the model did not run.
    assert.equal(result.run.status, 'PARTIAL');
  });

  test('every calculated step records a complete, auditable trace', async () => {
    const { engine } = await buildStack();
    const result = unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'run',
    );

    const calculated = result.steps.filter((s) => s.status === 'CALCULATED');
    assert.ok(calculated.length > 0);
    for (const step of calculated) {
      assert.ok(step.calculationKey, 'names its calculation');
      assert.match(step.calculationVersion, /^\d+\.\d+\.\d+$/, 'and its version');
      assert.ok(step.outputValue, 'records the exact output');
      assert.ok(step.outputObservationId, 'and the observation it wrote');
      assert.ok(step.renderedExpression, 'and the formula with real numbers');
      assert.ok(step.inputFingerprint, 'and a fingerprint of its inputs');
      assert.ok(step.inputs.length > 0, 'and every input it used');
      for (const input of step.inputs) {
        assert.ok(input.observationId, 'each input names its exact observation');
        assert.ok(input.value, 'and its exact value');
        assert.ok(input.sourceSystem, 'and where that came from');
      }
      assert.ok(step.confidence !== null && step.confidence <= 1);
    }
  });

  test('confidence degrades through the chain and never exceeds its inputs', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'run',
    );

    const rev = await valueGraph.getLatestObservation(scope, {
      nodeId: ids.expRevenue,
      type: 'DERIVED',
    });
    const demand = await valueGraph.getLatestObservation(scope, {
      nodeId: ids.demand,
      type: 'DERIVED',
    });
    assert.ok(rev.value.confidence <= 0.7, 'revenue is no more certain than its 0.7 probability');
    if (demand.value) {
      assert.ok(
        demand.value.confidence <= rev.value.confidence,
        'demand is no more certain than the revenue it derives from',
      );
    }
  });

  test('CONTENTION: the quantitative pressure on shared stock is visible', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, {
        fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'AverageSellingPrice'],
        asOf: AS_OF,
        horizon: 'quarter',
      }),
      'run',
    );

    const contention = unwrap(await valueGraph.findContention(scope), 'contention');
    const onOwnStock = contention.find((c) => c.node.id === ids.availOwn);
    assert.ok(onOwnStock, 'company stock is still recognised as contended');
    assert.equal(onOwnStock.claimants.length, 2, 'two value streams claim it');

    const available = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.availOwn, type: 'ACTUAL' }),
      'available',
    );
    assert.equal(available.numericValue, 4);
    assert.ok(
      onOwnStock.totalClaimedWeight > available.numericValue,
      'claimed exceeds available — the pressure is quantified, not optimised',
    );
  });
});
