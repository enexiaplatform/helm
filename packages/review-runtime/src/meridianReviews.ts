/**
 * The canonical two-review proof (DEMO MANAGEMENT REVIEWS).
 *
 *   Review 1 — weekly, week of 21 Sep 2026. The Rohto issue appears; management
 *   sees it, explores scenarios, decides, commits and governs. It opens with the
 *   twin's first snapshot (before the decision) and closes once the committed
 *   future exists; what is still open — the commitment's outcome, the tender
 *   assumption and a question — is carried forward.
 *
 *   Review 2 — quarterly, Q1 2027. The outcome has arrived. Management sees
 *   expected against actual, the causal evidence, the disproved assumption, the
 *   management episode, the genome pattern and the counterfactual review, and
 *   raises whether to reconsider how distributor buffer stock is held. It follows
 *   Review 1 and inherits what Review 1 left open, by reference.
 *
 * The first review is lived INSIDE the twin story through its hooks, at the time
 * things happened; the second after everything else. Every record is labelled
 * DEMO. Deciding, committing and governing were done by their own runtimes — a
 * review only records that management did it in this review.
 */

import type { Result, Scope } from '@helm/shared';
import { fail, ok } from '@helm/shared';
import type { DecisionStore } from '@helm/decision-runtime';
import type { MeridianTwinHooks } from '@helm/twin-runtime';
import type { TwinScope } from '@helm/twin-runtime';
import type { ReviewRuntime, ReviewView } from './port.ts';
import type { ItemKind, ItemRole } from './types.ts';

export const DEMO_REVIEW_LABEL = 'DEMO MANAGEMENT REVIEW';

export const MERIDIAN_REVIEW_TIMES = {
  secondOpened: '2027-04-14T02:00:00.000Z',
  secondClosed: '2027-04-15T09:00:00.000Z',
} as const;

export type MeridianReviewDeps = {
  readonly review: ReviewRuntime;
  readonly decisions: DecisionStore;
  /** The Country GM. */
  readonly gm: Scope;
  readonly periods: readonly string[];
  readonly vietnamUnitId: string;
  readonly advanceTo: (iso: string) => void;
};

export type MeridianSecondReviewInput = {
  readonly decisionId: string;
  readonly commitmentId: string;
  /** The assumption the outcome review disproved. */
  readonly disprovedAssumptionId: string;
  readonly episodeId: string;
  readonly patternId: string;
  readonly counterfactualCaseId: string;
  readonly causalClaimId: string;
};

export type MeridianReviewStory = {
  readonly first: ReviewView;
  readonly second: ReviewView;
};

export type MeridianReviewDriver = {
  /** Pass to runMeridianTwinStory: Review 1 is lived alongside the twin's first snapshot and the committed future. */
  readonly hooks: MeridianTwinHooks;
  /** After everything else exists: opens and closes Review 2. */
  runSecond(input: MeridianSecondReviewInput): Promise<Result<MeridianReviewStory>>;
};

