/**
 * The canonical Rohto counterfactual review (DEMO COUNTERFACTUAL REVIEW).
 *
 * Management committed to B — Reallocate distributor stock. Three ex-post
 * questions are asked of that decision, at its original boundary:
 *
 *   CF1  Expedite instead of reallocating.
 *        AS_KNOWN_THEN — the alternative's own run, computed when the decision
 *        was made. WITH_HINDSIGHT — the same alternative, plus one fact learned
 *        in the Q4 review: the provincial tender did not draw. A person reviews
 *        the comparison. Four layers are kept apart: what the commitment
 *        expected, what happened, the alternative as known then, and with
 *        hindsight.
 *   CF2  Reallocate AND price the urgency — an explicit OVERRIDES intervention,
 *        built at the decision's own fork, not from today's state.
 *   CF3  Replace the distributor — never modelled, so NOT_ESTIMABLE: HELM does
 *        not invent a future.
 *
 * Every record is labelled DEMO. Nothing here is a company's books; it enters
 * HELM through the runtimes exactly as a real review would.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import { fail, ok } from '@helm/shared';
import type { DecisionStore } from '@helm/decision-runtime';
import type { OverrideInput, ScenarioRuntime } from '@helm/scenario-runtime';
import type { CaseView, CounterfactualComparison, CounterfactualRuntime, WorldView } from './port.ts';

export const DEMO_COUNTERFACTUAL_LABEL = 'DEMO COUNTERFACTUAL REVIEW';

export const MERIDIAN_COUNTERFACTUAL_TIMES = {
  asked: '2027-04-12T02:00:00.000Z',
  /** Between the two worlds of CF1: only the world as known then exists. */
  betweenWorlds: '2027-04-12T04:00:00.000Z',
  estimated: '2027-04-12T05:00:00.000Z',
  reviewed: '2027-04-13T02:00:00.000Z',
} as const;

type Anchor = { entityId: string; label: string };

export type MeridianCounterfactualDeps = {
  readonly counterfactual: CounterfactualRuntime;
  readonly as: (userId: UserId) => Scope;
  readonly users: { readonly countryGM: UserId; readonly financeDirector: UserId };
  readonly decisionStore: DecisionStore;
  readonly scenarios: ScenarioRuntime;
  readonly decisionId: string;
  /** The twin snapshot at the decision boundary (S0). */
  readonly anchorSnapshotId: string;
  readonly entities: { readonly buPharma: Anchor };
  readonly nodeIds: { readonly oppProbNext: string; readonly aspProduct: string };
  readonly advanceTo: (iso: string) => void;
};

export type MeridianCounterfactualStory = {
  readonly cases: Readonly<Record<'CF1' | 'CF2' | 'CF3', CaseView>>;
  readonly worlds: {
    readonly cf1Then: WorldView;
    readonly cf1Hindsight: WorldView;
    readonly cf2Then: WorldView;
    readonly cf3Then: WorldView;
  };
  readonly comparison: CounterfactualComparison;
  /** The outcome review whose disproved assumption is the hindsight input of CF1. */
  readonly hindsightReviewId: string;
};

