/**
 * verify:lineage — every derived number can be explained, all the way down.
 *
 * The phase brief's standard is that a manager can ask "why is this number what
 * it is?" and get an answer that terminates in facts a source system asserted or
 * a person assumed. This script holds HELM to it:
 *
 *   1. Every DERIVED observation resolves to the step that produced it.
 *   2. Every step names its calculation, its version, its exact inputs and the
 *      formula rendered with real numbers.
 *   3. explain() recurses to leaves, and every leaf is a stated fact or an
 *      assumption — never a dangling reference.
 *   4. The deepest number in the chain (cash) traces back to the opportunity.
 *   5. An assumption is visible AS an assumption, not laundered into a fact.
 *   6. Confidence degrades monotonically down the chain and never exceeds its
 *      weakest input.
 *   7. A stated observation explains as stated: explain() does not invent a
 *      derivation for a number nobody derived.
 *   8. A run consumes its OWN derived output:
 *
 *        source world (actual / forecast / assumption)
 *          -> calculation run
 *            -> same-run derived output
 *              -> downstream calculations
 *
 *      A trace that cites an observation its run did not produce cannot
 *      demonstrate that the run was internally consistent, however plausible
 *      each individual number looks.
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

const AS_OF = new Date('2026-09-19T12:00:00.000Z');
const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];
const STATED = new Set(['ACTUAL', 'FORECAST', 'ESTIMATE', 'ASSUMPTION', 'TARGET', 'SCENARIO']);

const scope = {
  orgId: asOrgId('11111111-1111-4111-8111-111111111111'),
  actorId: asUserId('aaaa1111-1111-4111-8111-111111111111'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

let tick = 0;
const base = Date.parse('2026-09-19T08:00:00.000Z');
const clock = { now: () => new Date(base + (tick += 1) * 1000) };
const idGen = seqIdGen('vl');
const ontology = buildSeedRegistry();
const metrics = buildSeedValueRegistry();

const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
const entities = await buildCanonicalScenario(graphStore, scope);
if (!entities.ok) {
  console.error(`verify:lineage — entity graph: ${entities.error.message}`);
  process.exit(1);
}
const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
const chain = await buildCanonicalValueChain(valueGraph, graphStore, scope);
if (!chain.ok) {
  console.error(`verify:lineage — value chain: ${chain.error.message}`);
  process.exit(1);
}
const ids = chain.value.nodeIds;

const registry = createCalculationRegistry(meridianValueModelV1, metrics);
if (!registry.ok) {
  console.error(`verify:lineage — registry: ${registry.error.message}`);
  process.exit(1);
}
const store = createInMemoryCalculationStore({ clock, idGen });
const engineResult = createPropagationEngine({
  registry: registry.value,
  valueGraph,
  graphStore,
  ontology,
  store,
  clock,
});
if (!engineResult.ok) {
  console.error(`verify:lineage — engine: ${engineResult.error.message}`);
  process.exit(1);
}
const engine = engineResult.value;

const result = await engine.execute(scope, {
  fromMetricKeys: ROOTS,
  asOf: AS_OF,
  horizon: 'quarter',
});
if (!result.ok) {
  console.error(`verify:lineage — run: ${result.error.message}`);
  process.exit(1);
}

// ----------------------- 1-2: every derived value has a complete step

const written = result.value.written;
check('lineage-exists', written.length > 0, 'the run wrote no observations to trace');

for (const obs of written) {
  const step = await store.findStepByOutputObservation(scope, obs.id);
  check(
    'lineage-exists',
    step.ok && step.value !== null,
    `derived observation ${obs.id} has no step that produced it`,
  );
  if (!step.ok || !step.value) continue;

  const s = step.value;
  check('trace-complete', s.calculationKey.length > 0, `${obs.id}: the step names no calculation`);
  check(
    'trace-complete',
    /^\d+\.\d+\.\d+$/.test(s.calculationVersion),
    `${obs.id}: the step names no exact formula version`,
  );
  check('trace-complete', Boolean(s.outputValue), `${obs.id}: the step records no exact value`);
  check(
    'trace-complete',
    Boolean(s.renderedExpression),
    `${obs.id}: the step records no formula with real numbers in it`,
  );
  check('trace-complete', s.inputs.length > 0, `${obs.id}: the step records no inputs`);
  // The rendered expression must contain the answer, or it is not an account of
  // how the answer was reached.
  check(
    'trace-complete',
    (s.renderedExpression ?? '').includes(s.outputValue ?? ''),
    `${obs.id}: the rendered formula does not contain the value it produced`,
  );
  for (const input of s.inputs) {
    check(
      'trace-complete',
      Boolean(input.observationId),
      `${obs.id}: an input does not name the exact observation it used`,
    );
    check('trace-complete', Boolean(input.value), `${obs.id}: an input records no value`);
    check(
      'trace-complete',
      Boolean(input.sourceSystem),
      `${obs.id}: an input does not say which system it came from`,
    );
    // An aggregated input must show its PARTS. Showing only the total would
    // make `Σ 12.385714285714 = 12.385714285714` a complete-looking trace that
    // hides the only interesting thing: which claims were added together.
    if (input.components && input.components.length > 1) {
      for (const component of input.components) {
        check(
          'trace-complete',
          (s.renderedExpression ?? '').includes(component.value),
          `${obs.id}: aggregated input ${input.name} does not show its component ` +
            `${component.value} in the rendered formula`,
        );
        check(
          'trace-complete',
          Boolean(component.observationId),
          `${obs.id}: an aggregated component does not name its observation`,
        );
      }
    } else {
      check(
        'trace-complete',
        (s.renderedExpression ?? '').includes(input.value),
        `${obs.id}: input ${input.name} = ${input.value} does not appear in the rendered formula`,
      );
    }
  }
}

// ------------------- 8: every derived input came from this same run

{
  const producedForNode = new Map();
  for (const step of result.value.steps) {
    if (step.outputObservationId) producedForNode.set(step.outputNodeId, step.outputObservationId);
  }
  const ownOutputs = new Set(producedForNode.values());

  for (const step of result.value.steps) {
    if (step.status !== 'CALCULATED' && step.status !== 'UNCHANGED') continue;
    for (const input of step.inputs) {
      // An aggregated input records its nodes and observations in matching
      // order, so they must be zipped rather than cross-paired.
      const nodeIds = String(input.nodeId).split('+');
      const observationIds = String(input.observationId).split('+');
      for (let i = 0; i < nodeIds.length; i += 1) {
        const nodeId = nodeIds[i];
        const id = observationIds[i];
        // Only inputs on nodes this run computed are constrained. An input from
        // a node outside the plan legitimately comes from the stored world.
        if (!producedForNode.has(nodeId)) continue;
        check(
          'same-run-consistency',
          producedForNode.get(nodeId) === id,
          `${step.calculationKey} consumed observation ${id} for a node this run ` +
            `computed as ${producedForNode.get(nodeId)}. A run must consume its own ` +
            'derived output, or its trace describes a derivation that never happened',
        );
        check(
          'same-run-consistency',
          ownOutputs.has(id),
          `${step.calculationKey} consumed ${id}, which no step of this run produced`,
        );
      }
    }
  }
}

// ------------- 8b: the rule needs a race to have any teeth
//
// A single sequential run is same-run consistent by ACCIDENT: its own write
// always has the latest record time, so re-querying the node returns it anyway.
// The property only becomes falsifiable when two runs are in flight, so the
// contract creates that situation rather than asserting into an easy case.
{
  let raceTick = 0;
  const raceClock = {
    now: () => new Date(Date.parse('2026-09-19T08:00:00.000Z') + (raceTick += 1) * 1000),
  };
  const raceIdGen = seqIdGen('rl');
  const raceOntology = buildSeedRegistry();
  const raceMetrics = buildSeedValueRegistry();

  const raceGraphStore = createInMemoryGraphStore({
    registry: raceOntology,
    clock: raceClock,
    idGen: raceIdGen,
  });
  const raceEntities = await buildCanonicalScenario(raceGraphStore, scope);
  const raceValueGraph = createInMemoryValueGraph({
    metrics: raceMetrics,
    ontology: raceOntology,
    graphStore: raceGraphStore,
    clock: raceClock,
    idGen: raceIdGen,
  });
  const raceChain = await buildCanonicalValueChain(raceValueGraph, raceGraphStore, scope);
  const raceRegistry = createCalculationRegistry(meridianValueModelV1, raceMetrics);
  const raceStore = createInMemoryCalculationStore({ clock: raceClock, idGen: raceIdGen });
  const raceEngineResult =
    raceEntities.ok && raceChain.ok && raceRegistry.ok
      ? createPropagationEngine({
          registry: raceRegistry.value,
          valueGraph: raceValueGraph,
          graphStore: raceGraphStore,
          ontology: raceOntology,
          store: raceStore,
          clock: raceClock,
        })
      : { ok: false, error: { message: 'race fixture failed to build' } };

  check('same-run-consistency', raceEngineResult.ok, 'the race fixture could not be built');

  if (raceEngineResult.ok && raceChain.ok) {
    const raceEngine = raceEngineResult.value;
    const raceIds = raceChain.value.nodeIds;
    const probability = (value, at, confidence) =>
      raceValueGraph.recordObservation(scope, {
        nodeId: raceIds.oppProb,
        observationType: 'ACTUAL',
        numericValue: value,
        unitType: 'ratio',
        effectiveAt: asValidTime(at),
        observedAt: asValidTime(at),
        sourceSystem: 'memoire',
        confidence,
      });

    await raceEngine.execute(scope, { fromMetricKeys: ROOTS, asOf: AS_OF, horizon: 'quarter' });
    await probability(0.9, '2026-09-19T10:00:00.000Z', 0.9);

    // A scheduled recalculation and a manual one, overlapping.
    const runA = raceEngine.propagateFrom(scope, 'OpportunityProbability', {
      asOf: AS_OF,
      horizon: 'quarter',
    });
    await Promise.resolve();
    await probability(0.5, '2026-09-19T11:00:00.000Z', 1);
    const runB = raceEngine.propagateFrom(scope, 'OpportunityProbability', {
      asOf: AS_OF,
      horizon: 'quarter',
    });
    const [ra, rb] = await Promise.all([runA, runB]);

    check('same-run-consistency', ra.ok && rb.ok, 'an interleaved run failed outright');

    if (ra.ok && rb.ok) {
      check(
        'same-run-consistency',
        ra.value.run.id !== rb.value.run.id,
        'the two interleaved propagations were the same run',
      );
      for (const [label, res] of [
        ['A', ra.value],
        ['B', rb.value],
      ]) {
        const revenue = res.steps.find((s) => s.outputNodeId === raceIds.expRevenue);
        const demand = res.steps.find((s) => s.outputNodeId === raceIds.demand);
        check(
          'same-run-consistency',
          Boolean(revenue && demand),
          `interleaved run ${label} did not compute the revenue and demand steps`,
        );
        if (!revenue || !demand) continue;
        const consumed = demand.inputs.find((i) => i.metricKey === 'ExpectedRevenue');
        check(
          'same-run-consistency',
          consumed?.observationId === revenue.outputObservationId,
          `interleaved run ${label}: demand consumed expected revenue ` +
            `${consumed?.observationId}, but this run produced ` +
            `${revenue.outputObservationId}. With two runs in flight, reading the ` +
            'newest observation on a node silently crosses run boundaries',
        );
      }
    }
  }
}

// --------------------------- 3-4: explain() recurses to stated facts

/** Walks an explanation, collecting leaves and the metrics on the way down. */
function walk(node, acc = { metrics: new Set(), leaves: [], depth: 0 }, depth = 0) {
  acc.metrics.add(node.metricKey);
  acc.depth = Math.max(acc.depth, depth);
  if (node.inputs.length === 0) acc.leaves.push(node);
  for (const input of node.inputs) walk(input, acc, depth + 1);
  return acc;
}

