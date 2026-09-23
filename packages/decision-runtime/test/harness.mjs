/**
 * Test harness: the full Phase 1–5 stack in memory, with a controllable clock.
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
  buildMeridianScenarios,
  createInMemoryScenarioStore,
  createScenarioRuntime,
  meridianConstraintsV1,
  meridianStateFrame,
  Q4_2026,
} from '@helm/scenario-runtime';
import { createDecisionRuntime, createInMemoryDecisionStore } from '../src/index.ts';

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

export const expectFail = (r, what) => {
  assert.equal(r.ok, false, `${what}: expected a refusal, got a value`);
  return r.error;
};

/** A clock that ticks one second per read and can be jumped forward. */
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
 * The whole stack for one or more organizations, with the canonical Meridian
 * scenarios built and simulated so decisions have real futures to bind to.
 */
export async function buildStack({ orgs = [ORG_A], simulate = true } = {}) {
  const clock = steppingClock();
  const idGen = seqIdGen('d');
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
  const scenarioStore = createInMemoryScenarioStore({ clock, idGen });
  const scenarios = createScenarioRuntime({
    engine,
    registry,
    valueGraph,
    graphStore,
    store: scenarioStore,
    clock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
  const decisionStore = createInMemoryDecisionStore({ clock, idGen });
  const decisions = createDecisionRuntime({ store: decisionStore, scenarios, clock });

  const fork = { effectiveAsOf: EFFECTIVE, recordedThrough: clock.now().toISOString(), policy: 'SOURCE_TRUTH' };

  const scenarioIdsByOrg = {};
  const runIdsByOrg = {};
  if (simulate) {
    for (const orgId of orgs) {
      const s = scopeFor(orgId);
      const built = unwrap(
        await buildMeridianScenarios(scenarios, s, nodeIdsByOrg[orgId], { fork }),
        'canonical scenarios',
      );
      const ids = {};
      const runs = {};
      for (const [key, { scenario }] of Object.entries(built)) {
        ids[key] = scenario.id;
        const run = unwrap(await scenarios.execute(s, scenario.id), `simulate ${key}`);
        runs[key] = run.run.id;
      }
      scenarioIdsByOrg[orgId] = ids;
      runIdsByOrg[orgId] = runs;
    }
  }

  return {
    clock,
    ontology,
    graphStore,
    valueGraph,
    engine,
    registry,
    scenarios,
    scenarioStore,
    decisions,
    decisionStore,
    fork,
    ids: nodeIdsByOrg[orgs[0]],
    nodeIdsByOrg,
    scenarioIds: scenarioIdsByOrg[orgs[0]] ?? {},
    scenarioIdsByOrg,
    runIds: runIdsByOrg[orgs[0]] ?? {},
    baselineOf: async (s) => unwrap(await scenarios.executeBaseline(s, { fork, periods: [Q4_2026] }), 'baseline'),
  };
}

/** The evaluation of one criterion against one alternative. */
export const evalOf = (evaluations, criterionKey, alternativeLabelPart) =>
  evaluations.find(
    (e) => e.criterionKey === criterionKey && e.alternativeLabel.includes(alternativeLabelPart),
  );
