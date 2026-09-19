import type { DecisionStatus } from './types.ts';

/**
 * The decision state machine. Pages never set `status` directly — they ask
 * for a transition, and the store records the transition as an append-only
 * decision event. Keeping the legal moves here means every surface agrees on
 * what a decision can do next.
 *
 *   draft → analyzing → pending_approval → approved → executing → monitoring → closed
 *                     ↘ (below threshold) ↗       ↘ rejected → analyzing (rework)
 */
export const legalTransitions: Record<DecisionStatus, DecisionStatus[]> = {
  draft: ['analyzing'],
  analyzing: ['pending_approval', 'approved'],
  pending_approval: ['approved', 'rejected'],
  approved: ['executing'],
  rejected: ['analyzing'],
  executing: ['monitoring'],
  monitoring: ['closed'],
  closed: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return legalTransitions[from]?.includes(to) ?? false;
}

/**
 * Whether moving out of `analyzing` must pass through approval. True when an
 * active rule matches the decision type (or any-type rules) and the amount at
 * stake reaches the threshold.
 */
export function requiresApproval(
  amountAtStake: number | null,
  decisionType: string,
  rules: { decisionType: string | null; thresholdAmount: number; active: boolean }[],
): boolean {
  const amount = Math.abs(amountAtStake ?? 0);
  return rules.some(
    (r) =>
      r.active &&
      (r.decisionType === null || r.decisionType === decisionType) &&
      amount >= r.thresholdAmount,
  );
}

/** Statuses where the analysis is still editable. */
export const editableStatuses: DecisionStatus[] = ['draft', 'analyzing', 'rejected'];

export function isEditable(status: DecisionStatus): boolean {
  return editableStatuses.includes(status);
}
