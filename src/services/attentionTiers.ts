import { isDeterioration, type TwinItem } from '@helm/twin-runtime';

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
 *
 * A committed future the enterprise landed on the RIGHT side of, by the metric's declared direction, is still a
 * material distance worth learning from — but it is a look, not an alarm (audit 2026-10-15: margin 1.18 pts above
 * what was committed sat among the rows that cannot wait). A context-dependent metric is never judged, so its
 * distance stays where it was.
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

/**
 * True when a COMMITTED_FUTURE_OFF_TRACK condition landed on the favourable side of its metric's declared direction.
 * `byKey` resolves the condition's cause items (the committed future and the reading it is set against).
 */
export function landedFavourably(i: TwinItem, byKey: ReadonlyMap<string, TwinItem>): boolean {
  if (conditionOf(i) !== 'COMMITTED_FUTURE_OFF_TRACK') return false;
  const causes = ((i.state as { causeItemKeys?: readonly string[] }).causeItemKeys ?? []).map((k) => byKey.get(k)).filter((c): c is TwinItem => c !== undefined);
  const cf = causes.find((c) => c.layer === 'COMMITTED_FUTURE');
  const reading = causes.find((c) => c !== cf);
  if (!cf || !reading) return false;
  const committed = Number(cf.state['value']);
  const landed = Number(reading.state['value']);
  if (!Number.isFinite(committed) || !Number.isFinite(landed)) return false;
  // Same node and metric: the reading carries the metric's direction when the committed future does not.
  const direction = String(cf.state['directionality'] ?? reading.state['directionality'] ?? '');
  return isDeterioration(direction, String(Math.sign(landed - committed))) === false;
}

/** An objective short of target on a current reading cannot wait; a forecast short of target is a look. */
export const cannotWait = (i: TwinItem, byKey: ReadonlyMap<string, TwinItem> = new Map()): boolean =>
  (CANNOT_WAIT.has(conditionOf(i)) && !landedFavourably(i, byKey)) || (conditionOf(i) === 'OBJECTIVE_OFF_TRACK' && !/forecast/i.test(ruleOf(i)));

export type AttentionTiers = {
  readonly cannotWait: readonly TwinItem[];
  readonly look: readonly TwinItem[];
  /** Commitments that carry no authority verdict: shown as one line. */
  readonly noAuthorityVerdict: readonly TwinItem[];
  /** Keys of look lines that landed on the favourable side of what was committed. */
  readonly favourable: ReadonlySet<string>;
  /** Lines a reader sees: each cannot-wait row, each look line, and one line for the unresolved authority. */
  readonly lines: number;
};

/** `causes`: where a condition's cause items are read from — the snapshot's items when `items` is a projection. */
export function attentionTiers(items: readonly TwinItem[], causes: readonly TwinItem[] = items): AttentionTiers {
  const byKey = new Map(causes.map((i) => [i.key, i] as const));
  const attention = items.filter((i) => i.kind === 'ATTENTION');
  const urgent = attention.filter((i) => cannotWait(i, byKey));
  const noAuthorityVerdict = attention.filter((i) => conditionOf(i) === 'AUTHORITY_UNRESOLVED');
  const look = attention.filter((i) => !cannotWait(i, byKey) && conditionOf(i) !== 'AUTHORITY_UNRESOLVED');
  const favourable = new Set(look.filter((i) => landedFavourably(i, byKey)).map((i) => i.key));
  return { cannotWait: urgent, look, noAuthorityVerdict, favourable, lines: urgent.length + look.length + (noAuthorityVerdict.length > 0 ? 1 : 0) };
}
