/**
 * verify:calculation-graph — the executable dependency graph is sound.
 *
 *   1. It is acyclic, and a circular model is refused at construction with a
 *      message that names the loop.
 *   2. Its topological order is deterministic and total.
 *   3. Every metric a calculation reads is either produced by another
 *      calculation or is a declared source fact — nothing is assumed.
 *   4. Incremental propagation is sound: the downstream set of a change is
 *      exactly the metrics that transitively depend on it, no more.
 *   5. The VALUE graph and the CALCULATION graph are distinguished: a semantic
 *      dependency with no formula behind it is a legitimate, visible gap.
 */

import { buildSeedRegistry } from '../packages/ontology/src/index.ts';
import { asOrgId, asUserId, seqIdGen, ok } from '../packages/shared/src/index.ts';
import { createInMemoryGraphStore } from '../packages/graph-store/src/inMemory.ts';
import { buildCanonicalScenario } from '../packages/graph-store/src/canonicalScenario.ts';
import { createInMemoryValueGraph } from '../packages/value-graph/src/inMemory.ts';
import { buildSeedValueRegistry } from '../packages/value-graph/src/registry.ts';
import { buildCanonicalValueChain } from '../packages/value-graph/src/canonicalValueChain.ts';
import { createCalculationRegistry } from '../packages/propagation-engine/src/registry.ts';
import {
  buildDependencyGraph,
  downstreamOf,
} from '../packages/propagation-engine/src/dependencyGraph.ts';
import { createPropagationEngine } from '../packages/propagation-engine/src/engine.ts';
import { createInMemoryCalculationStore } from '../packages/propagation-engine/src/inMemoryStore.ts';
import { meridianValueModelV1 } from '../packages/propagation-engine/src/meridianValueModelV1.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const metrics = buildSeedValueRegistry();
const registryResult = createCalculationRegistry(meridianValueModelV1, metrics);
if (!registryResult.ok) {
  console.error(`verify:calculation-graph — registry invalid: ${registryResult.error.message}`);
  process.exit(1);
}
const registry = registryResult.value;

// ------------------------------------------------------- 1: acyclic

const graphResult = buildDependencyGraph(registry);
check(
  'acyclic',
  graphResult.ok,
  `the Meridian model has a cycle: ${graphResult.ok ? '' : graphResult.error.message}`,
);

// And a genuinely circular model is refused, with the loop named.
const circular = [
  {
    key: 'loop_a',
    version: '1.0.0',
    name: 'Loop A',
    description: 'A deliberately circular definition used to prove the cycle check.',
    rationale: 'Exists only so the cycle detector can be shown to reject a loop it must reject.',
    owner: 'Architecture',
    status: 'ACTIVE',
    effectiveFrom: '2026-10-01',
    outputMetricKey: 'CashImpact',
    outputUnit: 'currency',
    scopeCompatibility: null,
    definitionConfidence: 1,
    expression: 'gross_margin',
    inputs: [
      {
        name: 'gross_margin',
        metricKey: 'GrossMargin',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        description: 'Gross margin in currency for this subject.',
      },
    ],
    compute: (_ctx, i) => ok(i.gross_margin),
  },
  {
    key: 'loop_b',
    version: '1.0.0',
    name: 'Loop B',
    description: 'The other half of the deliberately circular pair.',
    rationale: 'Exists only so the cycle detector can be shown to reject a loop it must reject.',
    owner: 'Architecture',
    status: 'ACTIVE',
    effectiveFrom: '2026-10-01',
    outputMetricKey: 'GrossMargin',
    outputUnit: 'currency',
    scopeCompatibility: null,
    definitionConfidence: 1,
    expression: 'cash_impact',
    inputs: [
      {
        name: 'cash_impact',
        metricKey: 'CashImpact',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        description: 'Cash impact of this subject, in currency.',
      },
    ],
    compute: (_ctx, i) => ok(i.cash_impact),
  },
];
const circularRegistry = createCalculationRegistry(circular, metrics);
if (!circularRegistry.ok) {
  fail('acyclic', 'the circular fixture was rejected by the registry, so it proved nothing');
} else {
  const circularGraph = buildDependencyGraph(circularRegistry.value);
  check('acyclic', !circularGraph.ok, 'a circular model was accepted');
  if (!circularGraph.ok) {
    check(
      'acyclic',
      circularGraph.error.code === 'calculation.cycle_detected',
      `a cycle was reported as ${circularGraph.error.code}`,
    );
    check(
      'acyclic',
      /GrossMargin/.test(circularGraph.error.message) &&
        /CashImpact/.test(circularGraph.error.message),
      'the cycle error does not name the loop, so nobody could fix it',
    );
  }
}

