import type { TwinItem } from '@helm/twin-runtime';

/**
 * How the Cockpit treats an attention condition (CLAUDE.md, layout principle 3: severity decides treatment).
 *
 * The tier comes from WHAT the condition is, never from a score: the enterprise has moved off what management
 * committed, a stated line is breached, an assumption a commitment rests on was disproved, a commitment stands without
 * its authority — these cannot wait and get a full row. Everything else needs a look this week and gets one line.
 * Nothing is weighed against anything inside a tier, and the tiers are never summed into one figure.
 *
 * Commitments with no authority verdict are one standing condition, not one alarm per commitment (audit 2026-10-13:
 * four of eleven conditions on the Cockpit were "NOT EVALUATED", and every new commitment added another).
 */

export const conditionOf = (i: TwinItem): string => String((i.state as { condition?: string }).condition ?? 'ATTENTION');
const ruleOf = (i: TwinItem): string => String((i.state as { rule?: string }).rule ?? '');

const CANNOT_WAIT: ReadonlySet<string> = new Set([
  'CONSTRAINT_BREACHED',
  'COMMITMENT_NOT_AUTHORIZED',
  'CRITICAL_ASSUMPTION_DISPROVED',
  'COMMITTED_FUTURE_OFF_TRACK',
  'APPROVAL_PENDING',
]);

/** An objective short of target on a current reading cannot wait; a forecast short of target is a look. */
export const cannotWait = (i: TwinItem): boolean =>
  CANNOT_WAIT.has(conditionOf(i)) || (conditionOf(i) === 'OBJECTIVE_OFF_TRACK' && !/forecast/i.test(ruleOf(i)));

export type AttentionTiers = {
  readonly cannotWait: readonly TwinItem[];
  readonly look: readonly TwinItem[];
  /** Commitments that carry no authority verdict: shown as one line. */
  readonly noAuthorityVerdict: readonly TwinItem[];
  /** Lines a reader sees: each cannot-wait row, each look line, and one line for the unresolved authority. */
  readonly lines: number;
};

export function attentionTiers(items: readonly TwinItem[]): AttentionTiers {
  const attention = items.filter((i) => i.kind === 'ATTENTION');
  const urgent = attention.filter(cannotWait);
  const noAuthorityVerdict = attention.filter((i) => conditionOf(i) === 'AUTHORITY_UNRESOLVED');
  const look = attention.filter((i) => !cannotWait(i) && conditionOf(i) !== 'AUTHORITY_UNRESOLVED');
  return { cannotWait: urgent, look, noAuthorityVerdict, lines: urgent.length + look.length + (noAuthorityVerdict.length > 0 ? 1 : 0) };
}
