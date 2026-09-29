/**
 * Test harness: the full Phase 1–6 stack in memory, with a controllable clock,
 * the Meridian governance graph, occupancies and DOA-2026-04 v1 recorded.
 *
 * Not a test file itself (no `.test.` in the name).
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
} from '@helm/scenario-runtime';
import { buildMeridianDecision, createDecisionRuntime, createInMemoryDecisionStore } from '@helm/decision-runtime';
import {
  MERIDIAN_DEMO_USERS,
  buildCallOffScenario,
  buildMeridianGovernanceGraph,
  createAuthorityRuntime,
  createInMemoryAuthorityStore,
  recordMeridianDoaV1,
  recordMeridianOccupancies,
  scopeAs,
} from '../src/index.ts';

export const ORG_A = asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
export const ORG_B = asOrgId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
export const ADMIN = asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
export const USERS = MERIDIAN_DEMO_USERS;
export const scopeFor = (orgId, actorId = ADMIN) => ({ orgId, actorId, role: 'admin', orgUnitIds: [], functions: [] });

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
    jumpTo: (iso) => {
      const target = Date.parse(iso);
      if (target > t) t = target;
    },
    peek: () => new Date(t),
  };
}

/**
 * The stack for one or more organizations, with the canonical scenarios
 * simulated, the governance graph built, occupancies and DOA v1 recorded, and
 * the Q1 call-off scenario simulated for the direct-authorization proofs.
 */
export async function buildGovernanceStack({ orgs = [ORG_A], policy = true } = {}) {
  const clock = steppingClock();
  const idGen = seqIdGen('g');
  const ontology = buildSeedRegistry();
  const graph = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const metrics = buildSeedValueRegistry();
  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore: graph, clock, idGen });

  const nodeIdsByOrg = {};
  for (const orgId of orgs) {
    const s = scopeFor(orgId);
    unwrap(await buildCanonicalScenario(graph, s), 'entity graph');
    const chain = unwrap(await buildCanonicalValueChain(valueGraph, graph, s), 'value chain');
    const ext = unwrap(await buildCanonicalScenarioExtension(valueGraph, graph, s, chain.nodeIds), 'extension');
    nodeIdsByOrg[orgId] = { ...chain.nodeIds, ...ext.nodeIds };
  }

  const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, metrics), 'registry');
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore: graph, ontology, store: createInMemoryCalculationStore({ clock, idGen }), clock }),
    'engine',
  );
  const scenarios = createScenarioRuntime({
    engine,
    registry,
    valueGraph,
    graphStore: graph,
    store: createInMemoryScenarioStore({ clock, idGen }),
    clock,
    constraints: meridianConstraintsV1,
    stateFrame: meridianStateFrame,
  });
  const decisionStore = createInMemoryDecisionStore({ clock, idGen });
  const decisions = createDecisionRuntime({ store: decisionStore, scenarios, clock });
  const authorityStore = createInMemoryAuthorityStore({ clock, idGen });
  const authority = createAuthorityRuntime({ store: authorityStore, decisions: decisionStore, scenarios, graph, clock });

  const fork = { effectiveAsOf: '2026-09-19T12:00:00.000Z', recordedThrough: clock.now().toISOString(), policy: 'SOURCE_TRUTH' };

  const byOrg = {};
  for (const orgId of orgs) {
    const s = scopeFor(orgId);
    const built = unwrap(await buildMeridianScenarios(scenarios, s, nodeIdsByOrg[orgId], { fork }), 'canonical scenarios');
    const scenarioIds = {};
    for (const [key, { scenario }] of Object.entries(built)) {
      scenarioIds[key] = scenario.id;
      unwrap(await scenarios.execute(s, scenario.id), `simulate ${key}`);
    }
    scenarioIds['call-off'] = unwrap(await buildCallOffScenario(scenarios, s, nodeIdsByOrg[orgId], fork), 'call-off scenario').scenarioId;
    const governance = unwrap(await buildMeridianGovernanceGraph(graph, s), 'governance graph');
    const occupancies = unwrap(await recordMeridianOccupancies(authority, s, governance), 'occupancies');
    const doa = policy ? unwrap(await recordMeridianDoaV1(authority, s, governance), 'DOA v1') : null;
    byOrg[orgId] = { scope: s, scenarioIds, governance, occupancies, doa, nodeIds: nodeIdsByOrg[orgId] };
  }

  const a = byOrg[orgs[0]];
  return {
    clock,
    graph,
    valueGraph,
    engine,
    registry,
    scenarios,
    decisions,
    decisionStore,
    authority,
    authorityStore,
    fork,
    byOrg,
    scope: a.scope,
    scenarioIds: a.scenarioIds,
    governance: a.governance,
    entities: a.governance.entities,
    occupancies: a.occupancies,
    doa: a.doa,
    nodeIds: a.nodeIds,
    as: (userId, orgId = orgs[0]) => scopeAs(byOrg[orgId].scope, userId),
  };
}

/** The canonical Rohto decision, committed by the demo Commercial Director, classified for governance. */
export async function commitCanonical(stack, { classify = true, commit = true } = {}) {
  const cd = stack.as(USERS.commercialDirector);
  const built = unwrap(
    await buildMeridianDecision(stack.decisions, cd, stack.scenarioIds, { commit, committedByLabel: 'Commercial Director Vietnam' }),
    'canonical decision',
  );
  if (classify) {
    unwrap(
      await stack.authority.declareGovernanceProfile(cd, built.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION', note: 'Rohto allocation' }),
      'classify',
    );
  }
  return built;
}