if (!graphResult.ok) {
  console.error(`verify:calculation-graph — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
  process.exit(1);
}
const graph = graphResult.value;

// ------------------------------------------- 2: deterministic total order

const again = buildDependencyGraph(registry);
check(
  'determinism',
  again.ok && JSON.stringify(again.value.order) === JSON.stringify(graph.order),
  'the topological order differs between two builds of the same model — a trace ' +
    'built on it could not be reproduced',
);

// Ordering is a real topological sort: nothing precedes what it depends on.
const position = new Map(graph.order.map((m, i) => [m, i]));
for (const calc of registry.active()) {
  for (const input of calc.inputs) {
    if (!position.has(input.metricKey)) continue;
    check(
      'ordering',
      position.get(input.metricKey) < position.get(calc.outputMetricKey),
      `${calc.key} is ordered before its input "${input.metricKey}"`,
    );
  }
}

// ---------------------------------------- 3: every input is accounted for

const produced = new Set(registry.active().map((c) => c.outputMetricKey));
for (const calc of registry.active()) {
  for (const input of calc.inputs) {
    const isDerived = produced.has(input.metricKey);
    const isSourceFact = graph.roots.includes(input.metricKey);
    check(
      'inputs-accounted',
      isDerived || isSourceFact,
      `${calc.key} reads "${input.metricKey}", which is neither calculated nor a ` +
        'declared source fact',
    );
  }
}
for (const root of graph.roots) {
  check(
    'inputs-accounted',
    !produced.has(root),
    `"${root}" is listed as a source fact but is also calculated`,
  );
}

// ------------------------------------ 4: incremental propagation is sound

/** Transitive dependents, computed independently of the implementation. */
function expectedDownstream(startMetrics) {
  const consumersOf = new Map();
  for (const calc of registry.active()) {
    for (const input of calc.inputs) {
      const list = consumersOf.get(input.metricKey) ?? [];
      list.push(calc.outputMetricKey);
      consumersOf.set(input.metricKey, list);
    }
  }
  const seen = new Set();
  const queue = [...startMetrics];
  while (queue.length > 0) {
    const m = queue.shift();
    for (const next of consumersOf.get(m) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

for (const start of [
  ['UnitCost'],
  ['OpportunityProbability'],
  ['AverageSellingPrice'],
  ['UnitCost', 'OpportunityProbability'],
]) {
  const actual = new Set(downstreamOf(graph, start).filter((m) => produced.has(m)));
  const expected = expectedDownstream(start);
  for (const m of expected) {
    check(
      'incremental',
      actual.has(m),
      `a change to ${start.join(' + ')} should reach "${m}" and does not`,
    );
  }
  for (const m of actual) {
    check(
      'incremental',
      expected.has(m),
      `a change to ${start.join(' + ')} reaches "${m}", which does not depend on it — ` +
        'recalculating an independent branch is how a dependency model becomes a ' +
        'full refresh with extra steps',
    );
  }
}

// The specific claim the phase rests on: cost does not move revenue.
const costDownstream = new Set(downstreamOf(graph, ['UnitCost']));
check(
  'incremental',
  !costDownstream.has('ExpectedRevenue') && !costDownstream.has('DemandQuantity'),
  'a unit cost change reaches expected revenue or demand. Neither depends on cost, ' +
    'and a model that recalculates them anyway is not a dependency model',
);

// ------------------------- 5: value links and calculation edges are distinct

let tick = 0;
const base = Date.parse('2026-09-19T08:00:00.000Z');
const clock = { now: () => new Date(base + (tick += 1) * 1000) };
const idGen = seqIdGen('cg');
const ontology = buildSeedRegistry();
const scope = {
  orgId: asOrgId('11111111-1111-4111-8111-111111111111'),
  actorId: asUserId('aaaa1111-1111-4111-8111-111111111111'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
const entityGraph = await buildCanonicalScenario(graphStore, scope);
if (!entityGraph.ok) fail('fixture', `entity graph: ${entityGraph.error.message}`);

const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
const chain = await buildCanonicalValueChain(valueGraph, graphStore, scope);
if (!chain.ok) fail('fixture', `value chain: ${chain.error.message}`);

if (chain.ok) {
  const store = createInMemoryCalculationStore({ clock, idGen });
  const engineResult = createPropagationEngine({
    registry,
    valueGraph,
    graphStore,
    ontology,
    store,
    clock,
  });
  check('fixture', engineResult.ok, 'the engine could not be built over the canonical graph');

  if (engineResult.ok) {
    const plan = await engineResult.value.planPropagation(scope, {
      fromMetricKeys: ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'],
      asOf: new Date('2026-09-19T12:00:00.000Z'),
      horizon: 'quarter',
    });
    check('fixture', plan.ok, `planning failed: ${plan.ok ? '' : plan.error.message}`);

    if (plan.ok) {
      // There ARE value links HELM cannot compute — service level, risk scores,
      // strategic alignment. That is the point: a semantic dependency without a
      // formula is a visible gap, not a silent zero.
      const links = await valueGraph.findValueLinks(scope, { limit: 500 });
      check('fixture', links.ok, 'value links could not be read');
      if (links.ok) {
        const computedMetrics = produced;
        const nodes = await valueGraph.findValueNodes(scope, { limit: 500 });
        const byId = new Map((nodes.ok ? nodes.value : []).map((n) => [n.id, n]));
        const semanticOnly = links.value.filter((l) => {
          const target = byId.get(l.targetNodeId);
          return target && !computedMetrics.has(target.metricKey);
        });
        check(
          'graphs-distinct',
          semanticOnly.length > 0,
          'every value link has a calculation behind it, which would mean the value ' +
            'graph had been quietly reduced to the calculation graph. A dependency ' +
            'HELM cannot yet compute must remain visible',
        );
      }

      // And the reverse: the plan declares what it cannot compute rather than
      // omitting it silently.
      check(
        'graphs-distinct',
        plan.value.uncomputable.length > 0,
        'the plan declares nothing uncomputable, so a reader cannot tell the ' +
          'difference between "not applicable" and "forgotten"',
      );
      for (const u of plan.value.uncomputable) {
        check(
          'graphs-distinct',
          u.reason.length > 20,
          `an uncomputable node gives no usable reason: "${u.reason}"`,
        );
      }
    }
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    `verify:calculation-graph — ok (${graph.order.length} metrics ordered, ` +
      `${graph.roots.length} source facts, acyclic, incremental)`,
  );
  process.exit(0);
}

console.error(`verify:calculation-graph — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
