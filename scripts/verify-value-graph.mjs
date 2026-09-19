/**
 * verify:value-graph — the value graph holds, and the Phase 2/3 boundary holds.
 *
 * Runs against the in-memory adapter (the contract is adapter-independent).
 *
 *   1. The canonical value chain builds, and builds idempotently.
 *   2. The chain connects opportunity to enterprise value, both directions.
 *   3. Enterprise value is several dimensions, never one score.
 *   4. Traversal is bounded — an unbounded walk is refused.
 *   5. Shared constrained resources are structurally queryable.
 *   6. Tenant isolation cannot be escaped through the value graph.
 *   7. NOTHING COMPUTES: no formula/evaluator in the package, and changing an
 *      upstream observation does not move a downstream one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedRegistry } from '../packages/ontology/src/index.ts';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '../packages/shared/src/index.ts';
import { createInMemoryGraphStore } from '../packages/graph-store/src/inMemory.ts';
import { buildCanonicalScenario } from '../packages/graph-store/src/canonicalScenario.ts';
import { createInMemoryValueGraph } from '../packages/value-graph/src/inMemory.ts';
import { buildSeedValueRegistry } from '../packages/value-graph/src/registry.ts';
import { buildCanonicalValueChain } from '../packages/value-graph/src/canonicalValueChain.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const mkScope = (org, user) => ({
  orgId: asOrgId(org),
  actorId: asUserId(user),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});
const scopeA = mkScope('11111111-1111-4111-8111-111111111111', 'aaaa1111-1111-4111-8111-111111111111');
const scopeB = mkScope('22222222-2222-4222-8222-222222222222', 'bbbb2222-2222-4222-8222-222222222222');

let tick = 0;
const base = Date.parse('2026-09-19T08:00:00.000Z');
const clock = { now: () => new Date(base + (tick += 1) * 1000) };
const idGen = seqIdGen('vv');
const ontology = buildSeedRegistry();

const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
const valueGraph = createInMemoryValueGraph({
  metrics: buildSeedValueRegistry(),
  ontology,
  graphStore,
  clock,
  idGen,
});

// ---------------------------------------- 7a: no calculation in the package

const VALUE_SRC = join(process.cwd(), 'packages', 'value-graph', 'src');
const FORBIDDEN = [
  { re: /\bevaluateFormula\b|\bcompute[A-Z]\w*Value\b|\bpropagate\b/, why: 'a propagation entry point' },
  { re: /\bnew Function\s*\(/, why: 'runtime expression evaluation' },
  { re: /\beval\s*\(/, why: 'eval()' },
  { re: /\bmathjs\b|\bexpr-eval\b/, why: 'an expression evaluation library' },
];
/**
 * Comments and string literals are stripped first: a comment explaining that
 * Phase 2 does NOT propagate must not itself trip the propagation check, and a
 * test name mentioning the word is prose, not code.
 */
const stripNonCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

for (const f of readdirSync(VALUE_SRC)) {
  if (!f.endsWith('.ts')) continue;
  const src = stripNonCode(readFileSync(join(VALUE_SRC, f), 'utf8'));
  for (const { re, why } of FORBIDDEN) {
    if (re.test(src)) {
      fail(
        'phase-boundary',
        `packages/value-graph/src/${f} contains ${why}. Phase 2 represents value; ` +
          'Phase 3 moves it.',
      );
    }
  }
}

// ------------------------------------------------ 1: canonical chain builds

const entityGraph = await buildCanonicalScenario(graphStore, scopeA);
if (!entityGraph.ok) {
  fail('canonical-build', `entity graph: ${entityGraph.error.code} ${entityGraph.error.message}`);
}

