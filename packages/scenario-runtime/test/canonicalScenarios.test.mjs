/**
 * The canonical Phase 4 proofs, on the Rohto opportunity (brief §58–67).
 *
 * No expected value below was typed into a scenario: every scenario states
 * only overrides, and every number asserted here was computed by Meridian
 * model v1.1 through the propagation engine.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asValidTime } from '@helm/shared';
import { buildMeridianScenarios, Q4_2026, Q1_2027 } from '../src/index.ts';
import { buildStack, scope, unwrap, valueOf } from './harness.mjs';

let s; // stack
let built; // canonical scenarios, sealed
let base; // baseline execution
const exec = {}; // key -> execution

before(async () => {
  s = await buildStack();
  built = unwrap(await buildMeridianScenarios(s.runtime, scope, s.ids, { fork: s.fork }), 'canonical scenarios');
  base = unwrap(await s.runtime.executeBaseline(scope, { fork: s.fork, periods: [Q4_2026] }), 'baseline');
  for (const key of Object.keys(built)) {
    exec[key] = unwrap(await s.runtime.execute(scope, built[key].scenario.id), key);
  }
});

const v = (e, handle, period = '2026-Q4') => valueOf(e.futureState, s.ids[handle], period);
const val = (e, handle, period) => v(e, handle, period)?.value ?? null;
const constraint = (e, key, period = '2026-Q4') =>
  e.futureState.constraints.find((c) => c.constraintKey === key && keyQ(c.period) === period);
const keyQ = (p) => `${new Date(p.start).getUTCFullYear()}-Q${Math.floor(new Date(p.start).getUTCMonth() / 3) + 1}`;

describe('§58 canonical baseline', () => {
  test('the baseline is a modelled state with both lenses, computed by the engine', () => {
    const st = base.futureState;
    assert.equal(base.run.stateKind, 'BASELINE');
    assert.equal(base.run.scenarioId, null);
    assert.equal(base.run.fork.effectiveAsOf, '2026-09-19T12:00:00.000Z');
    assert.ok(base.run.fork.recordedThrough, 'knowledge boundary recorded');
    assert.equal(base.run.periodRuns.length, 1);

    // Revenue, margin, inventory, working capital, cash — Phase 3 numbers, unchanged.
    assert.equal(val(base, 'expRevenue'), '2940000000');
    assert.equal(val(base, 'grossMargin'), '977200000');
    assert.equal(val(base, 'grossMarginPctOpp'), '33.2381');
    assert.equal(val(base, 'invGap'), '8.385714');
    assert.equal(val(base, 'wcProduct'), '2687700000');
    assert.equal(val(base, 'cashOpp'), '-1710500000');
    // Service (v1.1's coverage proxy) and the carried-over service level and risk.
    assert.equal(val(base, 'coverage'), '32.2953');
    assert.equal(v(base, 'serviceLevel').origin, 'INHERITED');
    assert.equal(val(base, 'serviceLevel'), '84');
    assert.equal(val(base, 'supplyRisk'), '62');
    assert.equal(st.completeness, 'PARTIAL', 'allocation is not stated in the baseline');
  });

  test('the baseline writes model truth, never a scenario observation', async () => {
    const trace = unwrap(await s.engine.getTrace(scope, base.run.periodRuns[0].calculationRunId), 'trace');
    const written = trace.filter((t) => t.outputObservationId);
    assert.ok(written.length > 0);
    const obs = unwrap(await s.valueGraph.getObservations(scope, { nodeId: s.ids.grossMargin }), 'obs');
    const mine = obs.find((o) => o.id === v(base, 'grossMargin').observationId);
    assert.equal(mine.observationType, 'DERIVED');
    assert.equal(mine.scenarioEntityId, null);
  });
});

describe('§59 three futures, each distinct because of its overrides', () => {
  test('Expedite: service up, margin and cash down, revenue unchanged', () => {
    const a = exec.expedite;
    assert.equal(val(a, 'coverage'), '96.8858');
    assert.equal(val(a, 'invGap'), '0.385714');
    assert.equal(val(a, 'grossMargin'), '897200000', '977.2M − 80M freight premium');
    assert.equal(val(a, 'cashOpp'), '-1790500000');
    assert.equal(val(a, 'grossMarginPctOpp'), '30.517');
    assert.equal(val(a, 'expRevenue'), '2940000000', 'expediting does not change probability');
  });

  test('Reallocate: service up at a transfer cost; distributor stock stated to zero', () => {
    const b = exec.reallocate;
    assert.equal(val(b, 'coverage'), '96.8858');
    assert.equal(val(b, 'grossMargin'), '952200000', '977.2M − 25M transfer cost');
    const dist = v(b, 'availDist');
    assert.equal(dist.origin, 'OVERRIDDEN');
    assert.equal(dist.value, '0');
    assert.equal(dist.override.baselineValue, '8');
    assert.equal(dist.override.consumed, false, 'no v1.1 calculation reads distributor stock — stated, not propagated');
  });

  test('Alternative product: cheaper price, dearer cost — only metrics the model supports', () => {
    const c = exec['alternative-product'];
    assert.equal(val(c, 'demand'), '8.909091', '2.94B ÷ 330M');
    assert.equal(val(c, 'cogsOpp'), '2126600000');
    assert.equal(val(c, 'grossMarginPctOpp'), '22.9048');
    assert.equal(val(c, 'wcProduct'), '3135650000');
  });

  test('Delay: period-aware — Rohto leaves 2026-Q4 and lands in 2027-Q1', () => {
    const d = exec['delay-delivery'];
    assert.equal(d.run.periodRuns.length, 2, 'one engine run per modelled period');
    assert.equal(val(d, 'expRevenue', '2026-Q4'), '0');
    assert.equal(val(d, 'expRevenue', '2027-Q1'), '2940000000');
    assert.equal(val(d, 'expRevenueNext', '2026-Q4'), '1395000000', 'the tender still delivers in Q4');
    assert.equal(val(d, 'expRevenueNext', '2027-Q1'), '0');
    assert.equal(val(d, 'grossMarginPctOpp', '2027-Q1'), '38', 'no freight premium when delivery is planned');
    // Q4 margin % with no revenue is undefined, and is shown as such.
    const pct = v(d, 'grossMarginPctOpp', '2026-Q4');
    assert.equal(pct.origin, 'BLOCKED');
    assert.equal(pct.value, null);
    assert.match(pct.reason, /divide_by_zero/);
  });

  test('the futures really differ from each other', () => {
    const margins = ['expedite', 'reallocate', 'alternative-product'].map((k) => val(exec[k], 'grossMargin'));
    assert.equal(new Set([val(base, 'grossMargin'), ...margins]).size, 4);
  });
});

describe('§60 unchanged branches', () => {
  test('freight +80M moves cost, margin and cash — not probability, demand or requirement', async () => {
    const created = unwrap(
      await s.runtime.createScenario(scope, {
        key: 'freight-only', name: 'Freight +80M only', fork: s.fork, periods: [Q4_2026],
      }),
      'create',
    );
    unwrap(
      await s.runtime.addOverride(scope, created.revision.id, {
        overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids.freightOpex, operation: 'ADD',
        value: '80000000', unit: 'currency', currency: 'VND', provenanceKind: 'USER_OVERRIDE',
        rationale: 'Isolate the effect of an 80M freight premium.', confidence: 0.9,
      }),
      'override',
    );
    const run = unwrap(await s.runtime.execute(scope, created.scenario.id), 'execute');
    const cmp = unwrap(
      await s.runtime.compare(scope, { baselineRunId: base.run.id, alternativeRunIds: [run.run.id] }),
      'compare',
    );
    const d = (handle) => cmp.metricDeltas.find((x) => x.nodeId === s.ids[handle]);
    for (const unchanged of ['oppProb', 'expRevenue', 'demand', 'invRequirement', 'cogsOpp', 'wcProduct', 'coverage']) {
      assert.equal(d(unchanged).direction, 'UNCHANGED', `${unchanged} must not move`);
    }
    assert.equal(d('freightOpex').absoluteDelta, '80000000');
    assert.equal(d('grossMargin').absoluteDelta, '-80000000');
    assert.equal(d('cashOpp').absoluteDelta, '-80000000');
    assert.equal(d('grossMarginPctOpp').direction, 'DOWN');
  });
});

describe('§66 constraints: feasibility, not optimization', () => {
  test('Delay: the Rohto order needs 12 units in 2027-Q1 and supply allows 8 — BREACHED by 4', () => {
    const c = constraint(exec['delay-delivery'], 'rohto-order-fulfilment', '2027-Q1');
    assert.equal(c.status, 'BREACHED');
    assert.equal(c.actual, '12');
    assert.equal(c.threshold, '8');
    assert.equal(c.breachAmount, '4');
    assert.equal(c.unit, 'units');
    assert.match(c.explanation, /breached by 4 units/);
  });

  test('the same constraint in each state tells its own story', () => {
    assert.equal(constraint(base, 'rohto-order-fulfilment').breachAmount, '8');
    assert.equal(constraint(exec.expedite, 'rohto-order-fulfilment').status, 'SATISFIED');
    assert.equal(constraint(exec.reallocate, 'rohto-order-fulfilment').status, 'SATISFIED');
    assert.equal(constraint(exec['alternative-product'], 'rohto-order-fulfilment').breachAmount, '0.727273');
    assert.equal(constraint(exec['delay-delivery'], 'rohto-order-fulfilment', '2026-Q4').status, 'SATISFIED');
  });

  test('a constraint whose operands are not stated is UNKNOWN, never SATISFIED by default', () => {
    const c = constraint(base, 'own-stock-allocation');
    assert.equal(c.status, 'UNKNOWN');
    assert.match(c.explanation, /Allocated Inventory/);
  });

  test('constraint results are persisted with the simulation', async () => {
    const stored = unwrap(await s.store.listConstraintResults(scope, exec['delay-delivery'].run.id), 'stored');
    assert.equal(stored.length, 4, 'two constraints × two periods');
  });
});

describe('§67 shared resource: two explicit allocations of one stock position', () => {
  test('P and T move the same four units, and the consequences move with them', () => {
    const p = exec['prioritize-rohto'];
    const t = exec['preserve-tender'];
    assert.equal(val(p, 'unserved'), '8');
    assert.equal(val(p, 'revenueAtRisk'), '1960000000', '2.94B × 8/12');
    assert.equal(val(p, 'revenueAtRiskNext'), '1395000000', 'the whole tender is exposed');
    assert.equal(val(t, 'unserved'), '12');
    assert.equal(val(t, 'revenueAtRisk'), '2940000000');
    assert.equal(val(t, 'unservedNext'), '4.857143');
    assert.equal(val(t, 'revenueAtRiskNext'), '765000000', '1.395B × 17/31');
    assert.equal(p.futureState.completeness, 'COMPLETE');
    assert.equal(constraint(p, 'own-stock-allocation').status, 'SATISFIED');
  });

  test('no tender probability is invented: it is the source world\'s 0.45', () => {
    const t = exec['preserve-tender'];
    assert.equal(v(t, 'oppProbNext').origin, 'INHERITED');
    assert.equal(val(t, 'oppProbNext'), '0.45');
  });

  test('committing the same units twice is a breach, not a silent double count', async () => {
    const created = unwrap(
      await s.runtime.createScenario(scope, { key: 'double-commit', name: 'Both deals get 4', fork: s.fork, periods: [Q4_2026] }),
      'create',
    );
    for (const handle of ['allocated', 'allocatedNext']) {
      unwrap(
        await s.runtime.addOverride(scope, created.revision.id, {
          overrideType: 'VALUE_OVERRIDE', targetNodeId: s.ids[handle], value: '4', unit: 'units',
          provenanceKind: 'USER_OVERRIDE', rationale: 'Promise the same four units to both deals.', confidence: 1,
        }),
        handle,
      );
    }
    const run = unwrap(await s.runtime.execute(scope, created.scenario.id), 'execute');
    const c = run.futureState.constraints.find((x) => x.constraintKey === 'own-stock-allocation');
    assert.equal(c.status, 'BREACHED');
    assert.equal(c.breachAmount, '4');
  });

  test('the comparison shows the trade-off and chooses nothing', async () => {
    const cmp = unwrap(
      await s.runtime.compare(scope, {
        baselineRunId: exec['prioritize-rohto'].run.id,
        alternativeRunIds: [exec['preserve-tender'].run.id],
      }),
      'compare',
    );
    const d = (handle) => cmp.metricDeltas.find((x) => x.nodeId === s.ids[handle]);
    assert.equal(d('revenueAtRisk').absoluteDelta, '980000000');
    assert.equal(d('revenueAtRisk').directionalInterpretation, 'UNFAVORABLE');
    assert.equal(d('revenueAtRiskNext').absoluteDelta, '-630000000');
    assert.equal(d('revenueAtRiskNext').directionalInterpretation, 'FAVORABLE');
    for (const forbidden of ['recommended', 'winner', 'best', 'score', 'rank', 'ranking']) {
      assert.equal(forbidden in cmp, false, `a comparison has no "${forbidden}"`);
    }
    assert.match(cmp.statement, /does not rank, score or recommend/);
  });
});

describe('§20–22 comparison: deltas, dimensions, context', () => {
  let cmp;
  before(async () => {
    cmp = unwrap(
      await s.runtime.compare(scope, {
        baselineRunId: base.run.id,
        alternativeRunIds: ['expedite', 'reallocate', 'alternative-product', 'delay-delivery'].map((k) => exec[k].run.id),
      }),
      'compare',
    );
  });
  const d = (key, handle, period = '2026-Q4') =>
    cmp.metricDeltas.find(
      (x) => x.state.scenarioKey === key && x.nodeId === s.ids[handle] && keyQ(x.period) === period,
    );

  test('value deltas carry both sides, the movement and its meaning', () => {
    const gm = d('expedite', 'grossMargin');
    assert.equal(gm.baseline, '977200000');
    assert.equal(gm.scenario, '897200000');
    assert.equal(gm.absoluteDelta, '-80000000');
    assert.equal(gm.relativeDelta, '-0.081867');
    assert.equal(gm.direction, 'DOWN');
    assert.equal(gm.directionalInterpretation, 'UNFAVORABLE');
    assert.equal(d('expedite', 'coverage').directionalInterpretation, 'FAVORABLE');
  });

  test('a percentage moves in points; its relative change is not stated', () => {
    const pct = d('expedite', 'grossMarginPctOpp');
    assert.equal(pct.absoluteDelta, '-2.7211');
    assert.equal(pct.relativeDelta, null);
  });

  test('context-dependent metrics are shown, not judged', () => {
    const wc = d('alternative-product', 'wcProduct');
    assert.equal(wc.direction, 'UP');
    assert.equal(wc.directionalInterpretation, 'CONTEXT_DEPENDENT');
  });

  test('deltas are grouped by dimension and never summed', () => {
    const groups = cmp.dimensionDeltas.filter((g) => g.state.scenarioKey === 'expedite');
    assert.ok(groups.some((g) => g.dimension === 'FINANCIAL'));
    assert.ok(groups.some((g) => g.dimension === 'CUSTOMER'));
    for (const g of groups) {
      assert.deepEqual(Object.keys(g).sort(), ['deltas', 'dimension', 'state']);
    }
  });

  test('periods are never compared across: the delay\'s 2027-Q1 has no baseline counterpart', () => {
    const q1 = d('delay-delivery', 'expRevenue', '2027-Q1');
    assert.equal(q1.direction, 'UNRESOLVED');
    assert.match(q1.unresolvedReason, /baseline does not model this value for this period/);
    const comparability = cmp.comparability.find((c) => c.state.scenarioKey === 'delay-delivery');
    assert.equal(comparability.samePeriods, false);
  });

  test('blocked values are unresolved, not zero', () => {
    const risk = d('expedite', 'revenueAtRisk');
    assert.equal(risk.direction, 'UNRESOLVED');
    assert.equal(risk.absoluteDelta, null);
    assert.ok(cmp.unresolvedMetrics.some((u) => u.nodeId === s.ids.revenueAtRisk));
  });

  test('assumption deltas are separate from outcome deltas', () => {
    const a = cmp.assumptionDeltas.filter((x) => x.state.scenarioKey === 'expedite');
    const inv = a.find((x) => x.nodeId === s.ids.availOwn);
    assert.equal(inv.baselineValue, '4');
    assert.equal(inv.scenarioValue, '12');
    const freight = a.find((x) => x.nodeId === s.ids.freightOpex);
    assert.equal(freight.operation, 'ADD');
    assert.equal(freight.overrideValue, '80000000');
    assert.equal(freight.baselineValue, '140000000');
    assert.equal(freight.scenarioValue, '220000000');
    const lead = a.find((x) => x.nodeId === s.ids.leadTime);
    assert.equal(lead.consumed, false, '21 → 7 days is stated; v1.1 has no lead-time calculation');
    // No outcome is ever an assumption.
    assert.ok(!cmp.assumptionDeltas.some((x) => x.nodeId === s.ids.grossMargin));
  });

  test('confidence sits beside every value and is never aggregated', () => {
    const row = cmp.rows.find((r) => r.nodeId === s.ids.invGap);
    const cells = row.cells.map((c) => c.confidence);
    assert.ok(cells.every((c) => c === null || (c >= 0 && c <= 1)));
    assert.ok(!('confidence' in cmp) || typeof cmp.confidence !== 'number');
  });
});

describe('§35–36 inheritance and conflict', () => {
  test('the child inherits Expedite, applies its own, and records what it shadowed', () => {
    const child = exec['expedite-price-increase'];
    const inv = v(child, 'availOwn');
    assert.equal(inv.origin, 'OVERRIDDEN');
    assert.equal(inv.override.inheritedFromScenarioId, built.expedite.scenario.id);
    const freight = v(child, 'freightOpex');
    assert.equal(freight.value, '240000000', '140M + the child\'s 100M, not the parent\'s 80M');
    assert.equal(freight.override.shadowedOverrideIds.length, 1, 'the parent\'s +80M is recorded, not lost');
    assert.equal(val(child, 'demand'), '7.636364', 'the child\'s price moves demand');
  });

  test('the child pins a sealed parent revision', () => {
    assert.equal(built['expedite-price-increase'].revision.parentRevisionId, built.expedite.revision.id);
  });
});

describe('§63 scenario isolation and §76 the source boundary', () => {
  test('a scenario reads reality, never another scenario and never persisted scenario output', async () => {
    const fromReallocate = v(exec.reallocate, 'freightOpex');
    assert.equal(fromReallocate.value, '165000000', 'B sees 140M + its own 25M, not A\'s 80M');
    const obs = unwrap(await s.valueGraph.getObservations(scope, { nodeId: s.ids.grossMargin }), 'obs');
    const scenarioOutputs = obs.filter((o) => o.observationType === 'SCENARIO');
    assert.ok(scenarioOutputs.length >= 5);
    for (const o of scenarioOutputs) {
      assert.ok(o.scenarioEntityId, 'every scenario output names its scenario');
      assert.ok(o.metadata.scenarioRevisionId, 'and the revision that produced it');
    }
    // The baseline's source value is untouched by every scenario.
    const freight = unwrap(await s.valueGraph.getObservations(scope, { nodeId: s.ids.freightOpex, scenarioEntityId: null }), 'freight');
    assert.deepEqual(freight.map((o) => o.numericValue), [140000000]);
  });

  test('knowledge recorded after the fork does not enter the scenario', async () => {
    // Commercial now says 95%, recorded AFTER the canonical fork.
    unwrap(
      await s.valueGraph.recordObservation(scope, {
        nodeId: s.ids.oppProb, observationType: 'ACTUAL', numericValue: 0.95, unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'), sourceSystem: 'memoire', confidence: 0.9,
      }),
      'late fact',
    );
    const again = unwrap(await s.runtime.replay(scope, exec.expedite.run.id), 'replay');
    assert.equal(val(again, 'oppProb'), '0.7');
    assert.equal(val(again, 'expRevenue'), '2940000000');
  });
});
