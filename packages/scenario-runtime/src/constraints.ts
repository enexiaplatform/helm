/**
 * Feasibility constraints over a future state (ADR-0019 §9).
 *
 * A constraint asks one deterministic question of a state that has already
 * been computed — "does what it requires fit within what is available?" — and
 * answers SATISFIED, BREACHED (by how much) or UNKNOWN. It never searches for a
 * state that would satisfy it: that would be optimization, and HELM shows the
 * breach so a manager can decide what to do about it.
 *
 * Nor is a constraint an authority rule. "Stock cannot cover the order" is a
 * fact about the model; "the GM must approve this" is governance, and belongs
 * to Phase 6.
 *
 * A constraint whose operands are blocked or absent is UNKNOWN, with the
 * reason — never SATISFIED by default.
 */

import {
  decimal,
  greaterThan,
  periodKey,
  samePeriod,
  subtract,
  sumAll,
  toString as decToString,
  type EntityId,
  type Period,
} from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type {
  ConstraintDefinition,
  ConstraintOperand,
  FutureStateValue,
  ScenarioConstraintResult,
} from './types.ts';

type Resolved =
  | { ok: true; value: string; unit: FutureStateValue['unit']; label: string }
  | { ok: false; reason: string };

/**
 * Evaluates every constraint in every period of a state. `subjects` maps an
 * ontology canonical key to the entity id it denotes in this organization.
 */
export function evaluateConstraints(
  definitions: readonly ConstraintDefinition[],
  values: readonly FutureStateValue[],
  periods: readonly Period[],
  subjects: ReadonlyMap<string, EntityId>,
): ScenarioConstraintResult[] {
  const results: ScenarioConstraintResult[] = [];
  for (const period of periods) {
    const inPeriod = values.filter((v) => samePeriod(v.period, period));
    for (const def of definitions) {
      results.push(evaluateOne(def, inPeriod, period, subjects));
    }
  }
  return results;
}

function find(
  values: readonly FutureStateValue[],
  metricKey: string,
  subject: string,
  subjects: ReadonlyMap<string, EntityId>,
): Resolved {
  const entityId = subjects.get(subject);
  if (!entityId) return { ok: false, reason: `${subject} is not in this organization's model` };
  const v = values.find((x) => x.metricKey === metricKey && x.subjectEntityId === entityId);
  if (!v) return { ok: false, reason: `${metricKey} for ${subject} is not part of this state` };
  if (v.value === null) {
    return {
      ok: false,
      reason: `${v.metricName} for ${v.nodeLabel.split(' — ').pop()} is ${v.origin}` +
        (v.reason ? ` (${v.reason})` : ''),
    };
  }
  return { ok: true, value: v.value, unit: v.unit, label: v.nodeLabel };
}

function resolve(
  op: ConstraintOperand,
  values: readonly FutureStateValue[],
  subjects: ReadonlyMap<string, EntityId>,
): Resolved {
  if ('metricKey' in op) return find(values, op.metricKey, op.subject, subjects);
  const parts = op.sumOf.subjects.map((s) => find(values, op.sumOf.metricKey, s, subjects));
  const missing = parts.find((p): p is { ok: false; reason: string } => !p.ok);
  // A sum with a missing part is not a smaller sum; it is an unknown one.
  if (missing) return missing;
  const present = parts as Extract<Resolved, { ok: true }>[];
  if (new Set(present.map((p) => p.unit)).size > 1) {
    return { ok: false, reason: `${op.sumOf.metricKey} values are in different units` };
  }
  return {
    ok: true,
    value: decToString(sumAll(present.map((p) => decimal(p.value)))),
    unit: present[0]?.unit ?? null,
    label: `Σ ${op.sumOf.metricKey}`,
  };
}

function evaluateOne(
  def: ConstraintDefinition,
  values: readonly FutureStateValue[],
  period: Period,
  subjects: ReadonlyMap<string, EntityId>,
): ScenarioConstraintResult {
  const base = {
    constraintKey: def.key,
    constraintVersion: def.version,
    name: def.name,
    kind: def.kind,
    period,
    severity: def.severity,
  };
  const required = resolve(def.required, values, subjects);
  const available = resolve(def.available, values, subjects);
  if (!required.ok || !available.ok) {
    const why = [required, available]
      .filter((r): r is { ok: false; reason: string } => !r.ok)
      .map((r) => r.reason)
      .join('; ');
    return {
      ...base,
      status: 'UNKNOWN',
      threshold: available.ok ? canonicalNumeric(available.value) : null,
      actual: required.ok ? canonicalNumeric(required.value) : null,
      breachAmount: null,
      unit: required.ok ? required.unit : available.ok ? available.unit : null,
      explanation: `Cannot judge ${def.name.toLowerCase()} in ${periodKey(period)}: ${why}.`,
    };
  }
  if (required.unit !== available.unit) {
    return {
      ...base,
      status: 'UNKNOWN',
      threshold: canonicalNumeric(available.value),
      actual: canonicalNumeric(required.value),
      breachAmount: null,
      unit: null,
      explanation: `Required is in ${required.unit} but available is in ${available.unit}.`,
    };
  }
  const req = decimal(required.value);
  const avail = decimal(available.value);
  const unit = required.unit;
  const u = unit ?? '';
  if (greaterThan(req, avail)) {
    const breach = canonicalNumeric(decToString(subtract(req, avail)));
    return {
      ...base,
      status: 'BREACHED',
      threshold: canonicalNumeric(available.value),
      actual: canonicalNumeric(required.value),
      breachAmount: breach,
      unit,
      explanation:
        `Requires ${canonicalNumeric(required.value)} ${u}; ${canonicalNumeric(available.value)} ` +
        `${u} available in ${periodKey(period)} — breached by ${breach} ${u}.`,
    };
  }
  return {
    ...base,
    status: 'SATISFIED',
    threshold: canonicalNumeric(available.value),
    actual: canonicalNumeric(required.value),
    breachAmount: null,
    unit,
    explanation:
      `Requires ${canonicalNumeric(required.value)} ${u}; ${canonicalNumeric(available.value)} ` +
      `${u} available in ${periodKey(period)}.`,
  };
}

/** Every canonical key a constraint set refers to. */
export function constraintSubjects(definitions: readonly ConstraintDefinition[]): string[] {
  const keys = new Set<string>();
  const add = (op: ConstraintOperand) => {
    if ('metricKey' in op) keys.add(op.subject);
    else op.sumOf.subjects.forEach((s) => keys.add(s));
  };
  for (const d of definitions) {
    add(d.required);
    add(d.available);
  }
  return [...keys].sort();
}
