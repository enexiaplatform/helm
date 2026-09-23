/**
 * The commitment fingerprint (ADR-0021 §6).
 *
 * One deterministic identity for "this is what management committed against".
 * The same evidence, criteria, futures and reasoning produce the same
 * fingerprint; anything material changing produces a different one, which is
 * what makes "has the basis of this decision moved?" a comparison rather than
 * an argument.
 *
 * It is built from exactly the things that could change what management was
 * looking at:
 *
 *   the organization and the decision   a different tenant or question is a
 *                                       different commitment
 *   the knowledge boundary              the same choice made knowing more is
 *                                       not the same choice
 *   the model                           engine version and calculation refs
 *   every alternative                   label, status, scenario run and that
 *                                       run's own fingerprint — so a re-run at
 *                                       a different boundary changes this one
 *   the criteria                        key, style, threshold, direction,
 *                                       required, and the authored weight
 *   the assumptions                     statement, owner, confidence,
 *                                       criticality
 *   the challenges                      concern and status at commitment time
 *   the evidence                        kind, relation, target, source ref
 *   the chosen alternative              and the rationale, accepted trade-offs,
 *                                       expected outcomes and review triggers
 *
 * and nothing else. Who typed it, when the rows were created and how they are
 * described do not change what was decided or what it rested on.
 */

import { fnv1a64, periodKey, type OrgId, type Period } from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type {
  AcceptedTradeOff,
  CommitmentSnapshot,
  DecisionAssumption,
  DecisionChallenge,
  DecisionCriterion,
  DecisionEvidence,
  ExpectedOutcome,
  RationaleItem,
  ReviewTrigger,
} from './types.ts';

/** Structural alias so the fingerprint does not depend on the scenario package. */
export type ForkLikeInput = { effectiveAsOf: string; recordedThrough: string; policy: string };

const iso = (t: string): string => new Date(t).toISOString();
const num = (v: string | null): string => (v === null ? '' : canonicalNumeric(v));
const per = (p: Period | null): string => (p === null ? '' : periodKey(p));

export function snapshotFingerprint(input: {
  orgId: OrgId;
  decisionId: string;
  revisionId: string;
  fork: ForkLikeInput;
  modelRef: { engineVersion: string; calculations: readonly string[] } | null;
  alternatives: CommitmentSnapshot['alternatives'];
  criteria: readonly DecisionCriterion[];
  assumptions: readonly DecisionAssumption[];
  challenges: readonly DecisionChallenge[];
  evidence: readonly DecisionEvidence[];
}): string {
  const lines: string[] = [
    'helm-decision-snapshot/v1',
    `org=${input.orgId}`,
    `decision=${input.decisionId}`,
    `revision=${input.revisionId}`,
    `fork=${iso(input.fork.effectiveAsOf)}|${iso(input.fork.recordedThrough)}|${input.fork.policy}`,
    `engine=${input.modelRef?.engineVersion ?? ''}`,
    `calcs=${[...(input.modelRef?.calculations ?? [])].sort().join(',')}`,
  ];
  lines.push(
    ...[...input.alternatives]
      .map((a) =>
        [
          'alt',
          a.alternativeId,
          a.label,
          a.status,
          a.scenarioRevisionId ?? '',
          a.scenarioRunId ?? '',
          a.scenarioFingerprint ?? '',
          a.completeness ?? '',
          a.chosen ? 'CHOSEN' : '',
        ].join('|'),
      )
      .sort(),
  );
  lines.push(
    ...[...input.criteria]
      .map((c) =>
        [
          'crit',
          c.key,
          c.style,
          c.metricKey ?? '',
          c.subjectHint ?? '',
          num(c.threshold),
          c.unit ?? '',
          c.direction,
          c.required ? 'required' : 'optional',
          num(c.weight),
        ].join('|'),
      )
      .sort(),
  );
  lines.push(
    ...[...input.assumptions]
      .map((a) =>
        [
          'assume',
          a.statement,
          a.owner ? `${a.owner.kind}:${a.owner.label}` : '',
          a.confidence === null ? '' : canonicalNumeric(String(a.confidence)),
          a.criticality,
          a.scenarioOverrideId ?? '',
        ].join('|'),
      )
      .sort(),
  );
  lines.push(
    ...[...input.challenges]
      .map((c) => ['challenge', c.targetKind, c.targetId ?? '', c.author.label, c.concern, c.status].join('|'))
      .sort(),
  );
  lines.push(
    ...[...input.evidence]
      .map((e) => ['evidence', e.kind, e.relation, e.targetKind, e.targetId ?? '', e.sourceSystem, e.sourceRef ?? ''].join('|'))
      .sort(),
  );
  const text = lines.join('\n');
  return `dsn_${fnv1a64(text)}_${text.length}`;
}

export function commitmentFingerprint(input: {
  orgId: OrgId;
  decisionId: string;
  revisionId: string;
  snapshotFingerprint: string;
  chosenAlternativeId: string;
  authorship: string;
  rationale: readonly RationaleItem[];
  acceptedTradeOffs: readonly AcceptedTradeOff[];
  expectedOutcomes: readonly ExpectedOutcome[];
  reviewTriggers: readonly ReviewTrigger[];
}): string {
  const lines: string[] = [
    'helm-decision-commitment/v1',
    `org=${input.orgId}`,
    `decision=${input.decisionId}`,
    `revision=${input.revisionId}`,
    `snapshot=${input.snapshotFingerprint}`,
    `chosen=${input.chosenAlternativeId}`,
    `authorship=${input.authorship}`,
  ];
  lines.push(...input.rationale.map((r) => ['why', r.kind, r.ref ?? '', r.label, r.statement].join('|')).sort());
  lines.push(
    ...input.acceptedTradeOffs
      .map((t) => ['accept', t.criterionId ?? '', t.metricKey ?? '', t.givenUp ?? '', t.inFavourOf ?? '', t.statement].join('|'))
      .sort(),
  );
  lines.push(
    ...input.expectedOutcomes
      .map((e) =>
        ['expect', e.kind, e.nodeId ?? '', e.metricKey ?? '', per(e.period), num(e.expectedValue), e.unit ?? '', e.statement ?? ''].join(
          '|',
        ),
      )
      .sort(),
  );
  lines.push(
    ...input.reviewTriggers
      .map((t) => ['review', t.kind, t.key, t.metricKey ?? '', t.comparator ?? '', num(t.threshold), t.byDate ?? ''].join('|'))
      .sort(),
  );
  const text = lines.join('\n');
  return `dfp_${fnv1a64(text)}_${text.length}`;
}
