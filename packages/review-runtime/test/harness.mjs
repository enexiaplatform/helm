/**
 * Test harness: the whole enterprise story, lived once, with the two canonical
 * management reviews woven through it — Review 1 INSIDE the twin story (opening
 * with its first snapshot, closing once the commitment is governed), Review 2 after
 * the causal claims, the genome and the counterfactual review exist.
 *
 * Not a test file itself (no `.test.` in the name).
 */

import { seqIdGen } from '@helm/shared';
import { createInMemoryReviewStore, createMeridianReviewDriver, createReviewRuntime } from '../src/index.ts';
import { buildTwinStack, buildStory } from '../../twin-runtime/test/harness.mjs';
import { buildCausalStack, buildCausalStory } from '../../causal-runtime/test/harness.mjs';
import { buildCounterfactualStack } from '../../counterfactual-runtime/test/harness.mjs';
import { buildGenomeWithCounterfactuals } from '../../genome-runtime/test/harness.mjs';
import { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap } from '../../causal-runtime/test/harness.mjs';

export { ADMIN, DEMO_UNITS, MEMBERSHIP, UNITS, USERS, expectFail, unwrap };

/** A review runtime over a twin stack, before any story has run. Optional sources are attached later, as they come to exist. */
export async function buildReviewStack(base = null) {
  const s = base ?? (await buildTwinStack());
  const reviewStore = createInMemoryReviewStore({ clock: s.clock, idGen: seqIdGen('rv') });
  const sources = { twin: s.twin, decisions: s.decisionStore };
  const review = createReviewRuntime({ store: reviewStore, sources, clock: s.clock });
  const gm = s.as(USERS.countryGM);
  const driver = createMeridianReviewDriver({ review, decisions: s.decisionStore, gm, periods: ['2026-Q4'], vietnamUnitId: UNITS.vietnam, advanceTo: (iso) => s.clock.jumpTo(iso) });
  return { ...s, reviewStore, reviewSources: sources, review, gm, driver };
}

/** Everything, in the order it happened: Review 1, then the outcome, the causal claims, the genome, the counterfactual review, then Review 2. */
export async function buildReviewStory() {
  const r = await buildReviewStack();
  const withStory = await buildStory({ stack: r, hooks: r.driver.hooks });
  const causal = await buildCausalStory(await buildCausalStack(withStory));
  const full = await buildGenomeWithCounterfactuals({ existing: await buildCounterfactualStack(causal) });
  full.reviewSources.causal = full.causal;
  full.reviewSources.genome = full.genome;
  full.reviewSources.counterfactual = full.counterfactual;

  const outcome = unwrap(await full.decisionStore.listOutcomeReviews(full.scope, full.story.decisionId), 'outcome reviews').at(-1);
  const disproved = outcome.assumptionResults.find((a) => a.outcome === 'DISPROVED');
  const reviewStory = unwrap(
    await full.driver.runSecond({
      decisionId: full.story.decisionId,
      commitmentId: full.story.commitmentId,
      disprovedAssumptionId: disproved.assumptionId,
      episodeId: full.genomeStory.episodes.E1.episode.id,
      patternId: full.genomeStory.patterns.P2.pattern.id,
      counterfactualCaseId: full.counterfactualStory.cases.CF1.case.id,
      causalClaimId: full.causalStory.claims.C3.claim.id,
    }),
    'review story',
  );
  return { ...full, reviewStory };
}
