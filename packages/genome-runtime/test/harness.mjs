/**
 * Test harness: the Phase 1–8 stack with the twin and causal stories (the
 * causal harness), plus the genome over it and the DEMO episodes.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { createInMemoryGenomeStore, createManagementGenome, runMeridianGenomeStory } from '../src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildCausalStory, expectFail, unwrap, at } from '../../causal-runtime/test/harness.mjs';

export { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap, at };

export async function buildGenomeStack(existing = null) {
  const s = existing ?? (await buildCausalStory());
  const genomeStore = createInMemoryGenomeStore({ clock: s.clock, idGen: seqIdGen('gn') });
  const genome = createManagementGenome({
    store: genomeStore,
    clock: s.clock,
    sources: { graph: s.graph, decisions: s.decisionStore, scenarios: s.scenarios, authority: s.authority, twin: s.twin, causal: s.causal },
  });
  return { ...s, genomeStore, genome };
}

/** The canonical genome story over a fresh stack. `shareWith` shares each demonstration decision with those units. */
export async function buildGenomeStory(opts = {}) {
  const s = await buildGenomeStack();
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
