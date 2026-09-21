/**
 * Truth layers and numerical precision — the Phase 3 hardening proofs.
 *
 *   BUSINESS / SOURCE TRUTH   what a business system or authorized person said
 *   MODEL TRUTH               what a HELM model computed (DERIVED)
 *   EXECUTION STATE           values bound to a run while it executes
 *
 * And the precision model that sits under all three: arithmetic carried at full
 * internal scale, business values written down at the precision the metric and
 * currency actually have, and the raw computation kept in the trace.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import {
  asOrgId,
  asUserId,
  asValidTime,
  decimal,
  policyFor,
  seqIdGen,
  toString as decToString,
} from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  createInMemoryValueGraph,
  buildSeedValueRegistry,
  buildCanonicalValueChain,
} from '@helm/value-graph';
import {
  canonicalNumeric,
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  inputFingerprint,
  meridianValueModelV1,
  policyOrder,
} from '../src/index.ts';

const scope = {
  orgId: asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};
const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];
const Q4_START = '2026-10-01T00:00:00.000Z';
const Q4_END = '2027-01-01T00:00:00.000Z';

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

async function buildStack() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('t');
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
  const registry = unwrap(
    createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry()),
    'registry',
  );
  const store = createInMemoryCalculationStore({ clock, idGen });
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
    'engine',
  );
  return { engine, valueGraph, graphStore, store, clock, ids: chain.nodeIds };
}

// ============================================================= truth layers

describe('business truth and model truth coexist and are never conflated', () => {
  test('no source policy can select a DERIVED observation', () => {
    // The structural guarantee behind everything below. A historical model
    // result must not become authoritative merely by being of type DERIVED.
    for (const policy of ['SOURCE_TRUTH', 'ACTUALS_FIRST', 'SCENARIO', 'ASSUMPTION_ONLY']) {
      assert.ok(
        !policyOrder[policy].includes('DERIVED'),
        `${policy} must not rank model output as business truth`,
      );
    }
    assert.deepEqual([...policyOrder.MODEL_OUTPUT], ['DERIVED'], 'model truth is asked for by name');
  });

  test('FORECAST 5.00B, MODEL 4.70B, VARIANCE -0.30B — and Finance still says 5.00B', async () => {
    const { engine, valueGraph, ids } = await buildStack();

    // Finance files its official Q4 revenue forecast for the Rohto tender.
    const financeForecast = unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.expRevenue,
        observationType: 'FORECAST',
        numericValue: 5_000_000_000,
        unitType: 'currency',
        currency: 'VND',
        periodStart: asValidTime(Q4_START),
        periodEnd: asValidTime(Q4_END),
        observedAt: asValidTime('2026-09-19T09:00:00.000Z'),
        sourceSystem: 'finance',
        confidence: 0.9,
      }),
      'finance forecast',
    );

    // The commercial facts HELM's model runs on imply something else:
    // 5.875B at 80% is 4.70B.
    for (const [nodeId, value, unit, currency] of [
      [ids.oppValue, 5_875_000_000, 'currency', 'VND'],
      [ids.oppProb, 0.8, 'ratio', null],
    ]) {
      unwrap(
        await valueGraph.recordObservation(scope, {
          nodeId,
          observationType: 'ACTUAL',
          numericValue: value,
          unitType: unit,
          currency,
          effectiveAt: asValidTime('2026-09-19T09:30:00.000Z'),
          observedAt: asValidTime('2026-09-19T09:30:00.000Z'),
          sourceSystem: 'memoire',
          confidence: 0.9,
        }),
        'commercial fact',
      );
    }

    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'model run',
    );

    // --- both layers, side by side, with the gap between them ---
    const layers = unwrap(await engine.truthLayers(scope, ids.expRevenue), 'truth layers');
    assert.equal(layers.source.value, '5000000000', 'FORECAST  5.00B');
    assert.equal(layers.source.observation.id, financeForecast.id, 'and it is Finance\'s');
    assert.equal(layers.source.observation.sourceSystem, 'finance');
    assert.equal(layers.model.value, '4700000000', 'MODEL     4.70B');
    assert.equal(layers.model.calculation, 'expected_revenue@1.0.0');
    assert.equal(layers.variance, '-300000000', 'VARIANCE -0.30B');
    assert.equal(layers.currency, 'VND');

    // --- the executable chain used the MODEL, because it is an execution
    //     dependency: demand is 4.70B / 350M, not 5.00B / 350M ---
    const demandStep = run.steps.find((s) => s.outputNodeId === ids.demand);
    const revenueInput = demandStep.inputs.find((i) => i.metricKey === 'ExpectedRevenue');
    const revenueStep = run.steps.find((s) => s.outputNodeId === ids.expRevenue);
    assert.equal(revenueInput.boundTo, 'RUN_OUTPUT', 'bound to the execution frame');
    assert.equal(revenueInput.observationId, revenueStep.outputObservationId);
    assert.equal(revenueInput.value, '4700000000');
    assert.equal(demandStep.outputValue, '13.428571', '4.70B / 350M, not Finance\'s 5.00B / 350M');

    // --- and asking "what did Finance forecast?" still says 5.00B. A model
    //     run next to it did not overwrite, outrank or absorb it. ---
    const again = unwrap(
      await engine.truthLayers(scope, ids.expRevenue, { sourcePolicy: 'SOURCE_TRUTH' }),
      'what did finance forecast',
    );
    assert.equal(again.source.value, '5000000000');
    const allForecasts = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.expRevenue, types: ['FORECAST'] }),
      'forecast history',
    );
    assert.ok(
      allForecasts.some((o) => o.id === financeForecast.id && o.numericValue === 5_000_000_000),
      'the forecast is exactly as Finance filed it',
    );
  });

  test('a SOURCE_POLICY_ONLY input reads the forecast even when the model has run', async () => {
    // The other half of the binding distinction: an input that asks for the
    // world gets the world, not the model, whatever the run has computed.
    const { engine, valueGraph, graphStore, ids } = await buildStack();
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.expRevenue,
        observationType: 'FORECAST',
        numericValue: 5_000_000_000,
        unitType: 'currency',
        currency: 'VND',
        periodStart: asValidTime(Q4_START),
        periodEnd: asValidTime(Q4_END),
        sourceSystem: 'finance',
        confidence: 0.9,
      }),
      'finance forecast',
    );

    const readsForecast = {
      key: 'finance_view_of_revenue',
      version: '1.0.0',
      name: 'Finance View of Revenue',
      description: 'Revenue exactly as Finance forecast it, for comparison purposes.',
      rationale:
        'Exists to prove that an input declaring SOURCE_POLICY_ONLY reads business ' +
        'truth even when a model has computed the same metric in the same run.',
      owner: 'Architecture',
      status: 'ACTIVE',
      effectiveFrom: '2026-10-01',
      // Revenue: a metric no Meridian calculation produces, so this is the
      // only producer and there is no question which formula ran.
      outputMetricKey: 'Revenue',
      outputUnit: 'currency',
      scopeCompatibility: null,
      definitionConfidence: 1,
      expression: 'finance_revenue',
      inputs: [
        {
          name: 'finance_revenue',
          metricKey: 'ExpectedRevenue',
          binding: { kind: 'SAME_SUBJECT' },
          resolution: 'SOURCE_POLICY_ONLY',
          required: true,
          expectUnit: 'currency',
          horizon: 'quarter',
          description: 'Expected revenue as the business states it.',
        },
      ],
      compute: (_ctx, inputs) => ({ ok: true, value: inputs.finance_revenue }),
    };
    const registry = unwrap(
      createCalculationRegistry([...meridianValueModelV1, readsForecast], buildSeedValueRegistry()),
      'registry with finance view',
    );
    const ontology = buildSeedRegistry();
    const store = createInMemoryCalculationStore({
      clock: { now: () => new Date('2026-09-19T11:00:00.000Z') },
      idGen: seqIdGen('fv'),
    });
    const withView = unwrap(
      createPropagationEngine({
        registry,
        valueGraph,
        graphStore,
        ontology,
        store,
        clock: { now: () => new Date('2026-09-19T11:00:00.000Z') },
      }),
      'engine',
    );
    void engine;

    const opp = unwrap(
      await graphStore.findEntities(scope, { canonicalKeys: ['memoire:opportunity:opp-8821'] }),
      'opp',
    )[0];
    const out = unwrap(
      await valueGraph.upsertValueNode(scope, {
        metricKey: 'Revenue',
        subjectEntityId: opp.id,
        timeHorizon: 'quarter',
        label: 'Finance view of revenue',
      }),
      'output node',
    );

    const run = unwrap(
      await withView.execute(scope, {
        fromMetricKeys: [...ROOTS, 'ExpectedRevenue'],
        effectiveAsOf: AS_OF,
        horizon: 'quarter',
      }),
      'run',
    );
    // The model DID compute expected revenue in this run — which is what makes
    // the next assertion meaningful rather than trivially true.
    const modelRevenue = run.steps.find((s) => s.outputNodeId === ids.expRevenue);
    assert.equal(modelRevenue.status, 'CALCULATED');
    assert.equal(modelRevenue.outputValue, '2940000000');
    const step = run.steps.find((s) => s.outputNodeId === out.id);
    assert.ok(step, 'the finance-view step ran');
    assert.equal(step.status, 'CALCULATED');
    const input = step.inputs[0];
    assert.equal(input.boundTo, 'SOURCE_OBSERVATION', 'read from the world');
    assert.equal(input.observationType, 'FORECAST');
    assert.equal(input.value, '5000000000', 'Finance\'s number, not the model\'s 2.94B');
    assert.notEqual(input.observationId, modelRevenue.outputObservationId);
  });

  test('an executable dependency with no planned upstream falls back to persisted model truth', async () => {
    const { engine, ids } = await buildStack();
    unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'full run',
    );
    // Now propagate from UnitCost only: expected revenue is NOT in this plan, so
    // gross margin must find it from a previous run's model output.
    const partial = unwrap(
      await engine.propagateFrom(scope, 'UnitCost', { effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'cost-only run',
    );
    const margin = partial.steps.find((s) => s.outputNodeId === ids.grossMargin);
    const revenue = margin.inputs.find((i) => i.metricKey === 'ExpectedRevenue');
    assert.equal(revenue.boundTo, 'SOURCE_OBSERVATION', 'not planned, so read from persistence');
    assert.equal(revenue.observationType, 'DERIVED', 'as persisted model truth, not the stated forecast');
    assert.equal(revenue.value, '2940000000');
  });
});

// ================================================================ precision

describe('numerical precision is deterministic and business-normalized', () => {
  test('A — 4.2B x 0.7 is exactly 2.94B', async () => {
    const { engine, ids } = await buildStack();
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = run.steps.find((s) => s.outputNodeId === ids.expRevenue);
    assert.equal(step.outputValue, '2940000000');
    assert.equal(step.outputValueRaw, null, 'nothing to normalize: the product is exact');
  });

  test('B — 2.94B / 350M is exactly 8.4 units, with no floating drift', async () => {
    const { engine, ids } = await buildStack();
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const step = run.steps.find((s) => s.outputNodeId === ids.demand);
    assert.equal(step.outputValue, '8.4');
    assert.notEqual(String(0.7 * 12), '8.4', 'the float route to the same quantity is wrong');
  });

  test('C — a fractional quantity into money yields whole VND by metric policy', async () => {
    const { engine, ids } = await buildStack();
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    const wc = run.steps.find((s) => s.outputNodeId === ids.wcProduct);
    // 12.3857142857... units x 217,000,000 VND. The exact answer is 867/70 x
    // 217,000,000 = 2,687,700,000 with remainder zero.
    assert.equal(wc.outputValue, '2687700000');
    assert.ok(wc.outputValueRaw, 'the raw computation is kept');
    assert.ok(
      Math.abs(Number(wc.outputValueRaw) - 2687700000) < 1e-9,
      'and the residue normalization removed is negligible, not concealed',
    );
    assert.equal(policyFor('currency', 'VND').storageScale, 0, 'VND has no minor unit');
    assert.equal(policyFor('currency', 'USD').storageScale, 2, 'USD has two');
  });

  test('D — replay reproduces identical normalized values', async () => {
    const { engine, store, ids } = await buildStack();
    const original = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'original',
    );
    const replayed = unwrap(await engine.replay(scope, original.run.id), 'replay');
    const originalSteps = unwrap(await store.getSteps(scope, original.run.id), 'original trace');
    const replaySteps = unwrap(await store.getSteps(scope, replayed.run.id), 'replay trace');

    const valueOf = (steps) =>
      new Map(steps.filter((s) => s.outputValue).map((s) => [s.outputNodeId, s.outputValue]));
    assert.deepEqual(valueOf(replaySteps), valueOf(originalSteps), 'every business value identical');
    assert.ok(valueOf(originalSteps).size >= 11);
    assert.ok(ids.wcProduct);
  });

  test('E — equivalent decimal spellings give one fingerprint', () => {
    for (const [a, b] of [
      ['0.7', '0.70'],
      ['0.7', '0.700'],
      ['2940000000', '2940000000.000'],
      ['8.4', '8.40000'],
      ['-0', '0'],
      ['+12', '12'],
    ]) {
      assert.equal(canonicalNumeric(a), canonicalNumeric(b), `${a} and ${b} are one number`);
    }

    const fp = (value) =>
      inputFingerprint('expected_revenue@1.0.0', { horizon: 'quarter', scenario: '' }, [
        { name: 'opportunity_value', observationId: 'o1', value: '4200000000', unit: 'currency', currency: 'VND' },
        { name: 'opportunity_probability', observationId: 'o2', value, unit: 'ratio', currency: null },
      ]);
    assert.equal(fp('0.7'), fp('0.70'));
    assert.equal(fp('0.7'), fp('0.700'));
    assert.notEqual(fp('0.7'), fp('0.71'), 'while a different number still changes it');
  });

  test('persisted business values carry no binary floating drift', async () => {
    // numericValue is a JS number at the boundary; exactValue is the decimal
    // string. After normalization they must agree exactly, for every derived
    // observation — otherwise the float column is quietly a different number.
    const { engine } = await buildStack();
    const run = unwrap(
      await engine.execute(scope, { fromMetricKeys: ROOTS, effectiveAsOf: AS_OF, horizon: 'quarter' }),
      'run',
    );
    assert.ok(run.written.length >= 11);
    for (const obs of run.written) {
      const exact = obs.metadata?.exactValue;
      assert.equal(typeof exact, 'string', `${obs.id} carries its exact value`);
      assert.equal(
        decToString(decimal(obs.numericValue)),
        canonicalNumeric(exact),
        `${obs.id}: numeric ${obs.numericValue} and exact ${exact} disagree`,
      );
      if (obs.unitType === 'currency' && obs.currency === 'VND') {
        assert.ok(!exact.includes('.'), `${obs.id}: a VND amount must be whole dong, got ${exact}`);
      }
    }
  });
});
