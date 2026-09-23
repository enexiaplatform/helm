/**
 * Period identity in the propagation engine (ADR-0020).
 *
 * The Phase 3 debt this closes: a value node carrying forecasts for several
 * future periods answered every read with whichever period started LAST. A
 * question about 2026-Q4 got 2027-Q1's number, silently.
 *
 * Now a run states the period it models; a period claim answers only if it is
 * about exactly that period; a point-in-time input carries forward only
 * because it declared the `current` horizon; and a read that names no period
 * refuses to choose between periods rather than guessing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import {
  asOrgId,
  asUserId,
  asValidTime,
  periodKey,
  quarterPeriod,
  seqIdGen,
} from '@helm/shared';
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
  policyOrder,
  selectObservation,
} from '../src/index.ts';

const scope = {
  orgId: asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};
const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const Q4 = quarterPeriod(2026, 4);
const Q1 = quarterPeriod(2027, 1);

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

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
  const registry = unwrap(
    createCalculationRegistry(meridianValueModelV1, buildSeedValueRegistry()),
    'registry',
  );
  const store = createInMemoryCalculationStore({ clock, idGen });
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
    'engine',
  );
  return { engine, valueGraph, store, clock, ids: chain.nodeIds };
}

/** Finance files a 2027-Q1 revenue forecast next to the canonical Q4 one. */
async function addQ1Forecast(valueGraph, ids, value = 3_500_000_000) {
  return unwrap(
    await valueGraph.recordObservation(scope, {
      nodeId: ids.expRevenue,
      observationType: 'FORECAST',
      numericValue: value,
      unitType: 'currency',
      currency: 'VND',
      periodStart: asValidTime(Q1.start),
      periodEnd: asValidTime(Q1.end),
      sourceSystem: 'finance',
      confidence: 0.6,
    }),
    'Q1 forecast',
  );
}

const lens = (clock) => ({ effectiveAsOf: AS_OF, recordedThrough: clock.now() });

describe('period identity: a claim about one period answers only that period', () => {
  test('Q4 read gets Q4, Q1 read gets Q1 — never the furthest-out forecast', async () => {
    const { valueGraph, clock, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const order = policyOrder.SOURCE_TRUTH;

    const q4 = unwrap(
      await selectObservation(valueGraph, scope, ids.expRevenue, order, lens(clock), null, Q4),
      'Q4 read',
    );
    const q1 = unwrap(
      await selectObservation(valueGraph, scope, ids.expRevenue, order, lens(clock), null, Q1),
      'Q1 read',
    );
    assert.equal(q4.numericValue, 2_940_000_000, 'the Q4 question is answered by the Q4 forecast');
    assert.equal(q1.numericValue, 3_500_000_000, 'the Q1 question is answered by the Q1 forecast');
  });

  test('NEGATIVE: the old rule would have answered a Q4 question with the Q1 forecast', async () => {
    // The pre-Phase-4 rule, reproduced: among forecasts, the latest period start wins.
    const { valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const all = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.expRevenue, types: ['FORECAST'], scenarioEntityId: null }),
      'forecasts',
    );
    const furthestOut = [...all].sort(
      (a, b) => Date.parse(b.periodStart) - Date.parse(a.periodStart),
    )[0];
    assert.equal(furthestOut.numericValue, 3_500_000_000, 'the old rule picks Q1 for every question');
    // ...which the engine no longer does for a Q4 question:
    const { engine } = await buildStack();
    void engine;
  });

  test('a read that names no period refuses to choose between periods', async () => {
    const { valueGraph, clock, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const r = await selectObservation(
      valueGraph, scope, ids.expRevenue, policyOrder.SOURCE_TRUTH, lens(clock), null, null,
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'calculation.ambiguous_period');
    assert.deepEqual(r.error.details.periods.sort(), ['2026-Q4', '2027-Q1']);
  });

  test('a single-period node still reads without a stated period (no regression)', async () => {
    const { valueGraph, clock, ids } = await buildStack();
    const r = unwrap(
      await selectObservation(
        valueGraph, scope, ids.expRevenue, policyOrder.SOURCE_TRUTH, lens(clock), null, null,
      ),
      'single period',
    );
    assert.equal(r.numericValue, 2_940_000_000);
  });

  test('only wrong-period claims is a TIME_CONTEXT_MISMATCH, not a missing input', async () => {
    const { valueGraph, clock, ids } = await buildStack();
    // The tender has a Q4 forecast only.
    const r = await selectObservation(
      valueGraph, scope, ids.expRevenueNext, policyOrder.SOURCE_TRUTH, lens(clock), null, Q1,
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'calculation.time_context_mismatch');
    assert.equal(r.error.details.requiredPeriod, '2027-Q1');
    assert.deepEqual(r.error.details.foundPeriods, ['2026-Q4']);
  });
});

