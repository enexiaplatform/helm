/**
 * Test harness: the Phase 1–8 stack with the twin and causal stories (the
 * causal harness), plus the genome over it and the DEMO episodes.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { createInMemoryGenomeStore, createManagementGenome, runMeridianGenomeStory } from '../src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap, at } from '../../causal-runtime/test/harness.mjs';
import { buildCounterfactualStack } from '../../counterfactual-runtime/test/harness.mjs';
import { runMeridianCounterfactualStory } from '../../counterfactual-runtime/src/index.ts';

export { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap, at };

export async function buildGenomeStack(existing = null) {
  const s = existing ?? (await buildCounterfactualStack());
  const genomeStore = createInMemoryGenomeStore({ clock: s.clock, idGen: seqIdGen('gn') });
  const genome = createManagementGenome({
    store: genomeStore,
    clock: s.clock,
    sources: { graph: s.graph, decisions: s.decisionStore, scenarios: s.scenarios, authority: s.authority, twin: s.twin, causal: s.causal, counterfactual: s.counterfactual },
  });
  return { ...s, genomeStore, genome };
}

/** The canonical genome story over a fresh stack. `shareWith` shares each demonstration decision with those units. */
export async function buildGenomeStory(opts = {}) {
  const s = await buildGenomeStack(opts.existing ?? null);
  const e = s.governance.entities;
  const c = s.causalStory.claims;
  const genomeStory = unwrap(
    await runMeridianGenomeStory({
      genome: s.genome,
      admin: s.scope,
      as: s.as,
      users: USERS,
      decisions: s.decisionsRuntime,
      decisionStore: s.decisionStore,
      authority: s.authority,
      scenarioIds: s.scenarioIds,
      entities: { buPharma: e.buPharma, rohto: e.rohto, buThPharma: e.buThPharma, vn: e.vn },
      twin: { decisionId: s.story.decisionId, commitmentId: s.story.commitmentId, S0: s.story.S0.snapshot.id, CF1: s.story.CF1.snapshot.id, S2: s.story.S2.snapshot.id },
      causalClaimIds: [c.C3.claim.id, c.H1.claim.id, c.H2.claim.id, c.H3.claim.id],
      shareWith: opts.shareWith,
      advanceTo: (iso) => s.clock.jumpTo(iso),
    }),
    'genome story',
  );
  return { ...s, genomeStory };
}

/**
 * The genome story, then the counterfactual review of the same decision, then the Rohto episode referencing its first case —
 * the order the demonstration lives it in: a counterfactual comes after the outcome it reviews.
 */
export async function buildGenomeWithCounterfactuals(opts = {}) {
  const s = await buildGenomeStory(opts);
  const e = s.governance.entities;
  const counterfactualStory = unwrap(
    await runMeridianCounterfactualStory({
      counterfactual: s.counterfactual,
      as: s.as,
      users: USERS,
      decisionStore: s.decisionStore,
      scenarios: s.scenarios,
      decisionId: s.story.decisionId,
      anchorSnapshotId: s.story.S0.snapshot.id,
      entities: { buPharma: e.buPharma },
      nodeIds: { oppProbNext: s.nodeIds.oppProbNext, aspProduct: s.nodeIds.aspProduct },
      advanceTo: (iso) => s.clock.jumpTo(iso),
    }),
    'counterfactual story',
  );
  const cf1 = counterfactualStory.cases.CF1.case;
  const bound = unwrap(
    await s.genome.bindRef(s.scope, s.genomeStory.episodes.E1.episode.id, 'COUNTERFACTUAL_CASE', { kind: 'COUNTERFACTUAL_CASE', id: cf1.id, pin: null, label: cf1.title }, 'the expedite question'),
    'bind CF1 to E1',
  );
  return { ...s, counterfactualStory, boundE1: bound };
}
