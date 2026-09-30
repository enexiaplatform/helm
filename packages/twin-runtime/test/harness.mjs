/**
 * Test harness: the full Phase 1–6 stack in memory (the authority harness),
 * plus the trusted authority service and the twin runtime over it.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { meridianConstraintsV1 } from '@helm/scenario-runtime';
import { MERIDIAN_DEMO_USERS, createAuthorityRuntime, createTrustedAuthorityService } from '@helm/authority-runtime';
import { createDecisionRuntime } from '@helm/decision-runtime';
import { createInMemoryTwinStore, createTwinRuntime, runMeridianTwinStory } from '../src/index.ts';
import { ADMIN, ORG_A, buildGovernanceStack, unwrap } from '../../authority-runtime/test/harness.mjs';

export { ADMIN, ORG_A, unwrap };
export { expectFail } from '../../authority-runtime/test/harness.mjs';
export const USERS = MERIDIAN_DEMO_USERS;
export const UNITS = { vietnam: 'unit-vn', pharma: 'unit-vn-pharma', industrial: 'unit-vn-industrial' };

/** Membership of the demo units, for visibility checks. */
export const MEMBERSHIP = {
  [MERIDIAN_DEMO_USERS.countryGM]: ['unit-vn'],
  [MERIDIAN_DEMO_USERS.commercialDirector]: ['unit-vn-commercial'],
  [MERIDIAN_DEMO_USERS.financeDirector]: ['unit-vn-finance'],
  [MERIDIAN_DEMO_USERS.pharmaAnalyst]: ['unit-vn-pharma'],
  [MERIDIAN_DEMO_USERS.industrialHead]: ['unit-vn-industrial'],
};

export async function buildTwinStack() {
  const stack = await buildGovernanceStack();
  const trustedRuntime = createAuthorityRuntime({
    store: stack.authorityStore,
    decisions: stack.decisionStore,
    scenarios: stack.scenarios,
    graph: stack.graph,
    clock: stack.clock,
    evaluator: { kind: 'TRUSTED_SERVICE', host: 'in-process' },
  });
  const trusted = createTrustedAuthorityService({
    runtime: trustedRuntime,
    store: stack.authorityStore,
    decisions: stack.decisionStore,
    scenarios: stack.scenarios,
    engine: stack.engine,
    registry: stack.registry,
    valueGraph: stack.valueGraph,
    membershipOf: async (userId, orgId) => ({ ok: true, value: orgId === ORG_A ? { orgRole: userId === ADMIN ? 'admin' : 'member', memberUnitIds: MEMBERSHIP[userId] ?? [] } : null }),
    callerCanSeeDecision: async () => ({ ok: true, value: true }),
  });
  const sources = {
    graph: stack.graph,
    valueGraph: stack.valueGraph,
    engine: stack.engine,
    registry: stack.registry,
    scenarios: stack.scenarios,
    decisions: stack.decisionStore,
    authority: stack.authority,
    authorityStore: stack.authorityStore,
    constraints: meridianConstraintsV1,
  };
  const twinStore = createInMemoryTwinStore({ clock: stack.clock, idGen: seqIdGen('tw') });
  const twin = createTwinRuntime({ store: twinStore, sources, clock: stack.clock });
  const decisions = createDecisionRuntime({ store: stack.decisionStore, scenarios: stack.scenarios, clock: stack.clock });
  return { ...stack, decisionsRuntime: decisions, trusted, sources, twinStore, twin };
}

/** The canonical story over a fresh stack. */
export async function buildStory({ stack = null, hooks } = {}) {
  const s = stack ?? (await buildTwinStack());
  const story = unwrap(
    await runMeridianTwinStory({
      admin: s.scope,
      as: s.as,
      graph: s.graph,
      valueGraph: s.valueGraph,
      scenarios: s.scenarios,
      decisions: s.decisionsRuntime,
      authority: s.authority,
      trusted: s.trusted,
      twin: s.twin,
      governance: s.governance,
      doaV1: s.doa.policy,
      occupancies: s.occupancies,
      scenarioIds: s.scenarioIds,
      nodeIds: s.nodeIds,
      advanceTo: (iso) => s.clock.jumpTo(iso),
      units: UNITS,
      hooks,
    }),
    'twin story',
  );
  return { ...s, story };
}

export const item = (snapshot, key) => snapshot.items.find((i) => i.key === key) ?? null;
export const itemsOf = (snapshot, kind) => snapshot.items.filter((i) => i.kind === kind);
export const valueKey = (nodeId, layer, period = '2026-Q4', suffix = '') => `value:${nodeId}:${layer}${period ? `:${period}` : ''}${suffix}`;
