/**
 * The governance state — a PROJECTION, derived every time (ADR-0022 §10).
 *
 * Nothing here is stored. The state of a commitment is read off its latest
 * evaluation of THIS fingerprint and the acts recorded against that
 * evaluation's requirements. The policy result ("REQUIRES_APPROVAL") and the
 * workflow progress ("PENDING" → "APPROVED") are reported side by side and
 * never collapse into one field.
 *
 * An evaluation of a different fingerprint never counts: a reconsidered
 * commitment starts NOT_EVALUATED, however many approvals its predecessor had.
 */

import type {
  ApprovalAct,
  ApprovalProgress,
  AuthorityEvaluation,
  GovernanceState,
  GovernanceStateKey,
  RequiredApproval,
  RequirementStatus,
} from './types.ts';

const t = (iso: string): number => new Date(iso).getTime();

/** The evaluation that currently speaks for a commitment, and the ones it superseded. */
export function latestEvaluation(
  evaluations: readonly AuthorityEvaluation[],
  commitmentFingerprint: string,
): { latest: AuthorityEvaluation | null; superseded: AuthorityEvaluation[] } {
  const own = evaluations
    .filter((e) => e.commitmentFingerprint === commitmentFingerprint)
    .sort((a, b) => t(a.evaluatedAt) - t(b.evaluatedAt) || a.id.localeCompare(b.id));
  return { latest: own[own.length - 1] ?? null, superseded: own.slice(0, -1) };
}

export function projectGovernanceState(input: {
  commitmentId: string;
  commitmentFingerprint: string;
  evaluations: readonly AuthorityEvaluation[];
  requirements: readonly RequiredApproval[];
  acts: readonly ApprovalAct[];
  now: string;
}): GovernanceState {
  const { latest, superseded } = latestEvaluation(input.evaluations, input.commitmentFingerprint);
  const base = {
    commitmentId: input.commitmentId,
    commitmentFingerprint: input.commitmentFingerprint,
    supersededEvaluationIds: superseded.map((e) => e.id),
  };
  if (!latest) {
    return {
      ...base,
      state: 'NOT_EVALUATED',
      policyResult: null,
      approvalProgress: 'NONE_REQUIRED',
      evaluation: null,
      requirements: [],
      statement:
        'No authority evaluation exists for this commitment fingerprint. Evaluations of earlier commitments do not carry over.',
    };
  }

  const requirements: RequirementStatus[] = input.requirements
    .filter((r) => r.evaluationId === latest.id && r.commitmentFingerprint === input.commitmentFingerprint)
    .sort((a, b) => a.sequence - b.sequence || a.roleLabel.localeCompare(b.roleLabel))
    .map((requirement) => {
      const acts = input.acts
        .filter((a) => a.requiredApprovalId === requirement.id && a.commitmentFingerprint === input.commitmentFingerprint)
        .sort((a, b) => t(a.actedAt) - t(b.actedAt));
      const approve = acts.find((a) => a.decision === 'APPROVE');
      const expired = approve?.validUntil !== null && approve?.validUntil !== undefined && t(input.now) >= t(approve.validUntil);
      return {
        requirement,
        acts,
        satisfied: Boolean(approve) && !expired,
        note: expired ? `The approval lapsed on ${approve!.validUntil!.slice(0, 10)}; it no longer satisfies the requirement.` : null,
      };
    });

  const allActs = requirements.flatMap((r) => r.acts);
  let progress: ApprovalProgress;
  if (requirements.length === 0) progress = 'NONE_REQUIRED';
  else if (allActs.some((a) => a.decision === 'REJECT')) progress = 'REJECTED';
  else if (allActs.some((a) => a.decision === 'RETURN_FOR_RECONSIDERATION')) progress = 'RETURNED';
  else if (requirements.every((r) => r.satisfied)) progress = 'APPROVED';
  else progress = 'PENDING';

  let state: GovernanceStateKey;
  switch (latest.result) {
    case 'AUTHORIZED':
      state = 'AUTHORIZED';
      break;
    case 'NOT_AUTHORIZED':
      state = 'NOT_AUTHORIZED';
      break;
    case 'INDETERMINATE':
      state = 'INDETERMINATE';
      break;
    default:
      state =
        progress === 'APPROVED'
          ? 'APPROVED'
          : progress === 'REJECTED'
            ? 'REJECTED'
            : progress === 'RETURNED'
              ? 'RETURNED'
              : latest.result === 'ESCALATED'
                ? 'ESCALATED'
                : 'PENDING_APPROVAL';
  }

  const pending = requirements.filter((r) => !r.satisfied).map((r) => r.requirement.roleLabel);
  const statement =
    state === 'APPROVED'
      ? `The policy required ${requirements.map((r) => r.requirement.roleLabel).join(' and ')}; every required approval is recorded. The commitment itself is unchanged.`
      : state === 'PENDING_APPROVAL' || state === 'ESCALATED'
        ? `The policy result is ${latest.result}; waiting on ${pending.join(' and ')}.`
        : state === 'REJECTED'
          ? 'A required authority rejected the commitment. It stands as history; answering the rejection means reconsidering it.'
          : state === 'RETURNED'
            ? 'A required authority returned the commitment for reconsideration. It stands as history until a new commitment is made.'
            : `The policy result is ${latest.result}.`;

  return {
    ...base,
    state,
    policyResult: latest.result,
    approvalProgress: progress,
    evaluation: latest,
    requirements,
    statement,
  };
}
