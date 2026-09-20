/**
 * verify:propagation — the canonical proof, as an executable contract.
 *
 * This is the script that answers "does HELM actually propagate?" without
 * anybody having to read a test file:
 *
 *   1. The whole nine-calculation chain computes over the canonical graph.
 *   2. Probability 70% → 90% moves expected revenue 2.94B → 3.78B and demand
 *      8.4 → 10.8, exactly.
 *   3. Unit cost +10% moves the COST branch and leaves the REVENUE branch
 *      untouched — the property that separates a dependency model from a
 *      canned scenario.
 *   4. Re-running with identical inputs changes nothing (idempotent).
 *   5. History is never rewritten: the superseded derived value is still there.
 *   6. A changed input marks a derived value stale without mutating it.
 *   7. Replaying a run reproduces its numbers and fingerprints.
 *   8. Arithmetic is exact — no floating-point drift anywhere in the chain.
 *   9. Contention is quantified: claimed demand exceeds available stock.
 */

import { buildSeedRegistry } from '../packages/ontology/src/index.ts';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '../packages/shared/src/index.ts';
import { createInMemoryGraphStore } from '../packages/graph-store/src/inMemory.ts';
import { buildCanonicalScenario } from '../packages/graph-store/src/canonicalScenario.ts';
import { createInMemoryValueGraph } from '../packages/value-graph/src/inMemory.ts';
import { buildSeedValueRegistry } from '../packages/value-graph/src/registry.ts';
import { buildCanonicalValueChain } from '../packages/value-graph/src/canonicalValueChain.ts';
import { createCalculationRegistry } from '../packages/propagation-engine/src/registry.ts';
import { createPropagationEngine } from '../packages/propagation-engine/src/engine.ts';
import { createInMemoryCalculationStore } from '../packages/propagation-engine/src/inMemoryStore.ts';
import { meridianValueModelV1 } from '../packages/propagation-engine/src/meridianValueModelV1.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};
const eq = (rule, actual, expected, what) => {
  if (actual !== expected) fail(rule, `${what}: expected ${expected}, got ${actual}`);
};

const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];