const must = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`review story — ${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

export function createMeridianReviewDriver(d: MeridianReviewDeps): MeridianReviewDriver {
  let vietnam: TwinScope | null = null;
  let firstId: string | null = null;
  let firstClosed: ReviewView | null = null;
  const label = (who: string) => `${who} (${DEMO_REVIEW_LABEL})`;
  const add = async (reviewId: string, kind: ItemKind, id: string | null, refLabel: string, role: ItemRole, note: string) =>
    must(await d.review.addItem(d.gm, reviewId, kind === 'QUESTION' ? { kind, role, note } : { kind, role, ref: { kind, id: id!, label: refLabel }, note }), `add ${kind}`);

  const hooks: MeridianTwinHooks = {
    async afterS0({ decisionId, scopes }) {
      vietnam = scopes.vietnam;
      const opened = must(
        await d.review.openReview(d.gm, {
          title: 'Vietnam weekly review — week of 21 Sep 2026',
          cadence: 'WEEKLY',
          periodLabel: '2026-W39',
          scope: scopes.vietnam,
          periods: d.periods,
          grantedUnitIds: [d.vietnamUnitId],
          openedByLabel: label('Country GM Vietnam'),
        }),
        'open Review 1',
      );
      firstId = opened.review.id;
      const pack = must(await d.review.prepare(d.gm, firstId), 'prepare Review 1');
      // The issue appears in the review's own preparation: management raises it, it is not retyped.
      for (const a of pack.attention.items.slice(0, 3)) await add(firstId, 'ATTENTION', a.itemKey, a.label, 'RAISED', `Seen at the opening of the review: ${a.statement}`);
      await add(firstId, 'DECISION', decisionId, 'Rohto Q4 order fulfilment', 'FRAMED', 'Framed for this review. The alternatives were explored as scenarios in the scenario runtime.');
      await add(firstId, 'QUESTION', null, '', 'RAISED', 'Can we serve the Rohto tender without leaving the provincial tender unserved?');
    },

    async afterCommittedFuture({ decisionId, commitmentId }) {
      if (!firstId) throw new Error('Review 1 was not opened.');
      await add(firstId, 'COMMITMENT', commitmentId, 'Rohto Q4 order fulfilment — commitment', 'COMMITTED', 'Committed by the Commercial Director and approved by the Country GM through the authority runtime; the committed future is a stored twin snapshot.');
      const revisions = must(await d.decisions.listRevisions(d.gm, decisionId), 'revisions');
      let tender: { id: string; statement: string } | null = null;
      for (const r of revisions) {
        const assumptions = must(await d.decisions.listAssumptions(d.gm, r.id), 'assumptions');
        tender = assumptions.find((a) => /tender|provincial/i.test(a.statement)) ?? assumptions[0] ?? tender;
        if (tender) break;
      }
      if (tender) await add(firstId, 'ASSUMPTION', tender.id, tender.statement.slice(0, 80), 'NOTED', 'A critical assumption this decision rests on; the outcome will say whether it held.');
      const view = must(await d.review.getReview(d.gm, firstId), 'Review 1');
      const disposition = (kind: ItemKind): { disposition: 'RESOLVED' | 'CARRIED_FORWARD'; reason: string } =>
        kind === 'ATTENTION' ? { disposition: 'RESOLVED', reason: 'Addressed by the Rohto commitment.' }
        : kind === 'DECISION' ? { disposition: 'RESOLVED', reason: 'Committed and governed in this review.' }
        : kind === 'COMMITMENT' ? { disposition: 'CARRIED_FORWARD', reason: 'Its outcome is reviewed once the Q4 actuals arrive.' }
        : kind === 'ASSUMPTION' ? { disposition: 'CARRIED_FORWARD', reason: 'To be checked against the tender result.' }
        : { disposition: 'CARRIED_FORWARD', reason: 'Still open: revisit when the provincial tender moves.' };
      firstClosed = must(
        await d.review.closeReview(d.gm, firstId, {
          summary: 'The Rohto allocation was decided, committed and approved this week. The provincial tender question stays open, and the commitment and its critical assumption are reviewed when actuals arrive.',
          dispositions: view.items.map((i) => ({ itemId: i.id, ...disposition(i.kind) })),
          closedByLabel: label('Country GM Vietnam'),
        }),
        'close Review 1',
      );
    },
  };

  return {
    hooks,
    async runSecond(a) {
      try {
        if (!vietnam || !firstId || !firstClosed) return fail('review.demo_story', 'Review 1 was not lived inside the twin story: pass the driver hooks to runMeridianTwinStory.');
        d.advanceTo(MERIDIAN_REVIEW_TIMES.secondOpened);
        const opened = must(
          await d.review.openReview(d.gm, {
            title: 'Vietnam quarterly business review — Q1 2027',
            cadence: 'QUARTERLY',
            periodLabel: '2027-Q1',
            scope: vietnam,
            previousReviewId: firstId,
            periods: d.periods,
            grantedUnitIds: [d.vietnamUnitId],
            openedByLabel: label('Country GM Vietnam'),
          }),
          'open Review 2',
        );
        const id = opened.review.id;
        const pack = must(await d.review.prepare(d.gm, id), 'prepare Review 2');
        for (const at of pack.attention.items.slice(0, 2)) await add(id, 'ATTENTION', at.itemKey, at.label, 'RAISED', `Seen at the opening of the review: ${at.statement}`);
        await add(id, 'COMMITMENT', a.commitmentId, 'Rohto Q4 order fulfilment — commitment', 'NOTED', 'The outcome has arrived: expected against actual is in the pack, and the commitment is reviewed here.');
        await add(id, 'ASSUMPTION', a.disprovedAssumptionId, 'The tender assumption', 'NOTED', 'Disproved by the Q4 outcome review.');
        await add(id, 'CAUSAL_CLAIM', a.causalClaimId, 'Fulfilment cost claim', 'NOTED', 'The causal evidence behind the margin shortfall, with its own status.');
        await add(id, 'EPISODE', a.episodeId, 'Rohto Q4 allocation', 'NOTED', 'The management episode: how management decided, and what happened, kept apart.');
        await add(id, 'PATTERN', a.patternId, 'A recurring pattern', 'NOTED', 'A pattern people proposed and HELM checked; recurrence is described, not certified.');
        await add(id, 'COUNTERFACTUAL_CASE', a.counterfactualCaseId, 'Expedite instead of reallocating', 'NOTED', 'What might have happened otherwise — a model estimate at each lens, never a verdict on the decision.');
        await add(id, 'QUESTION', null, '', 'RAISED', 'Does the Rohto experience change how we hold distributor buffer stock, and should the commitment be reconsidered?');
        const view = must(await d.review.getReview(d.gm, id), 'Review 2');
        const dispose = (i: ReviewView['items'][number]): { disposition: 'RESOLVED' | 'CARRIED_FORWARD'; reason: string } =>
          i.carriedFromItemId && i.kind === 'QUESTION' ? { disposition: 'RESOLVED', reason: 'The tender did not draw: the Q4 review recorded it.' }
          : i.kind === 'QUESTION' ? { disposition: 'CARRIED_FORWARD', reason: 'Reconsideration is a decision for the decision runtime; the question goes to the next review.' }
          : { disposition: 'RESOLVED', reason: 'Reviewed.' };
        d.advanceTo(MERIDIAN_REVIEW_TIMES.secondClosed);
        const closed = must(
          await d.review.closeReview(d.gm, id, {
            summary: 'The outcome arrived below the commitment and the tender assumption was disproved. The episode, its pattern and the counterfactual review are read together; whether to reconsider buffer-stock practice is carried to the next review.',
            dispositions: view.items.map((i) => ({ itemId: i.id, ...dispose(i) })),
            closedByLabel: label('Country GM Vietnam'),
          }),
          'close Review 2',
        );
        return ok({ first: firstClosed, second: closed });
      } catch (e) {
        return fail('review.demo_story', (e as Error).message);
      }
    },
  };
}
