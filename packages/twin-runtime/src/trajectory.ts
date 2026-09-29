/**
 * Current state → committed future (ADR-0023 §8).
 *
 * The trajectory is the relationship between where the enterprise is and where
 * management committed to take it. HELM does not interpolate a path between the
 * two and does not forecast along it: it states both ends, the distance between
 * them, and what still stands between them (intents not done, approvals not
 * given, assumptions not yet tested).
 *
 * Before the committed period ends this is DISTANCE TO INTENT — nothing was due
 * yet, so it is not a variance. After it ends it is EXPECTED AGAINST ACTUAL —
 * what management expected against what the enterprise became. Neither is a
 * verdict on the decision.
 */

import { parsePeriodKey } from '@helm/shared';
import { difference, isMaterial, unitSuffix } from './attention.ts';
import type { ComposedSnapshot, TwinItem, Trajectory, TrajectoryLine } from './types.ts';

const ms = (t: unknown): number => (typeof t === 'string' ? Date.parse(t) : NaN);

export function trajectoryOf(current: ComposedSnapshot, committed: ComposedSnapshot): Trajectory {
  const commitmentId = committed.snapshot.spec.commitmentId ?? '';
  const E = ms(current.snapshot.spec.lens.effectiveAsOf);
  const expected = committed.items.filter((i) => i.kind === 'VALUE' && i.state.expectedOutcome === true);
  const ends = expected.map((i) => ms(periodEndOf(i))).filter((x) => !Number.isNaN(x));
  const horizonMs = ends.length > 0 ? Math.max(...ends) : NaN;
  const relation = !Number.isNaN(horizonMs) && horizonMs <= E ? 'EXPECTED_VS_ACTUAL' : 'DISTANCE_TO_INTENT';

  const pick = (nodeId: unknown, period: unknown): TwinItem | null => {
    const same = (layer: string) =>
      current.items.find(
        (i) => i.kind === 'VALUE' && i.layer === layer && i.status === 'KNOWN' && i.state.nodeId === nodeId && (i.state.period === period || i.state.period === null),
      ) ?? null;
    return same('ACTUAL') ?? same('MODELLED');
  };

  const lines: TrajectoryLine[] = expected
    .sort((a, b) => String(a.state.metricKey).localeCompare(String(b.state.metricKey)))
    .map((cf) => {
      const now = pick(cf.state.nodeId, cf.state.period);
      const committedValue = (cf.state.value as string | null) ?? null;
      const currentValue = now ? (now.state.value as string) : null;
      const diff = committedValue !== null && currentValue !== null ? difference(currentValue, committedValue) : null;
      const unit = (cf.state.unit as string | null) ?? null;
      return {
        nodeId: String(cf.state.nodeId),
        metricKey: String(cf.state.metricKey),
        label: cf.label.replace(/ — committed future$/, ''),
        period: (cf.state.period as string | null) ?? null,
        unit,
        currency: (cf.state.currency as string | null) ?? null,
        committed: committedValue,
        current: currentValue,
        currentLayer: now?.layer ?? null,
        difference: diff,
        differenceUnit: unitSuffix(unit, (cf.state.currency as string | null) ?? null),
        beyondMateriality: diff === null ? null : isMaterial(diff, unit),
        note: now ? null : 'no current reading of this position at the current lens',
      };
    });

  const decisionId = committed.items.find((i) => i.kind === 'COMMITMENT')?.key.replace(/^commitment:/, '') ?? null;
  const related = (i: TwinItem) => i.state.decisionId === decisionId || i.state.commitmentId === commitmentId;
  const unresolved: Trajectory['unresolved'][number][] = [];
  for (const i of current.items.filter(related)) {
    if (i.kind === 'ACTION_INTENT' && i.state.status !== 'DONE' && i.state.status !== 'CANCELLED') {
      unresolved.push({ itemKey: i.key, label: i.label, why: `action intent ${String(i.state.status).toLowerCase()}` });
    }
    if (i.kind === 'GOVERNANCE' && !['APPROVED', 'AUTHORIZED'].includes(String(i.state.state))) {
      unresolved.push({ itemKey: i.key, label: i.label, why: `governance ${String(i.state.state).replaceAll('_', ' ').toLowerCase()}` });
    }
    if (i.kind === 'ASSUMPTION' && i.state.supportsCommitment === true) {
      if (i.state.outcome === 'DISPROVED') unresolved.push({ itemKey: i.key, label: i.label, why: 'assumption disproved' });
      else if (i.state.challenged === true) unresolved.push({ itemKey: i.key, label: i.label, why: 'assumption under challenge' });
      else if (i.state.outcome === 'PENDING' && i.state.criticality === 'CRITICAL') unresolved.push({ itemKey: i.key, label: i.label, why: 'critical assumption not yet tested' });
    }
  }

  const statement =
    relation === 'EXPECTED_VS_ACTUAL'
      ? 'The committed period has ended: this is what management expected against what the enterprise became. ' +
        'It is not a verdict on the decision — a well-reasoned decision can meet a poor outcome.'
      : 'The committed period has not ended: this is the distance between the current state and the committed future. ' +
        'Nothing was due yet, so it is not a variance, and HELM draws no path between the two.';
  return {
    relation,
    commitmentId,
    current: current.snapshot,
    committedFuture: committed.snapshot,
    horizon: Number.isNaN(horizonMs) ? null : new Date(horizonMs).toISOString(),
    lines,
    unresolved: unresolved.sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
    statement,
  };
}

/** The end of a value's business period (exclusive), from its period key. */
function periodEndOf(item: TwinItem): string | null {
  const key = item.state.period;
  if (typeof key !== 'string') return null;
  const p = parsePeriodKey(key);
  return p.ok ? p.value.end : null;
}
