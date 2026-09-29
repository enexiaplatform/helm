/**
 * Where a causal claim holds (ADR-0026 §4).
 *
 * A claim is anchored on entities — a business unit, a customer, a product —
 * and holds where ALL its anchors hold at once ("Rohto, within Vietnam
 * Pharma"). A question, a twin difference or a manager asks about a context:
 * one or more entities. For each anchor of the claim, under the structure as
 * it stood at the lens (walked with the anchoring edges the authority engine
 * and the twin use), the context either
 *
 *   COVERS it        a context entity sits within the anchor
 *                    (Rohto's Pharma order within Pharma BU)
 *   IS WIDER         the anchor sits within a context entity
 *                    (Pharma BU within Vietnam)
 *   IS SILENT        no context entity says anything on that dimension
 *                    (a question about Rohto says nothing about business unit)
 *   CONFLICTS        a context entity names another member of that dimension
 *                    (Thailand Pharma BU, not Vietnam Pharma BU)
 *
 * APPLIES only when every anchor is covered; any conflict puts the claim
 * OUTSIDE; anything else APPLIES_TO_PART. Nothing generalizes upward or
 * sideways by default: a claim supported for Vietnam Pharma is not supported
 * for Thailand Pharma, and says nothing about the rest of Vietnam.
 */

import type { StructureView } from '@helm/twin-runtime';
import { DIMENSION_OF_ENTITY_TYPE } from '@helm/authority-runtime';
import type { Applicability } from './port.ts';
import type { CausalScope } from './types.ts';

const coords = (view: StructureView, id: string): Record<string, readonly string[]> => {
  const p = view.placement.get(id) ?? {};
  const own = view.entities.get(id);
  const d = own ? DIMENSION_OF_ENTITY_TYPE[own.entityTypeKey] : undefined;
  return d && !(p[d] ?? []).includes(id) ? { ...p, [d]: [...(p[d] ?? []), id] } : p;
};
const within = (view: StructureView, id: string, container: string): boolean =>
  id === container || Object.values(coords(view, id)).some((l) => l.includes(container));

export function applicabilityOf(view: StructureView, scope: CausalScope, context: string | readonly string[]): Applicability {
  if (scope.kind === 'ENTERPRISE_WIDE') {
    return { verdict: 'APPLIES', reason: `The claim is stated enterprise-wide: ${scope.justification}` };
  }
  const ids = typeof context === 'string' ? [context] : [...context];
  const missing = ids.filter((id) => !view.entities.has(id));
  if (ids.length === 0 || missing.length > 0) {
    return { verdict: 'UNPLACEABLE', reason: 'The context did not exist at this lens, so the claim cannot be placed against it.' };
  }
  const absentAnchors = scope.anchors.filter((a) => !view.entities.has(a.entityId));
  if (absentAnchors.length > 0) {
    return { verdict: 'UNPLACEABLE', reason: `The claim's scope names ${absentAnchors.map((m) => m.label).join(', ')}, which did not exist at this lens.` };
  }
  const contextLabel = ids.map((id) => view.entities.get(id)!.name).join(' / ');
  const claimLabel = scope.anchors.map((a) => a.label).join(' / ');
  const covered: string[] = [];
  const wider: string[] = [];
  const silent: string[] = [];
  const conflicts: string[] = [];
  for (const a of scope.anchors) {
    const anchorEntity = view.entities.get(a.entityId)!;
    const dim = DIMENSION_OF_ENTITY_TYPE[anchorEntity.entityTypeKey] ?? a.dimension;
    if (ids.some((q) => within(view, q, a.entityId))) covered.push(a.label);
    else if (ids.some((q) => within(view, a.entityId, q))) wider.push(a.label);
    else if (ids.every((q) => (coords(view, q)[dim] ?? []).length === 0)) silent.push(a.label);
    else conflicts.push(a.label);
  }
  if (conflicts.length > 0) {
    return {
      verdict: 'OUTSIDE',
      reason: `${contextLabel} is outside ${claimLabel} (${conflicts.join(', ')} does not hold there). A claim supported there is not evidence here; its external validity is unknown.`,
    };
  }
  if (wider.length === 0 && silent.length === 0) {
    return { verdict: 'APPLIES', reason: `${contextLabel} sits within ${claimLabel}, where the claim is stated.` };
  }
  return {
    verdict: 'APPLIES_TO_PART',
    reason:
      `The claim is stated for ${claimLabel}, narrower than ${contextLabel}` +
      `${wider.length ? ` (${wider.join(', ')} is part of it)` : ''}${silent.length ? ` (the context does not restrict ${silent.join(', ')})` : ''}. ` +
      'It says nothing about the rest.',
  };
}