describe('period identity in a run', () => {
  /** Demand reads expected revenue from the source world when revenue is not planned. */
  async function runFromPrice(engine, period) {
    return engine.execute(scope, {
      fromMetricKeys: ['AverageSellingPrice'],
      effectiveAsOf: AS_OF,
      ...(period === undefined ? {} : { period }),
    });
  }

  test('a Q4 run and a Q1 run read their own period and write their own period', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);

    const q4 = unwrap(await runFromPrice(engine, Q4), 'Q4 run');
    const q1 = unwrap(await runFromPrice(engine, Q1), 'Q1 run');
    assert.equal(periodKey(q4.run.context.period), '2026-Q4');
    assert.equal(periodKey(q1.run.context.period), '2027-Q1');

    const demand = (res) => res.steps.find((s) => s.outputNodeId === ids.demand);
    assert.equal(demand(q4).outputValue, '8.4', '2.94B ÷ 350M in Q4');
    assert.equal(demand(q1).outputValue, '10', '3.5B ÷ 350M in Q1');

    // Outputs of period metrics carry exactly the modelled period.
    const q4Demand = q4.written.find((o) => o.nodeId === ids.demand);
    assert.equal(q4Demand.periodStart, Q4.start);
    assert.equal(q4Demand.periodEnd, Q4.end);
    const q1Demand = q1.written.find((o) => o.nodeId === ids.demand);
    assert.equal(q1Demand.periodStart, Q1.start);
    assert.equal(q1Demand.metadata.period, '2027-Q1');
  });

  test('the tender has no Q1 revenue: its demand blocks with TIME_CONTEXT_MISMATCH', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const q1 = unwrap(await runFromPrice(engine, Q1), 'Q1 run');
    const tender = q1.steps.find((s) => s.outputNodeId === ids.demandNext);
    assert.equal(tender.status, 'BLOCKED');
    assert.equal(tender.errorCode, 'calculation.time_context_mismatch');
  });

  test('an optional period input with only another period blocks rather than reading as zero', async () => {
    // Freight is optional for gross margin and is estimated for Q4 only. A Q1
    // run must not treat "no Q1 freight on file" as "Q1 freight is zero".
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const q1 = unwrap(
      await engine.execute(scope, { effectiveAsOf: AS_OF, period: Q1 }),
      'full Q1 run',
    );
    const gm = q1.steps.find((s) => s.outputNodeId === ids.grossMargin);
    assert.equal(gm.status, 'BLOCKED');
    assert.equal(gm.errorCode, 'calculation.time_context_mismatch');
    assert.match(gm.errorMessage, /2026-Q4/);
  });

  test('point-in-time inputs carry forward only because they declared the current horizon', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const q1 = unwrap(await runFromPrice(engine, Q1), 'Q1 run');
    // Unit cost is an ACTUAL as of 19 Sep; COGS for Q1 uses it, as declared.
    const cogs = q1.steps.find((s) => s.outputNodeId === ids.cogsOpp);
    assert.equal(cogs.status, 'CALCULATED');
    const unitCost = cogs.inputs.find((i) => i.name === 'unit_cost');
    assert.equal(unitCost.observationType, 'ACTUAL');
    assert.equal(cogs.outputValue, '2170000000', '10 units × 217M');
  });

  test('a run without a period cannot silently use either forecast', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const res = unwrap(await runFromPrice(engine, undefined), 'period-less run');
    const demand = res.steps.find((s) => s.outputNodeId === ids.demand);
    assert.equal(demand.status, 'BLOCKED');
    assert.equal(demand.errorCode, 'calculation.ambiguous_period');
  });

  test('period and horizon must agree', async () => {
    const { engine } = await buildStack();
    const r = await engine.execute(scope, { effectiveAsOf: AS_OF, period: Q4, horizon: 'month' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'calculation.time_context_mismatch');
  });

  test('replay restores the period', async () => {
    const { engine, valueGraph, ids } = await buildStack();
    await addQ1Forecast(valueGraph, ids);
    const q1 = unwrap(await runFromPrice(engine, Q1), 'Q1 run');
    const again = unwrap(await engine.replay(scope, q1.run.id), 'replay');
    assert.equal(periodKey(again.run.context.period), '2027-Q1');
    const demand = (res) => res.steps.find((s) => s.outputNodeId === ids.demand);
    assert.equal(demand(again).outputValue, demand(q1).outputValue);
  });
});
