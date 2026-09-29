/**
 * The Phase 1–6 stack, in memory, for the authority contracts.
 *
 * Shared by the verify:authority-* and verify:approval-lineage contracts so
 * they do not each carry the same wiring. It builds nothing a contract
 * asserts on: every claim still lives in the script that makes it.
 */

import { buildMeridianDecision } from '@helm/decision-runtime';
import {
  MERIDIAN_DEMO_USERS,
  buildCallOffScenario,
  buildMeridianGovernanceGraph,
  buildProofDecision,
  createAuthorityRuntime,
  createInMemoryAuthorityStore,
  recordMeridianDoaV1,
  recordMeridianOccupancies,
  scopeAs,
} from '@helm/authority-runtime';
import { createInMemoryDecisionStore, createDecisionRuntime } from '@helm/decision-runtime';
import { buildDecisionStack, unwrap, expectFail } from './decisionStack.mjs';

export { unwrap, expectFail };
export const USERS = MERIDIAN_DEMO_USERS;

export async function buildAuthorityStack() {
  const base = await buildDecisionStack();
  const { clock, scenarios, graphStore: graph, scope } = base;
  // A decision store the authority runtime can read and append the timeline to.
  const decisionStore = createInMemoryDecisionStore({ clock, idGen: { next: (() => { let n = 0; return () => `ad-${++n}`; })() } });
  const decisions = createDecisionRuntime({ store: decisionStore, scenarios, clock });
  const authorityStore = createInMemoryAuthorityStore({ clock, idGen: { next: (() => { let n = 0; return () => `au-${++n}`; })() } });
  const authority = createAuthorityRuntime({ store: authorityStore, decisions: decisionStore, scenarios, graph, clock });

  const nodeIds = base.nodeIdsByOrg[scope.orgId];
  const callOff = unwrap(await buildCallOffScenario(scenarios, scope, nodeIds, base.fork), 'call-off scenario');
  const scenarioIds = { ...base.scenarioIds, 'call-off': callOff.scenarioId };
  const governance = unwrap(await buildMeridianGovernanceGraph(graph, scope), 'governance graph');
  const occupancies = unwrap(await recordMeridianOccupancies(authority, scope, governance), 'occupancies');
  const doa = unwrap(await recordMeridianDoaV1(authority, scope, governance), 'DOA v1');
  const as = (userId) => scopeAs(scope, userId);

  /** The canonical Rohto decision, committed by the demo Commercial Director and classified. */
  const commitCanonical = async () => {
    const cd = as(USERS.commercialDirector);
    const built = unwrap(
      await buildMeridianDecision(decisions, cd, scenarioIds, { committedByLabel: 'Commercial Director Vietnam' }),
      'canonical decision',
    );
    unwrap(await authority.declareGovernanceProfile(cd, built.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION' }), 'classify');
    return built;
  };

  /** A compact decision over one scenario, committed by the Commercial Director. */
  const commitProof = async (scenarioKey, title, declaredSubjects = []) => {
    const cd = as(USERS.commercialDirector);
    const d = unwrap(
      await buildProofDecision(decisions, cd, {
        title,
        managementQuestion: `How should Meridian handle the ${title.toLowerCase()}?`,
        scenarioId: scenarioIds[scenarioKey],
        alternativeLabel: title,
        committedByLabel: 'Commercial Director Vietnam',
      }),
      title,
    );
    unwrap(
      await authority.declareGovernanceProfile(cd, d.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION', declaredSubjects }),
      'classify',
    );
    return d;
  };

  return {
    ...base,
    graph,
    decisions,
    decisionStore,
    authority,
    authorityStore,
    scenarioIds,
    governance,
    entities: governance.entities,
    occupancies,
    doa,
    as,
    commitCanonical,
    commitProof,
  };
}