const built = await buildCanonicalValueChain(valueGraph, graphStore, scopeA);
if (!built.ok) {
  fail('canonical-build', `${built.error.code}: ${built.error.message}`);
} else {
  const { nodeIds, scenarioIds, nodeCount, linkCount, observationCount } = built.value;
  check('canonical-build', nodeCount >= 30, `only ${nodeCount} value nodes`);
  check('canonical-build', linkCount >= 35, `only ${linkCount} value links`);
  check('canonical-build', observationCount >= 35, `only ${observationCount} observations`);

  // idempotency
  const again = await buildCanonicalValueChain(valueGraph, graphStore, scopeA);
  check('idempotency', again.ok, 'second build failed');
  const nodes = await valueGraph.findValueNodes(scopeA, { limit: 500 });
  check(
    'idempotency',
    nodes.ok && nodes.value.length === nodeCount,
    `rebuild changed node count: ${nodes.ok ? nodes.value.length : '?'} vs ${nodeCount}`,
  );

  // ------------------------------- 2: the chain connects end to end
  const down = await valueGraph.getValueChain(scopeA, {
    start: [nodeIds.oppValue],
    maxDepth: 8,
    direction: 'downstream',
  });
  if (!down.ok) {
    fail('value-chain', `${down.error.code}: ${down.error.message}`);
  } else {
    const reached = new Set(down.value.nodes.map((n) => n.node.id));
    for (const handle of [
      'expRevenue', 'demand', 'invRequirement', 'invGap', 'serviceLevel',
      'invValue', 'workingCapital', 'grossMargin', 'evCash', 'evMargin',
    ]) {
      check('value-chain', reached.has(nodeIds[handle]), `chain does not reach ${handle}`);
    }
    for (const n of down.value.nodes) {
      check(
        'confidence-range',
        n.pathConfidence >= 0 && n.pathConfidence <= 1,
        `path confidence out of range at ${n.node.label}: ${n.pathConfidence}`,
      );
    }
  }

  const up = await valueGraph.findUpstreamValueNodes(scopeA, nodeIds.evCash, 8);
  if (up.ok) {
    const reached = new Set(up.value.nodes.map((n) => n.node.id));
    check('value-chain', reached.has(nodeIds.oppValue), 'cash does not trace back to the opportunity');
  } else {
    fail('value-chain', `upstream: ${up.error.code}`);
  }

  // ------------------------- 3: enterprise value stays multi-dimensional
  const evNodes = ['evCash', 'evMargin', 'evService', 'evRisk', 'evStrategic', 'evWorkingCapital'];
  const dims = new Set();
  for (const handle of evNodes) {
    const n = await valueGraph.getValueNode(scopeA, nodeIds[handle]);
    if (!n.ok || !n.value) {
      fail('multi-dimensional', `missing enterprise value node ${handle}`);
      continue;
    }
    const m = await valueGraph.getMetricDefinition(scopeA, n.value.metricKey);
    if (m.ok && m.value) dims.add(m.value.dimension);
  }
  check(
    'multi-dimensional',
    dims.size >= 5,
    `enterprise value spans only ${dims.size} dimensions — it must not collapse to one`,
  );

  // ------------------------------------------ 4: bounded traversal
  const unbounded = await valueGraph.getValueChain(scopeA, {
    start: [nodeIds.oppValue],
    maxDepth: 99,
    direction: 'both',
  });
  check(
    'bounded-traversal',
    !unbounded.ok && unbounded.error.code === 'value.depth_exceeded',
    'an excessive maxDepth was accepted instead of refused',
  );

  // ------------------------------------------------ 5: contention
  const contention = await valueGraph.findContention(scopeA);
  if (!contention.ok) {
    fail('contention', contention.error.code);
  } else {
    const shared = contention.value.find((c) => c.node.id === nodeIds.availOwn);
    check('contention', Boolean(shared), 'company stock is not recognised as contended');
    check(
      'contention',
      shared && shared.claimants.length >= 2,
      'fewer than two claimants on the shared inventory position',
    );
  }

  // --------------------------------- 7b: the phase boundary holds
  const beforeRev = await valueGraph.getLatestObservation(scopeA, {
    nodeId: nodeIds.expRevenue,
    type: 'FORECAST',
  });
  await valueGraph.recordObservation(scopeA, {
    nodeId: nodeIds.oppProb,
    observationType: 'ACTUAL',
    numericValue: 0.9,
    unitType: 'ratio',
    effectiveAt: asValidTime('2026-09-25T00:00:00.000Z'),
    sourceSystem: 'memoire',
  });
  const afterRev = await valueGraph.getLatestObservation(scopeA, {
    nodeId: nodeIds.expRevenue,
    type: 'FORECAST',
  });
  check(
    'phase-boundary',
    beforeRev.ok && afterRev.ok && beforeRev.value?.numericValue === afterRev.value?.numericValue,
    'a downstream observation changed when an upstream one did — that is Phase 3',
  );

  // Scenario observations must stay out of reality.
  const reality = await valueGraph.getObservations(scopeA, {
    nodeId: nodeIds.grossMarginPct,
    scenarioEntityId: null,
  });
  check(
    'scenario-separation',
    reality.ok && reality.value.every((o) => o.scenarioEntityId === null),
    'a scenario observation leaked into reality',
  );
  check(
    'scenario-separation',
    Object.keys(scenarioIds).length >= 2,
    'the canonical chain should carry at least two scenarios',
  );

  // ------------------------------------------- 6: tenant isolation
  const bEntity = await buildCanonicalScenario(graphStore, scopeB);
  check('isolation-setup', bEntity.ok, 'could not seed org B entities');
  if (bEntity.ok) {
    const bValue = await buildCanonicalValueChain(valueGraph, graphStore, scopeB);
    check('isolation-setup', bValue.ok, 'could not seed org B value chain');

    const aNodes = await valueGraph.findValueNodes(scopeA, { limit: 500 });
    check(
      'tenant-isolation',
      aNodes.ok && aNodes.value.every((n) => n.orgId === scopeA.orgId),
      'org A listing returned foreign-org value nodes',
    );
    check(
      'tenant-isolation',
      aNodes.ok && aNodes.value.length === nodeCount,
      `org A sees ${aNodes.ok ? aNodes.value.length : '?'} nodes, expected ${nodeCount}`,
    );

    if (bValue.ok) {
      const crossGet = await valueGraph.getValueNode(scopeA, bValue.value.nodeIds.evCash);
      check(
        'tenant-isolation',
        crossGet.ok && crossGet.value === null,
        'org A read an org B value node by id',
      );

      const crossLink = await valueGraph.createValueLink(scopeA, {
        linkType: 'DRIVES',
        sourceNodeId: nodeIds.expRevenue,
        targetNodeId: bValue.value.nodeIds.demand,
        sourceSystem: 'helm',
      });
      check('tenant-isolation', !crossLink.ok, 'a value link spanned two organizations');

      const crossChain = await valueGraph.getValueChain(scopeA, {
        start: [bValue.value.nodeIds.oppValue],
        maxDepth: 5,
        direction: 'both',
      });
      check(
        'tenant-isolation',
        crossChain.ok && crossChain.value.nodes.length === 0,
        'traversal from a foreign-org node returned nodes',
      );
    }
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log(
    'verify:value-graph — ok (canonical chain, multi-dimensional value, contention, ' +
      'tenant isolation, no propagation)',
  );
  process.exit(0);
}

console.error(`verify:value-graph — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