const unwrap = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`counterfactual story — ${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

export async function runMeridianCounterfactualStory(d: MeridianCounterfactualDeps): Promise<Result<MeridianCounterfactualStory>> {
  try {
    return ok(await story(d));
  } catch (e) {
    return fail('counterfactual.demo_story', (e as Error).message);
  }
}

async function story(d: MeridianCounterfactualDeps): Promise<MeridianCounterfactualStory> {
  const T = MERIDIAN_COUNTERFACTUAL_TIMES;
  const cf = d.counterfactual;
  const gm = d.as(d.users.countryGM);
  const finance = d.as(d.users.financeDirector);
  const pharma = { kind: 'ANCHORED' as const, anchors: [{ entityId: d.entities.buPharma.entityId, label: d.entities.buPharma.label, dimension: '' }] };

  // ---- what was decided, and what the decision recorded
  const revisions = unwrap(await d.decisionStore.listRevisions(gm, d.decisionId), 'revisions');
  const alternatives = [];
  for (const r of revisions) alternatives.push(...unwrap(await d.decisionStore.listAlternatives(gm, r.id), 'alternatives'));
  const commitment = unwrap(await d.decisionStore.listCommitments(gm, d.decisionId), 'commitments').at(-1);
  if (!commitment) throw new Error('the Rohto decision has no commitment');
  const chosen = alternatives.find((a) => a.id === commitment.chosenAlternativeId);
  const expedite = alternatives.find((a) => /Expedite/.test(a.label));
  const replace = alternatives.find((a) => a.status === 'UNMODELLED');
  if (!chosen || !expedite || !replace) throw new Error('the Rohto decision does not hold the alternatives the demonstration reviews');
  const review = unwrap(await d.decisionStore.listOutcomeReviews(gm, d.decisionId), 'outcome reviews').find((r) => r.commitmentId === commitment.id);
  if (!review) throw new Error('the Rohto decision has no outcome review');

  // ---- CF1 — expedite instead of reallocating
  d.advanceTo(T.asked);
  const cf1 = unwrap(
    await cf.openCase(gm, {
      decisionId: d.decisionId,
      title: 'Expedite instead of reallocating (demo)',
      question: 'What might have happened had we expedited supply from Supplier A instead of reallocating Distributor D\'s stock?',
      intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: expedite.id },
      anchorSnapshotId: d.anchorSnapshotId,
      scope: pharma,
      // The hindsight below is about a tender's probability: a commercial figure the case's readers must be cleared for.
      carriesClasses: ['COMMERCIAL_CONFIDENTIAL'],
      authoredByLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})`,
    }),
    'open CF1',
  );
  const cf1Then = unwrap(await cf.estimate(gm, cf1.case.id, { lens: 'AS_KNOWN_THEN', byLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})` }), 'CF1 as known then');
  d.advanceTo(T.estimated);
  const cf1Hindsight = unwrap(
    await cf.estimate(gm, cf1.case.id, {
      lens: 'WITH_HINDSIGHT',
      byLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})`,
      hindsight: [
        {
          label: 'The provincial tender did not draw on stock',
          source: { kind: 'OUTCOME_REVIEW', ref: review.id },
          override: {
            overrideType: 'VALUE_OVERRIDE',
            targetNodeId: d.nodeIds.oppProbNext,
            operation: 'SET',
            value: '0',
            unit: 'ratio',
            provenanceKind: 'EXTERNAL_SIGNAL',
            rationale: 'The Q4 outcome review found the assumption that the tender stayed material disproved.',
            confidence: 0.9,
          },
          exogeneity: 'Whether the tender proceeded was the customer\'s decision; it does not depend on how stock was allocated.',
        },
      ],
    }),
    'CF1 with hindsight',
  );

  // ---- CF2 — reallocate AND price the urgency (an explicit set of overrides, at the decision's own fork)
  const chosenOverrides = chosen.scenarioRevisionId ? unwrap(await d.scenarios.listOverrides(gm, chosen.scenarioRevisionId), 'chosen overrides') : [];
  const asInput = (o: (typeof chosenOverrides)[number]): OverrideInput => ({
    overrideType: o.overrideType,
    targetNodeId: o.targetNodeId,
    operation: o.operation,
    value: o.value,
    unit: o.unit,
    currency: o.currency,
    period: o.period,
    provenanceKind: o.provenanceKind,
    rationale: o.rationale,
    confidence: o.confidence,
  });
  const cf2 = unwrap(
    await cf.openCase(gm, {
      decisionId: d.decisionId,
      title: 'Reallocate and price the urgency (demo)',
      question: 'What might have happened had we reallocated the distributor stock AND charged Rohto a 10% urgency premium?',
      intervention: {
        kind: 'OVERRIDES',
        label: 'Reallocate, and price the urgency',
        overrides: [
          ...chosenOverrides.map(asInput),
          {
            overrideType: 'ASSUMPTION_OVERRIDE',
            targetNodeId: d.nodeIds.aspProduct,
            operation: 'SET',
            value: '385000000',
            unit: 'currency',
            currency: 'VND',
            provenanceKind: 'MANAGEMENT_ASSUMPTION',
            rationale: 'Pass a 10% urgency premium to Rohto on the realised unit price.',
            confidence: 0.5,
          },
        ],
      },
      anchorSnapshotId: d.anchorSnapshotId,
      scope: pharma,
      carriesClasses: ['COMMERCIAL_CONFIDENTIAL'],
      authoredByLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})`,
    }),
    'open CF2',
  );
  const cf2Then = unwrap(await cf.estimate(gm, cf2.case.id, { lens: 'AS_KNOWN_THEN', byLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})` }), 'CF2 as known then');

  // ---- CF3 — replace the distributor: never modelled, so not estimable
  const cf3 = unwrap(
    await cf.openCase(gm, {
      decisionId: d.decisionId,
      title: 'Replace the distributor (demo)',
      question: 'What might have happened had we replaced Distributor D?',
      intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: replace.id },
      anchorSnapshotId: d.anchorSnapshotId,
      scope: pharma,
      authoredByLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})`,
    }),
    'open CF3',
  );
  const cf3Then = unwrap(await cf.estimate(gm, cf3.case.id, { lens: 'AS_KNOWN_THEN', byLabel: `Country GM Vietnam (${DEMO_COUNTERFACTUAL_LABEL})` }), 'CF3 as known then');

  // ---- a person reads the CF1 comparison, and says what it does not show
  d.advanceTo(T.reviewed);
  unwrap(
    await cf.recordReview(finance, cf1.case.id, {
      statement:
        'Expediting was modelled as a slightly thinner margin than the commitment expected, and with hindsight about the tender it would have covered the demand in full. ' +
        'Neither figure says the reallocation was the wrong call: it was taken under what was known then.',
      limitations:
        'A model estimate: customer response and the air-freight lead time in practice are not in it, one fact of hindsight was added, and the actual cash impact was never reviewed, so cash cannot be compared to what happened.',
      reviewedByLabel: `Finance Director Vietnam (${DEMO_COUNTERFACTUAL_LABEL})`,
    }),
    'review CF1',
  );

  const cases = {
    CF1: unwrap(await cf.getCase(gm, cf1.case.id), 'read CF1'),
    CF2: unwrap(await cf.getCase(gm, cf2.case.id), 'read CF2'),
    CF3: unwrap(await cf.getCase(gm, cf3.case.id), 'read CF3'),
  };
  return {
    cases,
    worlds: { cf1Then, cf1Hindsight, cf2Then, cf3Then },
    comparison: unwrap(await cf.compare(gm, cf1.case.id), 'compare CF1'),
    hindsightReviewId: review.id,
  };
}
