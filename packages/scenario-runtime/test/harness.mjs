/**
 * Test harness: the full Phase 1–4 stack, in memory, with a controllable clock.
 *
 * Not a test file itself (no `.test.` in the name), so the runner only loads
 * it through the suites that import it.
 */

import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  createInMemoryValueGraph,
  buildSeedValueRegistry,
  buildCanonicalValueChain,
  buildCanonicalScenarioExtension,
} from '@helm/value-graph';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  meridianValueModelV1_1,
} from '@helm/propagation-engine';
import {
  createInMemoryScenarioStore,
  createScenarioRuntime,
  meridianConstraintsV1,
  meridianStateFrame,
} from '../src/index.ts';

export const ORG_A = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
export const ORG_B = asOrgId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
export const scopeFor = (orgId) => ({
  orgId,
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});
export const scope = scopeFor(ORG_A);

/** The business instant the canonical baseline is taken at. */
export const EFFECTIVE = '2026-09-19T12:00:00.000Z';

export const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

/**
 * A clock that ticks one second per read from 08:00 on 19 Sep, and can be
 * jumped forward — which is how "Finance files a forecast at T2" is staged.
 */
export function steppingClock(startIso = '2026-09-19T08:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date((t += 1000)),
    jump: (ms) => {
      t += ms;
    },
    peek: () => new Date(t),
  };
}

/**
 * Builds the stack for one or more organizations. Every organization gets the
 * canonical graph, value chain and scenario extension; ids differ per org.
 */
export async function buildStack({ orgs = [ORG_A] } = {}) {
  const clock = steppingClock();
  const idGen = seqIdGen('s');
  const ontology = buildSeedRegistry();
  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const metrics = buildSeedValueRegistry();
  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });

  const nodeIdsByOrg = {};
  for (const orgId of orgs) {
    const s = scopeFor(orgId);
    unwrap(await buildCanonicalScenario(graphStore, s), 'entity graph');
    const chain = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, s), 'value chain');
    const ext = unwrap(
      await buildCanonicalScenarioExtension(valueGraph, graphStore, s, chain.nodeIds),
      'scenario extension',
    );
    nodeIdsByOrg[orgId] = { ...chain.nodeIds, ...ext.nodeIds };
  }

  const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, metrics), 'registry');
  const calcStore = createInMemoryCalculationStore({ clock, idGen });
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store: calcStore, clock }),
    'engine',
  );
  const store = createInMemoryScenarioStore({ clock, idGen });
  const runtime = createScenarioRuntime({
    engine,
    registry,
    valueGraph,
    graphStore,
    store,
    clock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
  // The fork every canonical test starts from: business time 19 Sep noon,
  // knowledge through "now" (after the fixtures were recorded).
  const fork = { effectiveAsOf: EFFECTIVE, recordedThrough: clock.now().toISOString(), policy: 'SOURCE_TRUTH' };
  return {
    runtime,
    engine,
    valueGraph,
    graphStore,
    store,
    calcStore,
    clock,
    registry,
    fork,
    ids: nodeIdsByOrg[orgs[0]],
    nodeIdsByOrg,
  };
}

/** The value of one node in one period of a future state, or undefined. */
export function valueOf(state, nodeId, periodKeyText) {
  return state.values.find(
    (v) => v.nodeId === nodeId && (periodKeyText === undefined || keyOf(v.period) === periodKeyText),
  );
}

export function keyOf(p) {
  const d = new Date(p.start);
  if (p.grain === 'QUARTER') return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return `${p.start}..${p.end}`;
}
