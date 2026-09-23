/**
 * The Phase 1–5 stack, in memory, for the decision contracts.
 *
 * Shared by verify:decision-lineage, verify:decision-immutability and
 * verify:decision-scenario-binding so three contracts do not each carry a
 * hundred lines of identical wiring. It builds nothing a contract asserts on:
 * every claim still lives in the script that makes it.
 */

import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { buildSeedRegistry } from '@helm/ontology';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import {
  buildCanonicalScenarioExtension,
  buildCanonicalValueChain,
  buildSeedValueRegistry,
  createInMemoryValueGraph,
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
} from '@helm/scenario-runtime';
import { createDecisionRuntime, createInMemoryDecisionStore } from '@helm/decision-runtime';

export const unwrap = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} — ${r.error.message}`);
  return r.value;
};

export const expectFail = (r, what) => {
  if (r.ok) throw new Error(`${what}: expected a refusal, got a value`);
  return r.error;
};

export const ORG_A = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
export const ORG_B = asOrgId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
export const scopeFor = (orgId) => ({
  orgId,
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});

export async function buildDecisionStack({ orgs = [ORG_A] } = {}) {
  let t = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = { now: () => new Date((t += 1000)), peek: () => new Date(t), jump: (ms) => { t += ms; } };
  const idGen = seqIdGen('vd');

  const ontology = buildSeedRegistry();
  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const metrics = buildSeedValueRegistry();
  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });

  const nodeIdsByOrg = {};
  for (const orgId of orgs) {
    const s = scopeFor(orgId);
    unwrap(await buildCanonicalScenario(graphStore, s), 'entity graph');
    const chain = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, s), 'value chain');
    const ext = unwrap(await buildCanonicalScenarioExtension(valueGraph, graphStore, s, chain.nodeIds), 'extension');
    nodeIdsByOrg[orgId] = { ...chain.nodeIds, ...ext.nodeIds };
  }

  const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, metrics), 'registry');
  const engine = unwrap(
    createPropagationEngine({
      registry,
      valueGraph,
      graphStore,
      ontology,
      store: createInMemoryCalculationStore({ clock, idGen }),
      clock,
    }),
    'engine',
  );
  const scenarios = createScenarioRuntime({
    engine,
    registry,
    valueGraph,
    graphStore,
    store: createInMemoryScenarioStore({ clock, idGen }),
    clock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
  const decisions = createDecisionRuntime({
    store: createInMemoryDecisionStore({ clock, idGen }),
    scenarios,
    clock,
  });

  const fork = {
    effectiveAsOf: '2026-09-19T12:00:00.000Z',
    recordedThrough: clock.now().toISOString(),
    policy: 'SOURCE_TRUTH',
  };

  const scenarioIdsByOrg = {};
  for (const orgId of orgs) {
    const s = scopeFor(orgId);
    const built = unwrap(await buildMeridianScenarios(scenarios, s, nodeIdsByOrg[orgId], { fork }), 'canonical scenarios');
    const ids = {};
    for (const [key, { scenario }] of Object.entries(built)) {
      ids[key] = scenario.id;
      unwrap(await scenarios.execute(s, scenario.id), `simulate ${key}`);
    }
    scenarioIdsByOrg[orgId] = ids;
  }

  return {
    clock,
    graphStore,
    valueGraph,
    engine,
    scenarios,
    decisions,
    fork,
    scope: scopeFor(orgs[0]),
    scenarioIds: scenarioIdsByOrg[orgs[0]],
    scenarioIdsByOrg,
    nodeIdsByOrg,
  };
}
