/**
 * The app's access to the Management Review Loop.
 *
 * Wires ports together and holds no domain logic: every review, pack, item,
 * closure and reproduction comes from @helm/review-runtime.
 *
 * Demo mode: Review 1 (weekly, week of 21 Sep 2026) was lived INSIDE the twin
 * story — opened with its first snapshot, closed once the commitment was governed
 * (src/services/twinRuntime.ts passes the driver's hooks). Review 2 (quarterly,
 * Q1 2027) is run here, once, after the causal claims, the genome and the
 * counterfactual review exist, and follows Review 1. Every record is labelled DEMO.
 *
 * Cloud mode reads and writes helm_management_review* under the signed-in user's
 * RLS. That path has not been exercised end to end (Blocker B).
 */

import {
  MERIDIAN_REVIEW_TIMES,
  createReviewRuntime,
  type MeridianReviewStory,
  type ProjectedReviews,
  type ReviewLens,
  type ReviewPack,
  type ReviewRuntime,
  type ReviewView,
} from '@helm/review-runtime';
import { createPostgresReviewStore } from '@helm/review-runtime/postgres';
import type { TwinViewer } from '@helm/twin-runtime';
import type { Scope } from '@helm/shared';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { decisionVisibility } from './causalRuntime.ts';
import { resolveGenomeContext, type GenomeContext } from './genomeRuntime.ts';
import type { TwinViewerPreset } from './twinRuntime.ts';
import type { PillTone } from '../components/ui/Pill.tsx';

export type ReviewLensPreset = { readonly key: string; readonly label: string; readonly lens: ReviewLens | null };

export type ReviewContext = {
  readonly review: ReviewRuntime;
  readonly scope: Scope;
  readonly mode: 'demo' | 'cloud';
  readonly genome: GenomeContext;
  /** Demo: the two canonical reviews. Null in the cloud. */
  readonly story: MeridianReviewStory | null;
  readonly viewers: readonly TwinViewerPreset[];
  readonly lenses: readonly ReviewLensPreset[];
};

let demoReviews: Promise<ReviewContext> | null = null;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.value;
};

const at = (iso: string): ReviewLens => ({ effectiveAsOf: iso, recordedThrough: iso });

function getDemoReviews(scope: Scope): Promise<ReviewContext> {
  if (demoReviews) return demoReviews;
  demoReviews = (async () => {
    const genome = await resolveGenomeContext('demo', scope);
    if (!genome || !genome.story || !genome.counterfactual.story) throw new Error('The demo genome is unavailable.');
    const twin = genome.causal.twin;
    const demo = twin.kernel.demoReview;
    if (!demo || !twin.story || !genome.causal.story) throw new Error('The demo reviews were not lived inside the twin story.');
    // The enterprise now has a causal graph, a genome and a counterfactual engine: the reviews may read them.
    demo.sources.causal = genome.causal.causal;
    demo.sources.genome = genome.genome;
    demo.sources.counterfactual = genome.counterfactual.runtime;
    const outcome = must(await twin.kernel.decisionStore.listOutcomeReviews(scope, twin.story.decisionId), 'outcome reviews').at(-1);
    const disproved = outcome?.assumptionResults.find((a) => a.outcome === 'DISPROVED');
    if (!disproved) throw new Error('The demo outcome review disproves no assumption.');
    const story = must(
      await demo.driver.runSecond({
        decisionId: twin.story.decisionId,
        commitmentId: twin.story.commitmentId,
        disprovedAssumptionId: disproved.assumptionId,
        episodeId: genome.story.episodes.E1.episode.id,
        patternId: genome.story.patterns.P2.pattern.id,
        counterfactualCaseId: genome.counterfactual.story.cases.CF1.case.id,
        causalClaimId: genome.causal.story.claims.C3.claim.id,
      }),
      'the second review',
    );
    const first = story.first.closure!.recordedAt;
    return {
      review: demo.review,
      scope,
      mode: 'demo' as const,
      genome,
      story,
      viewers: genome.viewers,
      lenses: [
        { key: 'now', label: 'Now', lens: null },
        { key: 'r2open', label: '14 Apr 2027 — as Review 2 opened', lens: at(MERIDIAN_REVIEW_TIMES.secondOpened) },
        { key: 'r1', label: '24 Sep 2026 — just after Review 1 closed', lens: at(first) },
      ],
    };
  })();
  return demoReviews;
}

async function getCloudReviews(scope: Scope): Promise<ReviewContext | null> {
  const genome = await resolveGenomeContext('cloud', scope);
  if (!genome || !supabaseClient) return null;
  const k = genome.causal.twin.kernel;
  const review = createReviewRuntime({
    store: createPostgresReviewStore({ client: supabaseClient }),
    sources: { twin: genome.causal.twin.twin, decisions: k.decisionStore, causal: genome.causal.causal, genome: genome.genome, counterfactual: genome.counterfactual.runtime },
    clock: k.clock,
  });
  return { review, scope, mode: 'cloud', genome, story: null, viewers: genome.viewers, lenses: [{ key: 'now', label: 'Now', lens: null }] };
}

export async function resolveReviewContext(mode: 'demo' | 'cloud', scope: Scope): Promise<ReviewContext | null> {
  return mode === 'demo' ? getDemoReviews(scope) : getCloudReviews(scope);
}

// ----------------------------------------------------------------- read models

/** Reviews as this reader may see them — the same rule RLS applies (helm_private.can_see_management_review). */
export async function reviewsForViewer(ctx: ReviewContext, viewer: TwinViewer, lens: ReviewLens | null): Promise<ProjectedReviews> {
  const decisionVisible = await decisionVisibility(ctx.genome.causal, viewer);
  return must(await ctx.review.projectForViewer(ctx.scope, viewer, ctx.genome.causal.twin.units, { decisionVisible }, lens ?? undefined), 'reviews');
}

/** The pack as this reader may read it. */
export async function packForViewer(ctx: ReviewContext, reviewId: string, which: 'PREPARATION' | 'CLOSING', viewer: TwinViewer): Promise<{ pack: ReviewPack | null; withheld: number; statement: string }> {
  const decisionVisible = await decisionVisibility(ctx.genome.causal, viewer);
  if (which === 'CLOSING') {
    const closing = must(await ctx.review.closingPack(ctx.scope, reviewId), 'closing pack');
    return { pack: closing, withheld: 0, statement: closing ? 'The state the review closed with, recomputed from the kernel at its closing lens.' : 'This review is still open.' };
  }
  const r = await ctx.review.preparedFor(ctx.scope, reviewId, viewer, ctx.genome.causal.twin.units, { decisionVisible });
  return r.ok ? { pack: r.value.pack, withheld: r.value.withheld, statement: r.value.statement } : { pack: null, withheld: 0, statement: r.error.message };
}

export async function reproduce(ctx: ReviewContext, reviewId: string, which: 'PREPARATION' | 'CLOSING') {
  return must(await ctx.review.reproduce(ctx.scope, reviewId, which), 'reproduction');
}

export type { ReviewView, ReviewPack, ProjectedReviews };

export const statusTone = (s: ReviewView['status']): PillTone => (s === 'CLOSED' ? 'reviewed' : 'recurring');