const scope = {
  orgId: asOrgId('11111111-1111-4111-8111-111111111111'),
  actorId: asUserId('aaaa1111-1111-4111-8111-111111111111'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

async function buildStack() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('vp');
  const ontology = buildSeedRegistry();
  const metrics = buildSeedValueRegistry();

  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const entities = await buildCanonicalScenario(graphStore, scope);
  if (!entities.ok) throw new Error(`entity graph: ${entities.error.message}`);

  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
  const chain = await buildCanonicalValueChain(valueGraph, graphStore, scope);
  if (!chain.ok) throw new Error(`value chain: ${chain.error.message}`);

  const registry = createCalculationRegistry(meridianValueModelV1, metrics);
  if (!registry.ok) throw new Error(`registry: ${registry.error.message}`);

  const store = createInMemoryCalculationStore({ clock, idGen });
  const engine = createPropagationEngine({
    registry: registry.value,
    valueGraph,
    graphStore,
    ontology,
    store,
    clock,
  });
  if (!engine.ok) throw new Error(`engine: ${engine.error.message}`);

  return { engine: engine.value, valueGraph, store, ids: chain.value.nodeIds };
}

const derived = async (valueGraph, nodeId) => {
  const r = await valueGraph.getLatestObservation(scope, { nodeId, type: 'DERIVED' });
  if (!r.ok || !r.value) return null;
  return r.value.metadata?.exactValue ?? String(r.value.numericValue);
};

const run = (engine, extra = {}) =>
  engine.execute(scope, { fromMetricKeys: ROOTS, asOf: AS_OF, horizon: 'quarter', ...extra });

// ------------------------------------------------ 1: the whole chain computes

{
  const { engine, valueGraph, ids } = await buildStack();
  const result = await run(engine);
  check('chain-computes', result.ok, `the baseline run failed: ${result.ok ? '' : result.error.message}`);

  if (result.ok) {
    eq('chain-computes', result.value.summary.BLOCKED, 0, 'blocked steps in the canonical chain');
    eq('chain-computes', result.value.summary.FAILED, 0, 'failed steps in the canonical chain');
    check(
      'chain-computes',
      result.value.summary.CALCULATED >= 11,
      `only ${result.value.summary.CALCULATED} value positions were calculated; the ` +
        'canonical chain has 11',
    );

    // 8: exactness, everywhere. Each of these is a number a float would get wrong.
    eq('exactness', await derived(valueGraph, ids.expRevenue), '2940000000', 'expected revenue');
    eq('exactness', await derived(valueGraph, ids.demand), '8.4', 'demand');
    eq('exactness', await derived(valueGraph, ids.expRevenueNext), '1395000000', 'competing revenue');
    eq('exactness', await derived(valueGraph, ids.demandNext), '3.985714285714', 'competing demand');
    eq('exactness', await derived(valueGraph, ids.invRequirement), '12.385714285714', 'requirement');
    eq('exactness', await derived(valueGraph, ids.invGap), '8.385714285714', 'inventory gap');
    eq('exactness', await derived(valueGraph, ids.cogsOpp), '1822800000', 'COGS');
    eq('exactness', await derived(valueGraph, ids.grossMargin), '977200000', 'gross margin');
    eq('exactness', await derived(valueGraph, ids.wcProduct), '2687699999.999938', 'working capital');
    eq('exactness', await derived(valueGraph, ids.cashOpp), '-1710499999.999938', 'cash impact');
    eq('exactness', await derived(valueGraph, ids.grossMarginPctOpp), '33.2380952381', 'gross margin %');

    // The float route really is wrong, which is why the above matters.
    check(
      'exactness',
      String(0.7 * 12) !== '8.4',
      'the floating-point comparison this check rests on no longer holds',
    );
  }
}

// ---------------------------- 2: probability 70% → 90% propagates, exactly

{
  const { engine, valueGraph, ids } = await buildStack();
  const baseline = await run(engine);
  check('propagates', baseline.ok, 'the baseline run failed');

  const before = {
    revenue: await derived(valueGraph, ids.expRevenue),
    demand: await derived(valueGraph, ids.demand),
    margin: await derived(valueGraph, ids.grossMargin),
  };
  eq('propagates', before.revenue, '2940000000', 'revenue before');
  eq('propagates', before.demand, '8.4', 'demand before');

  // The ONLY change: a newer ACTUAL probability. Nothing else is touched.
  const written = await valueGraph.recordObservation(scope, {
    nodeId: ids.oppProb,
    observationType: 'ACTUAL',
    numericValue: 0.9,
    unitType: 'ratio',
    effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
    observedAt: asValidTime('2026-09-19T10:00:00.000Z'),
    sourceSystem: 'memoire',
    confidence: 0.9,
  });
  check('propagates', written.ok, 'the new probability could not be recorded');

  const after = await engine.propagateFrom(scope, 'OpportunityProbability', {
    asOf: AS_OF,
    horizon: 'quarter',
  });
  check('propagates', after.ok, `propagation failed: ${after.ok ? '' : after.error.message}`);

  eq('propagates', await derived(valueGraph, ids.expRevenue), '3780000000', 'revenue after');
  eq('propagates', await derived(valueGraph, ids.demand), '10.8', 'demand after');
  check(
    'propagates',
    (await derived(valueGraph, ids.grossMargin)) !== before.margin,
    'gross margin did not move when revenue did',
  );

  // 5: history is not rewritten.
  const history = await valueGraph.getObservations(scope, {
    nodeId: ids.expRevenue,
    types: ['DERIVED'],
  });
  check('history-preserved', history.ok, 'the derived history could not be read');
  if (history.ok) {
    eq('history-preserved', history.value.length, 2, 'derived observations on expected revenue');
    const values = history.value.map((o) => o.metadata?.exactValue).sort();
    check(
      'history-preserved',
      values[0] === '2940000000' && values[1] === '3780000000',
      `both the old and the new value must survive; found ${values.join(', ')}`,
    );
  }
}

// --------------------- 3: unit cost +10% moves the cost branch ONLY

{
  const { engine, valueGraph, ids } = await buildStack();
  check('branch-isolation', (await run(engine)).ok, 'the baseline run failed');

  const before = {
    revenue: await derived(valueGraph, ids.expRevenue),
    demand: await derived(valueGraph, ids.demand),
    requirement: await derived(valueGraph, ids.invRequirement),
    gap: await derived(valueGraph, ids.invGap),
    cogs: await derived(valueGraph, ids.cogsOpp),
    workingCapital: await derived(valueGraph, ids.wcProduct),
    margin: await derived(valueGraph, ids.grossMargin),
    cash: await derived(valueGraph, ids.cashOpp),
  };

  // 217M → 238.7M.
  const written = await valueGraph.recordObservation(scope, {
    nodeId: ids.unitCost,
    observationType: 'ACTUAL',
    numericValue: 238_700_000,
    unitType: 'currency',
    currency: 'VND',
    effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
    sourceSystem: 'erp',
    confidence: 1,
  });
  check('branch-isolation', written.ok, 'the new unit cost could not be recorded');

  const result = await engine.propagateFrom(scope, 'UnitCost', { asOf: AS_OF, horizon: 'quarter' });
  check('branch-isolation', result.ok, 'propagation from unit cost failed');

  const after = {
    revenue: await derived(valueGraph, ids.expRevenue),
    demand: await derived(valueGraph, ids.demand),
    requirement: await derived(valueGraph, ids.invRequirement),
    gap: await derived(valueGraph, ids.invGap),
    cogs: await derived(valueGraph, ids.cogsOpp),
    workingCapital: await derived(valueGraph, ids.wcProduct),
    margin: await derived(valueGraph, ids.grossMargin),
    cash: await derived(valueGraph, ids.cashOpp),
  };

  for (const key of ['revenue', 'demand', 'requirement', 'gap']) {
    eq('branch-isolation', after[key], before[key], `${key} must not move when unit cost changes`);
  }
  for (const key of ['cogs', 'workingCapital', 'margin', 'cash']) {
    check(
      'branch-isolation',
      after[key] !== before[key],
      `${key} did not move when unit cost changed, and it depends on unit cost`,
    );
  }

  if (result.ok) {
    const touched = new Set(
      result.value.steps.filter((s) => s.status === 'CALCULATED').map((s) => s.outputMetricKey),
    );
    check('branch-isolation', touched.has('WorkingCapital'), 'working capital was not recalculated');
    check('branch-isolation', touched.has('Cogs'), 'COGS was not recalculated');
    check(
      'branch-isolation',
      !touched.has('ExpectedRevenue'),
      'expected revenue was recalculated by a cost change it does not depend on',
    );
    check(
      'branch-isolation',
      !touched.has('DemandQuantity'),
      'demand was recalculated by a cost change it does not depend on',
    );
  }
}

// -------------------------------------------------------- 4: idempotency

{
  const { engine } = await buildStack();
  const first = await run(engine);
  const second = await run(engine);
  check('idempotent', first.ok && second.ok, 'a run failed');
  if (first.ok && second.ok) {
    check('idempotent', first.value.summary.CALCULATED > 0, 'the first run calculated nothing');
    eq('idempotent', second.value.summary.CALCULATED, 0, 'recalculations on an unchanged model');
    check(
      'idempotent',
      second.value.summary.UNCHANGED > 0,
      'the second run reported nothing as unchanged, so it cannot have recognised itself',
    );
  }
}

// ---------------------------------------------------------- 6: staleness

{
  const { engine, valueGraph, ids } = await buildStack();
  check('staleness', (await run(engine)).ok, 'the baseline run failed');

  const clean = await engine.checkFreshness(scope, [ids.expRevenue], { asOf: AS_OF });
  check('staleness', clean.ok, 'the freshness check failed');
  if (clean.ok) {
    eq('staleness', clean.value[0].state, 'CLEAN', 'freshness before any change');
  }

  await valueGraph.recordObservation(scope, {
    nodeId: ids.oppProb,
    observationType: 'ACTUAL',
    numericValue: 0.9,
    unitType: 'ratio',
    effectiveAt: asValidTime('2026-09-19T10:00:00.000Z'),
    sourceSystem: 'memoire',
    confidence: 0.9,
  });

  const stale = await engine.checkFreshness(scope, [ids.expRevenue], { asOf: AS_OF });
  check('staleness', stale.ok, 'the second freshness check failed');
  if (stale.ok) {
    eq('staleness', stale.value[0].state, 'STALE', 'freshness after an input changed');
    check(
      'staleness',
      stale.value[0].recordedFingerprint !== stale.value[0].currentFingerprint,
      'a stale value reports identical fingerprints, so nothing detected the change',
    );
  }

  // Marked stale, NOT mutated.
  eq(
    'staleness',
    await derived(valueGraph, ids.expRevenue),
    '2940000000',
    'the derived value must stay exactly as recorded until it is recalculated',
  );
}

// ------------------------------------------------------------ 7: replay

{
  const { engine, valueGraph, store, ids } = await buildStack();
  const first = await run(engine);
  check('replay', first.ok, 'the first run failed');
  if (first.ok) {
    const original = await derived(valueGraph, ids.expRevenue);
    const replayed = await engine.replay(scope, first.value.run.id);
    check('replay', replayed.ok, `replay failed: ${replayed.ok ? '' : replayed.error.message}`);
    if (replayed.ok) {
      eq('replay', replayed.value.run.triggerType, 'REPLAY', 'the replay run trigger');
      const before = await store.getSteps(scope, first.value.run.id);
      const after = await store.getSteps(scope, replayed.value.run.id);
      check('replay', before.ok && after.ok, 'the traces could not be read');
      if (before.ok && after.ok) {
        const fps = (s) => s.filter((x) => x.inputFingerprint).map((x) => x.inputFingerprint);
        check(
          'replay',
          JSON.stringify(fps(after.value)) === JSON.stringify(fps(before.value)),
          'a replay produced different input fingerprints, so the run was not reproducible',
        );
      }
      eq('replay', await derived(valueGraph, ids.expRevenue), original, 'the replayed value');
    }
  }
}

// -------------------------------------------------------- 9: contention

{
  const { engine, valueGraph, ids } = await buildStack();
  check('contention', (await run(engine)).ok, 'the baseline run failed');

  const contention = await valueGraph.findContention(scope);
  check('contention', contention.ok, 'contention could not be read');
  if (contention.ok) {
    const onOwnStock = contention.value.find((c) => c.node.id === ids.availOwn);
    check('contention', Boolean(onOwnStock), 'company stock is not recognised as contended');
    if (onOwnStock) {
      eq('contention', onOwnStock.claimants.length, 2, 'value streams claiming company stock');
    }
  }

  // Phase 2 could say two streams claim one position. Phase 3 says by how much:
  // 12.385714285714 units are required and 4 are on hand.
  const requirement = await derived(valueGraph, ids.invRequirement);
  const available = await valueGraph.getLatestObservation(scope, {
    nodeId: ids.availOwn,
    type: 'ACTUAL',
  });
  check('contention', available.ok && available.value, 'available stock could not be read');
  if (available.ok && available.value) {
    check(
      'contention',
      Number(requirement) > available.value.numericValue,
      `requirement ${requirement} should exceed available ${available.value.numericValue}`,
    );
    eq(
      'contention',
      await derived(valueGraph, ids.invGap),
      '8.385714285714',
      'the quantified shortfall',
    );
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    'verify:propagation — ok (chain computes, 2.94B → 3.78B on probability, cost branch ' +
      'isolated, idempotent, history preserved, replayable, exact)',
  );
  process.exit(0);
}

console.error(`verify:propagation — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
