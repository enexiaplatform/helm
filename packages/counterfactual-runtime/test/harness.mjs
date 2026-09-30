/**
 * Test harness: the Phase 1–8 stack with the twin and causal stories (the
 * causal harness), plus the counterfactual runtime over it and the DEMO
 * counterfactual review.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { createCounterfactualRuntime, createInMemoryCounterfactualStore, runMeridianCounterfactualStory } from '../src/index.ts';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, buildCausalStory, expectFail, unwrap, at } from '../../causal-runtime/test/harness.mjs';

export { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap, at };

export async function buildCounterfactualStack(existing = null) {
  const s = existing ?? (await buildCausalStory());
  const counterfactualStore = createInMemoryCounterfactualStore({ clock: s.clock, idGen: seqIdGen('cf') });
  const counterfactual = createCounterfactualRuntime({
    store: counterfactualStore,
    sources: { decisions: s.decisionStore, scenarios: s.scenarios, twin: s.twin, causal: s.causal },
    clock: s.clock,
  });
  return { ...s, counterfactualStore, counterfactual };
}

/** The alternatives the Rohto decision recorded, by short name. */
export async function rohtoAlternatives(s) {
  const revisions = unwrap(await s.decisionStore.listRevisions(s.scope, s.story.decisionId), 'revisions');
  const all = [];
  for (const r of revisions) all.push(...unwrap(await s.decisionStore.listAlternatives(s.scope, r.id), 'alternatives'));
  const by = (re) => all.find((a) => re.test(a.label));
  return { all, expedite: by(/^A — Expedite/), reallocate: by(/^B — Reallocate/), alternativeProduct: by(/^C — /), delay: by(/^D — /), replace: by(/^E — /) };
}

/** The canonical counterfactual review over a fresh stack. */
export async function buildCounterfactualStory() {
  const s = await buildCounterfactualStack();
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
  return { ...s, counterfactualStory };
}
