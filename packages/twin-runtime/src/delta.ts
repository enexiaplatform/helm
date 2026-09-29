/**
 * Snapshot A → Snapshot B (ADR-0023 §7).
 *
 * Items pair by key — the unit of identity across snapshots — and every change
 * lands in exactly one category, so a structural change never masquerades as a
 * value change and a late-arriving fact never masquerades as the world moving:
 *
 *   STRUCTURAL_CHANGE   entities, relationships, role occupancy
 *   VALUE_CHANGE        a value or objective moved, and the new reading describes
 *                       business time A did not cover
 *   KNOWLEDGE_CHANGE    a value moved because HELM learned something about a time A
 *                       already covered: recorded after A's boundary, effective
 *                       inside A's business time (a restatement, a late feed)
 *   DECISION_CHANGE     decisions, commitments, action intents
 *   ASSUMPTION_CHANGE   assumptions and challenges
 *   GOVERNANCE_CHANGE   authority state, policy versions, delegations
 *   CONSTRAINT_CHANGE   feasibility constraints
 *   ATTENTION_CHANGE    conditions raised or cleared
 *
 * Nothing here is a verdict. A delta says what moved and by how much; whether
 * that is good is management's reading, not HELM's.
 */

import { canonicalJson, itemFingerprintLine } from './fingerprint.ts';
import { ATTENTION_RULES_VERSION, attentionItem, difference, isDeterioration, isMaterial, trueMinus, unitSuffix } from './attention.ts';
import type { AttentionState, ComposedSnapshot, DifferenceCategory, ItemChange, TwinDelta, TwinItem } from './types.ts';

const CATEGORY_OF_KIND: Readonly<Record<TwinItem['kind'], DifferenceCategory>> = {
  ENTITY: 'STRUCTURAL_CHANGE',
  RELATIONSHIP: 'STRUCTURAL_CHANGE',
  ROLE_OCCUPANCY: 'STRUCTURAL_CHANGE',
  VALUE: 'VALUE_CHANGE',
  OBJECTIVE: 'VALUE_CHANGE',
  CONSTRAINT: 'CONSTRAINT_CHANGE',
  DECISION: 'DECISION_CHANGE',
  COMMITMENT: 'DECISION_CHANGE',
  ACTION_INTENT: 'DECISION_CHANGE',
  GOVERNANCE: 'GOVERNANCE_CHANGE',
  POLICY: 'GOVERNANCE_CHANGE',
  DELEGATION: 'GOVERNANCE_CHANGE',
  ASSUMPTION: 'ASSUMPTION_CHANGE',
  CHALLENGE: 'ASSUMPTION_CHANGE',
  ATTENTION: 'ATTENTION_CHANGE',
};

const ms = (t: unknown): number => (typeof t === 'string' ? Date.parse(t) : NaN);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^-?[0-9]+(\.[0-9]+)?$/.test(v);

function valueOf(item: TwinItem): unknown {
  return item.kind === 'OBJECTIVE' ? item.state.current : item.state.value;
}

/** Recorded after A's boundary, about a business time A already covered. */
function isKnowledgeChange(after: TwinItem, from: ComposedSnapshot, to: ComposedSnapshot): boolean {
  if (after.kind !== 'VALUE' && after.kind !== 'OBJECTIVE') return false;
  // Same business time, different knowledge: the world at that instant did not move, so
  // any value that differs is something HELM learned — never the world changing.
  if (ms(from.snapshot.spec.lens.effectiveAsOf) === ms(to.snapshot.spec.lens.effectiveAsOf)) return true;
  if (after.kind !== 'VALUE') return false;
  const recorded = ms(after.state.recordedAt);
  const effective = ms(after.state.effectiveAt);
  return recorded > ms(from.snapshot.spec.lens.recordedThrough) && effective <= ms(from.snapshot.spec.lens.effectiveAsOf);
}

function fieldChanges(before: TwinItem | null, after: TwinItem | null): ItemChange['fields'] {
  if (!before || !after) return [];
  const out: { field: string; before: unknown; after: unknown }[] = [];
  if (before.status !== after.status) out.push({ field: 'status', before: before.status, after: after.status });
  const keys = [...new Set([...Object.keys(before.state), ...Object.keys(after.state)])].sort();
  for (const k of keys) {
    if (canonicalJson(before.state[k]) !== canonicalJson(after.state[k])) out.push({ field: k, before: before.state[k] ?? null, after: after.state[k] ?? null });
  }
  return out;
}

function describe(change: Omit<ItemChange, 'statement'>): string {
  const { before, after } = change;
  const item = after ?? before!;
  if (change.change === 'ADDED') return `${item.label}: appeared.`;
  if (change.change === 'REMOVED') return `${item.label}: no longer present.`;
  if (change.delta !== null && change.delta !== '0') {
    return trueMinus(`${item.label}: ${String(valueOf(before!))} → ${String(valueOf(after!))} (${change.delta.startsWith('-') ? '−' + change.delta.slice(1) : '+' + change.delta}${change.deltaUnit ?? ''}).`);
  }
  const shown = change.fields.filter((f) => !['recordedAt', 'observationId', 'calculationRunId', 'calculationStepId', 'effectiveAt'].includes(f.field)).slice(0, 3);
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? String(v) : Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'changed');
  return trueMinus(
    shown.length > 0
      ? `${item.label}: ${shown.map((f) => `${f.field} ${text(f.before)} → ${text(f.after)}`).join('; ')}.`
      : `${item.label}: the same reading, now from a newer kernel record.`,
  );
}

