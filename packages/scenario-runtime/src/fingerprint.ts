/**
 * The scenario fingerprint (ADR-0019 §7).
 *
 * One deterministic identity for "this simulation": the same fingerprint means
 * the same computation, a different one means something that could change a
 * number changed. It is built from exactly the things that can:
 *
 *   the organization        a different tenant is a different source world
 *   the fork point          effectiveAsOf, recordedThrough, source policy —
 *                           the same overrides against a different baseline
 *                           boundary are NOT the same simulation
 *   the periods             which business periods were modelled
 *   the model               engine version and every calculation key@version
 *   the effective overrides after inheritance, per period: target node,
 *                           operation, canonical value, unit, currency and
 *                           confidence (confidence flows into every output)
 *
 * and nothing else. Names, rationale, author and provenance kind do not change
 * a single number, so two scenarios that differ only in how they are described
 * are equivalent — which is what makes the fingerprint useful for caching,
 * reproducibility and spotting duplicates. Values go through the Phase 3
 * canonical numeric form, so 0.9, 0.90 and 0.900 are one fingerprint.
 */

import { fnv1a64, periodKey, comparePeriods, type OrgId, type Period } from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type { EffectiveOverride, ForkPoint, ModelRef } from './types.ts';

const iso = (t: string): string => new Date(t).toISOString();

export function scenarioFingerprint(input: {
  orgId: OrgId;
  fork: ForkPoint;
  periods: readonly Period[];
  model: ModelRef;
  effective: readonly { period: Period; overrides: readonly EffectiveOverride[] }[];
}): string {
  const periods = [...input.periods].sort(comparePeriods);
  const lines: string[] = [
    'helm-scenario-fingerprint/v1',
    `org=${input.orgId}`,
    `fork=${iso(input.fork.effectiveAsOf)}|${iso(input.fork.recordedThrough)}|${input.fork.policy}`,
    `periods=${periods.map((p) => `${periodKey(p)}[${iso(p.start)},${iso(p.end)})`).join(',')}`,
    `engine=${input.model.engineVersion}`,
    `calcs=${[...input.model.calculations].sort().join(',')}`,
  ];
  const byPeriod = [...input.effective].sort((a, b) => comparePeriods(a.period, b.period));
  for (const { period, overrides } of byPeriod) {
    lines.push(`p=${periodKey(period)}`);
    const rows = overrides
      .map(({ override: o }) =>
        [
          o.targetNodeId,
          o.operation,
          canonicalNumeric(o.value),
          o.unit,
          o.currency ?? '',
          o.confidence === null ? '' : canonicalNumeric(String(o.confidence)),
        ].join('|'),
      )
      .sort();
    lines.push(...rows);
  }
  const text = lines.join('\n');
  return `sfp_${fnv1a64(text)}_${text.length}`;
}
