/**
 * Inheritance and the overlay (ADR-0019 §4, §6).
 *
 * A child scenario inherits its parent's overrides, then applies its own. The
 * chain is resolved from the oldest ancestor down, so the nearest definition
 * of a target wins — and the one it replaced is RECORDED as shadowed, never
 * silently lost. A reader of the child's lineage can see that Expedite said
 * freight +80M and Expedite + Price Increase said +120M, and which one ran.
 *
 * A target is (value node, period). An override with no period applies to
 * every period of the revision; one with a period applies only there.
 */

import { samePeriod, type Period } from '@helm/shared';
import type { InputOverlay, OverlayEntry } from '@helm/propagation-engine';
import type { EffectiveOverride, ScenarioOverride } from './types.ts';

export type RevisionLink = {
  readonly scenarioId: string;
  readonly revisionId: string;
  readonly overrides: readonly ScenarioOverride[];
};

/** Does this override apply when simulating `period`? */
export const appliesTo = (o: ScenarioOverride, period: Period): boolean =>
  o.period === null || samePeriod(o.period, period);

/**
 * The effective overrides for one period. `chain` runs from the OLDEST
 * ancestor to the revision being executed (last).
 */
export function effectiveOverrides(
  chain: readonly RevisionLink[],
  period: Period,
): EffectiveOverride[] {
  const self = chain[chain.length - 1];
  const byNode = new Map<string, EffectiveOverride>();
  for (const link of chain) {
    for (const o of link.overrides) {
      if (!appliesTo(o, period)) continue;
      const previous = byNode.get(o.targetNodeId);
      byNode.set(o.targetNodeId, {
        override: o,
        inheritedFromScenarioId: link.scenarioId === self.scenarioId ? null : link.scenarioId,
        shadowed: previous ? [...previous.shadowed, previous.override] : [],
      });
    }
  }
  return [...byNode.values()].sort((a, b) =>
    a.override.targetNodeId.localeCompare(b.override.targetNodeId),
  );
}

/** The engine's view of one period's effective overrides. */
export function toOverlay(
  effective: readonly EffectiveOverride[],
  scenarioId: string,
  revisionId: string,
): InputOverlay {
  const entries = new Map<string, OverlayEntry>();
  for (const e of effective) {
    const o = e.override;
    entries.set(o.targetNodeId, {
      overrideId: o.id,
      nodeId: o.targetNodeId,
      operation: o.operation,
      value: o.value,
      unit: o.unit,
      currency: o.currency,
      confidence: o.confidence,
      scenarioId: o.scenarioId,
      revisionId: o.revisionId,
      inheritedFromScenarioId: e.inheritedFromScenarioId,
      shadowedOverrideIds: e.shadowed.map((s) => s.id),
      provenanceKind: o.provenanceKind,
    });
  }
  return { scenarioId, revisionId, entries };
}