for (const [handle, label] of [
  ['expRevenue', 'expected revenue'],
  ['grossMargin', 'gross margin'],
  ['cashOpp', 'cash impact'],
  ['invGap', 'inventory gap'],
]) {
  const obs = await valueGraph.getLatestObservation(scope, { nodeId: ids[handle], type: 'DERIVED' });
  check('lineage-exists', obs.ok && obs.value !== null, `${label} was not derived`);
  if (!obs.ok || !obs.value) continue;

  const explanation = await engine.explain(scope, obs.value.id);
  check(
    'explainable',
    explanation.ok,
    `${label} could not be explained: ${explanation.ok ? '' : explanation.error.message}`,
  );
  if (!explanation.ok) continue;

  check('explainable', Boolean(explanation.value.derivation), `${label} reports no derivation`);
  const acc = walk(explanation.value);

  // Every leaf must be a stated fact — not an empty derived node, which would
  // mean the walk gave up before reaching the bottom.
  for (const leaf of acc.leaves) {
    check(
      'terminates-in-facts',
      leaf.derivation === null,
      `${label}: the explanation ends at a DERIVED value with no inputs, so the ` +
        'chain of reasoning is broken',
    );
    check(
      'terminates-in-facts',
      STATED.has(leaf.observationType),
      `${label}: a leaf is a ${leaf.observationType}, which is neither a stated fact ` +
        'nor an assumption',
    );
    check(
      'terminates-in-facts',
      Boolean(leaf.source?.system),
      `${label}: a leaf does not say which system or person asserted it`,
    );
  }

  if (handle === 'cashOpp') {
    // 4: the deepest number in the model reaches the commercial fact that started it.
    for (const metric of [
      'GrossMargin',
      'Cogs',
      'WorkingCapital',
      'InventoryRequirement',
      'DemandQuantity',
      'ExpectedRevenue',
      'OpportunityValue',
      'OpportunityProbability',
      'UnitCost',
      'AverageSellingPrice',
    ]) {
      check(
        'reaches-origin',
        acc.metrics.has(metric),
        `cash impact does not trace back through ${metric}`,
      );
    }
    check(
      'reaches-origin',
      acc.depth >= 5,
      `the cash explanation is only ${acc.depth} deep; the chain is longer than that`,
    );
  }
}