export function compareComposed(from: ComposedSnapshot, to: ComposedSnapshot): TwinDelta {
  const a = new Map(from.items.map((i) => [i.key, i]));
  const b = new Map(to.items.map((i) => [i.key, i]));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes: ItemChange[] = [];
  let unchanged = 0;
  for (const key of keys) {
    const before = a.get(key) ?? null;
    const after = b.get(key) ?? null;
    if (before && after && itemFingerprintLine(before) === itemFingerprintLine(after)) {
      unchanged += 1;
      continue;
    }
    const item = (after ?? before)!;
    let category = CATEGORY_OF_KIND[item.kind];
    if (after && category === 'VALUE_CHANGE' && isKnowledgeChange(after, from, to)) category = 'KNOWLEDGE_CHANGE';
    let delta: string | null = null;
    let deltaUnit: string | null = null;
    if (before && after && (item.kind === 'VALUE' || item.kind === 'OBJECTIVE')) {
      const x = valueOf(before);
      const y = valueOf(after);
      if (numeric(x) && numeric(y) && before.state.unit === after.state.unit && (before.state.currency ?? null) === (after.state.currency ?? null)) {
        delta = difference(y, x);
        deltaUnit = unitSuffix(after.state.unit as string | null, after.state.currency as string | null);
      }
    }
    const partial = {
      itemKey: key,
      kind: item.kind,
      label: item.label,
      category,
      change: before && after ? ('CHANGED' as const) : after ? ('ADDED' as const) : ('REMOVED' as const),
      before,
      after,
      fields: fieldChanges(before, after),
      delta,
      deltaUnit,
    };
    changes.push({ ...partial, statement: describe(partial) });
  }

  // Conditions only a comparison can see.
  const deltaAttention: AttentionState[] = [];
  for (const c of changes) {
    if (c.change !== 'CHANGED' || c.kind !== 'VALUE' || c.delta === null || !c.after) continue;
    const unit = c.after.state.unit as string | null;
    const worse = isDeterioration(String(c.after.state.directionality), c.delta);
    if (worse !== true) continue;
    if (c.after.categories.includes('RISKS')) {
      deltaAttention.push(
        attentionItem('RISK_EXPOSURE_INCREASED', 'risk-exposure-increased@1: a risk value moved against its direction', `${c.label}: exposure rose ${c.delta}${c.deltaUnit ?? ''}.`, [c.after]).state as unknown as AttentionState,
      );
    } else if (isMaterial(c.delta, unit) === true) {
      deltaAttention.push(
        attentionItem(
          'MATERIAL_VALUE_DETERIORATION',
          `material-deterioration@1: moved against its direction by at least the material line (${ATTENTION_RULES_VERSION})`,
          `${c.label}: ${c.delta}${c.deltaUnit ?? ''} against its direction.`,
          [c.after],
        ).state as unknown as AttentionState,
      );
    }
  }

  const sameScope = canonicalJson(from.snapshot.spec.scope) === canonicalJson(to.snapshot.spec.scope);
  const sameModel = canonicalJson(from.snapshot.model) === canonicalJson(to.snapshot.model);
  const warnings: string[] = [];
  if (!sameScope) warnings.push('The two snapshots describe different scopes; items outside either scope appear as added or removed.');
  if (!sameModel) warnings.push('The two snapshots were read through different model versions.');
  if (from.snapshot.spec.kind !== to.snapshot.spec.kind) {
    warnings.push(
      `A ${from.snapshot.spec.kind} snapshot against a ${to.snapshot.spec.kind} one: value items of different layers never pair by key. ` +
        'For what management expected against what the enterprise became, read the trajectory.',
    );
  }
  if (Date.parse(to.snapshot.spec.lens.recordedThrough) < Date.parse(from.snapshot.spec.lens.recordedThrough)) {
    warnings.push('The later snapshot knows less than the earlier one: its knowledge boundary is earlier.');
  }
  const by = (cat: DifferenceCategory) => changes.filter((c) => c.category === cat);
  const counts = changes.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.category]: (acc[c.category] ?? 0) + 1 }), {});
  const statement =
    changes.length === 0
      ? 'The two snapshots describe the same management state.'
      : `${Object.entries(counts)
          .map(([k, n]) => `${n} ${k.replace('_CHANGE', '').toLowerCase()} change${n === 1 ? '' : 's'}`)
          .join(', ')}; ${unchanged} item${unchanged === 1 ? '' : 's'} unchanged. Nothing is ranked or totalled, and no change is a verdict.`;
  return {
    from: from.snapshot,
    to: to.snapshot,
    comparability: { sameScope, sameModel, warnings },
    structuralChanges: by('STRUCTURAL_CHANGE'),
    valueChanges: by('VALUE_CHANGE'),
    knowledgeChanges: by('KNOWLEDGE_CHANGE'),
    decisionChanges: by('DECISION_CHANGE'),
    assumptionChanges: by('ASSUMPTION_CHANGE'),
    governanceChanges: by('GOVERNANCE_CHANGE'),
    constraintChanges: by('CONSTRAINT_CHANGE'),
    attentionChanges: by('ATTENTION_CHANGE'),
    deltaAttention,
    unchangedCount: unchanged,
    statement,
  };
}
