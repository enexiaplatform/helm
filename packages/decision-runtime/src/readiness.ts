/**
 * Decision readiness (ADR-0021 §5).
 *
 * Procedural completeness, and nothing else. It answers "is anything missing
 * that management would want before choosing?" — not "is this a good
 * decision", not "which option is ahead". There is no readiness score: a
 * percentage would imply that 76% ready is a state, and it is not. Either a
 * named thing is missing or it is not.
 *
 * Two severities:
 *   BLOCKING  the decision cannot honestly be committed yet
 *   GAP       it can, but management should know what it is deciding without
 *
 * A decision with gaps is still committable. Management is allowed to decide
 * under uncertainty; HELM's job is to make sure the uncertainty is on the
 * record, not to withhold the button.
 */

import type { Completeness, FutureState } from '@helm/scenario-runtime';
import type {
  CriterionAssessment,
  CriterionEvaluation,
  DecisionAssumption,
  DecisionChallenge,
  DecisionCriterion,
  DecisionEvidence,
  ReadinessGap,
  ReadinessReport,
  ReadinessState,
} from './types.ts';
import type { AlternativeState } from './criteria.ts';

export const READINESS_STATEMENT =
  'Readiness is procedural completeness only: what is missing from the preparation, named. ' +
  'It says nothing about which alternative is better and nothing about whether the decision ' +
  'is a good one. A decision with gaps can still be committed — management decides under ' +
  'uncertainty, and HELM records what the uncertainty was.';