// ------------------------------- 5: an assumption stays an assumption

{
  const demand = await valueGraph.getLatestObservation(scope, {
    nodeId: ids.demand,
    type: 'DERIVED',
  });
  check('assumption-visible', demand.ok && demand.value !== null, 'demand was not derived');
  if (demand.ok && demand.value) {
    const explanation = await engine.explain(scope, demand.value.id);
    check('assumption-visible', explanation.ok, 'demand could not be explained');
    if (explanation.ok) {
      const acc = walk(explanation.value);
      const price = acc.leaves.find((l) => l.metricKey === 'AverageSellingPrice');
      check(
        'assumption-visible',
        Boolean(price),
        'the selling price does not appear as a leaf of the demand explanation',
      );
      if (price) {
        check(
          'assumption-visible',
          price.observationType === 'ASSUMPTION',
          `the selling price appears as a ${price.observationType}. A management ` +
            'assumption presented as a measurement is the most dangerous kind of ' +
            'number in a management system',
        );
      }
    }
  }
}

// --------------------- 6: confidence degrades and never exceeds its inputs

for (const [downstream, upstream] of [
  ['demand', 'expRevenue'],
  ['invRequirement', 'demand'],
  ['cogsOpp', 'demand'],
  ['grossMargin', 'cogsOpp'],
  ['cashOpp', 'grossMargin'],
]) {
  const a = await valueGraph.getLatestObservation(scope, { nodeId: ids[downstream], type: 'DERIVED' });
  const b = await valueGraph.getLatestObservation(scope, { nodeId: ids[upstream], type: 'DERIVED' });
  if (!a.ok || !a.value || !b.ok || !b.value) continue;
  check(
    'confidence-degrades',
    a.value.confidence <= b.value.confidence,
    `${downstream} (${a.value.confidence}) is more certain than ${upstream} ` +
      `(${b.value.confidence}), which it derives from`,
  );
  check(
    'confidence-degrades',
    a.value.confidence !== null && a.value.confidence >= 0 && a.value.confidence <= 1,
    `${downstream} reports a confidence outside 0..1`,
  );
}

// -------------------- 7: a stated number explains as stated, not as derived

{
  const stated = await valueGraph.getLatestObservation(scope, {
    nodeId: ids.oppValue,
    type: 'ACTUAL',
  });
  check('stated-not-derived', stated.ok && stated.value !== null, 'the opportunity value is missing');
  if (stated.ok && stated.value) {
    const explanation = await engine.explain(scope, stated.value.id);
    check('stated-not-derived', explanation.ok, 'a stated fact could not be explained');
    if (explanation.ok) {
      check(
        'stated-not-derived',
        explanation.value.derivation === null,
        'a stated fact was given a derivation it does not have',
      );
      check(
        'stated-not-derived',
        explanation.value.inputs.length === 0,
        'a stated fact was given inputs it does not have',
      );
      check(
        'stated-not-derived',
        explanation.value.source?.system === 'memoire',
        'the opportunity value does not say Memoire asserted it',
      );
    }
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:lineage — ok (${written.length} derived values, every one traceable to ` +
      'stated facts and assumptions)',
  );
  process.exit(0);
}

console.error(`verify:lineage — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