export function evaluateReadiness(input: {
  decisionId: string;
  revisionId: string;
  managementQuestion: string;
  hasOwner: boolean;
  alternatives: readonly AlternativeState[];
  criteria: readonly DecisionCriterion[];
  assessments: readonly CriterionAssessment[];
  assumptions: readonly DecisionAssumption[];
  challenges: readonly DecisionChallenge[];
  evidence: readonly DecisionEvidence[];
  evaluations: readonly CriterionEvaluation[];
  completenessOf: (state: FutureState) => Completeness;
  now: string;
}): ReadinessReport {
  const gaps: ReadinessGap[] = [];
  const active = input.alternatives.filter((a) => a.alternative.status !== 'WITHDRAWN');

  // ---- blocking: without these, there is nothing to decide between.
  if (input.managementQuestion.trim().length < 12) {
    gaps.push({
      code: 'no-management-question',
      severity: 'BLOCKING',
      message: 'The decision has no management question. "Decision: Inventory" is a label, not a question.',
    });
  }
  if (!input.hasOwner) {
    gaps.push({
      code: 'no-decision-owner',
      severity: 'BLOCKING',
      message: 'No one owns this decision.',
    });
  }
  if (active.length < 2) {
    gaps.push({
      code: 'too-few-alternatives',
      severity: 'BLOCKING',
      message: `Only ${active.length} alternative${active.length === 1 ? '' : 's'} on the table. A decision needs something to decide between.`,
    });
  }
  for (const { alternative, state } of active) {
    if (alternative.status === 'MODELLED' && state === null) {
      gaps.push({
        code: 'scenario-run-missing',
        severity: 'BLOCKING',
        message: `${alternative.label} claims a modelled future, but its simulation cannot be read.`,
        alternativeId: alternative.id,
      });
    }
  }
  if (input.criteria.length === 0) {
    gaps.push({
      code: 'no-criteria',
      severity: 'BLOCKING',
      message: 'No criteria are stated, so there is nothing to evaluate the alternatives against.',
    });
  }

  // ---- gaps: committable, but management should see them first.
  for (const { alternative, state } of active) {
    if (alternative.status === 'UNMODELLED') {
      gaps.push({
        code: 'alternative-unmodelled',
        severity: 'GAP',
        message: `${alternative.label} has no modelled future state${alternative.unmodelledReason ? `: ${alternative.unmodelledReason}` : ''}. Its consequences are not computed.`,
        alternativeId: alternative.id,
      });
      continue;
    }
    if (state && input.completenessOf(state) !== 'COMPLETE') {
      gaps.push({
        code: 'scenario-partial',
        severity: 'GAP',
        message: `${alternative.label}'s future state is ${input.completenessOf(state)}: some values are blocked or unavailable.`,
        alternativeId: alternative.id,
      });
    }
  }

  // Knowledge boundaries: comparing futures modelled at different moments mixes
  // the alternative's effect with what was learned in between (Phase 4 §21).
  const boundaries = new Set(
    active
      .map(({ state }) => (state ? new Date(state.run.fork.recordedThrough).toISOString() : null))
      .filter((b): b is string => b !== null),
  );
  if (boundaries.size > 1) {
    gaps.push({
      code: 'mixed-knowledge-boundaries',
      severity: 'GAP',
      message: `Alternatives were modelled at ${boundaries.size} different knowledge boundaries (${[...boundaries].sort().join(', ')}). Differences between them mix the alternative's effect with what was learned in between.`,
    });
  }

  for (const c of input.criteria.filter((x) => x.required)) {
    const mine = input.evaluations.filter((e) => e.criterionId === c.id);
    const unknown = mine.filter((e) => e.outcome === 'UNKNOWN' || e.outcome === 'NOT_ASSESSED');
    if (mine.length > 0 && unknown.length === mine.length) {
      gaps.push({
        code: 'required-criterion-unevaluable',
        severity: 'GAP',
        message: `Required criterion "${c.name}" could not be evaluated for any alternative.`,
        criterionId: c.id,
      });
      continue;
    }
    for (const u of unknown) {
      gaps.push({
        code: 'required-criterion-gap',
        severity: 'GAP',
        message: `Required criterion "${c.name}" is not evaluated for ${u.alternativeLabel}: ${u.explanation}`,
        criterionId: c.id,
        alternativeId: u.alternativeId,
      });
    }
    const hasEvidence = input.evidence.some((e) => e.targetKind === 'CRITERION' && e.targetId === c.id);
    const hasAssessment = input.assessments.some((a) => a.criterionId === c.id);
    if (c.style === 'QUALITATIVE' && !hasAssessment && !hasEvidence) {
      gaps.push({
        code: 'required-criterion-no-evidence',
        severity: 'GAP',
        message: `Required criterion "${c.name}" has neither an assessment nor evidence behind it.`,
        criterionId: c.id,
      });
    }
  }

  for (const a of input.assumptions) {
    if (a.owner === null) {
      gaps.push({
        code: a.criticality === 'CRITICAL' ? 'critical-assumption-unowned' : 'assumption-unowned',
        severity: 'GAP',
        message: `${a.criticality === 'CRITICAL' ? 'Critical assumption' : 'Assumption'} "${a.statement}" has no owner: nobody stands behind it.`,
        assumptionId: a.id,
      });
    }
  }

  for (const ch of input.challenges.filter((c) => c.status === 'OPEN')) {
    gaps.push({
      code: 'open-challenge',
      severity: 'GAP',
      message: `Open challenge from ${ch.author.label}: ${ch.concern}`,
      challengeId: ch.id,
    });
  }

  for (const e of input.evaluations.filter((x) => x.outcome === 'VIOLATED')) {
    gaps.push({
      code: 'hard-constraint-violated',
      severity: 'GAP',
      message: `${e.alternativeLabel} violates the stated requirement "${e.criterionName}": ${e.explanation}`,
      criterionId: e.criterionId,
      alternativeId: e.alternativeId,
    });
  }

  const state: ReadinessState = gaps.some((g) => g.severity === 'BLOCKING')
    ? 'NOT_READY'
    : gaps.length > 0
      ? 'READY_WITH_GAPS'
      : 'READY';

  return {
    decisionId: input.decisionId,
    revisionId: input.revisionId,
    state,
    gaps,
    evaluatedAt: input.now,
    statement: READINESS_STATEMENT,
  };
}
