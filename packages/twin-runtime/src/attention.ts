/**
 * Management attention — conditions, not priorities.
 *
 * Every attention item is raised by a NAMED rule over twin items that already
 * exist, and references the items that raised it (and through them the kernel
 * objects: constraint → scenario run → calculation → observation). There is no
 * score, no weight, no ranking and no AI: two attention items are two
 * conditions, listed, and which one matters more is management's call.
 *
 * "Material" is a stated line, not a judgement: MATERIALITY_V1 below, labelled
 * as a demo policy until an organization states its own.
 */

import { abs, compare, decimal, subtract, toString as decToString } from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import { SENSITIVITY_ORDER } from './sensitivity.ts';
import type { AttentionCondition, AttentionState, KernelRef, TwinItem } from './types.ts';

export const MATERIALITY_V1 = {
  key: 'helm-demo-materiality@1',
  demo: true,
  statement: 'DEMO MATERIALITY POLICY — the lines below are illustrative until an organization states its own.',
  /** Absolute movement at or beyond which a change is material, by unit. */
  byUnit: {
    percentage: '0.5',
    currency: '50000000',
    units: '1',
    count: '1',
    days: '2',
    ratio: '0.01',
    score: '5',
  } as Readonly<Record<string, string>>,
} as const;

export const ATTENTION_RULES_VERSION = `helm-twin-attention@1+${MATERIALITY_V1.key}`;

export function materialLine(unit: string | null): string | null {
  return unit ? (MATERIALITY_V1.byUnit[unit] ?? null) : null;
}

/** |delta| ≥ the unit's line. Null when no line is stated for the unit. */
export function isMaterial(delta: string, unit: string | null): boolean | null {
  const line = materialLine(unit);
  if (line === null) return null;
  return compare(abs(decimal(delta)), decimal(line)) >= 0;
}

/** Reading only: a negative number is written with the true minus (−), never a hyphen. */
export const trueMinus = (text: string): string => text.replace(/(^|[\s(:])-(?=\d)/g, '$1−');

export const difference = (to: string, from: string): string => canonicalNumeric(decToString(subtract(decimal(to), decimal(from))));

export const unitSuffix = (unit: string | null, currency: string | null): string =>
  unit === 'percentage' ? ' pts' : unit === 'currency' ? ` ${currency ?? ''}`.trimEnd() : unit ? ` ${unit}` : '';

/** Worse means against the metric's declared direction. CONTEXT_DEPENDENT metrics are never judged. */
export function isDeterioration(directionality: string, delta: string): boolean | null {
  const sign = compare(decimal(delta), decimal('0'));
  if (sign === 0) return false;
  if (directionality === 'HIGHER_IS_BETTER') return sign < 0;
  if (directionality === 'LOWER_IS_BETTER') return sign > 0;
  return null;
}

const ref = (item: TwinItem): KernelRef => ({ kind: 'TWIN_ITEM', id: item.key, pin: null, label: item.label });

export function attentionItem(condition: AttentionCondition, rule: string, statement: string, causes: readonly TwinItem[], discriminator: string | null = null): TwinItem {
  const classes = new Set(causes.map((c) => c.sensitivity));
  const sensitivity = SENSITIVITY_ORDER.slice(1).find((c) => classes.has(c)) ?? 'GENERAL_MANAGEMENT';
  const said = trueMinus(statement);
  const state: AttentionState = { condition, rule, statement: said, causeItemKeys: causes.map((c) => c.key).sort() };
  return {
    key: `attention:${condition}:${causes.map((c) => c.key).sort().join('|')}${discriminator ? `#${discriminator}` : ''}`,
    kind: 'ATTENTION',
    categories: ['ATTENTION'],
    label: said,
    subjectEntityId: causes[0]?.subjectEntityId ?? null,
    layer: null,
    status: 'KNOWN',
    state,
    // The cause items, and the first kernel reference of each: attention never floats free of lineage.
    refs: causes.flatMap((c) => [ref(c), ...c.refs.filter((r) => r.kind !== 'TWIN_ITEM').slice(0, 1)]),
    sensitivity,
    reason: null,
  };
}

const s = (item: TwinItem, key: string): unknown => item.state[key];

/** Conditions a single snapshot shows. `effectiveAsOf` decides which committed periods have ended. */
export function snapshotAttention(items: readonly TwinItem[], effectiveAsOf: string): TwinItem[] {
  const out: TwinItem[] = [];
  const byKind = (k: TwinItem['kind']) => items.filter((i) => i.kind === k);

  for (const c of byKind('CONSTRAINT')) {
    if (s(c, 'status') !== 'BREACHED') continue;
    out.push(
      attentionItem(
        'CONSTRAINT_BREACHED',
        'constraint-breached@1: a feasibility constraint of the modelled state is BREACHED',
        `${c.label} is breached: ${s(c, 'actual')} required against ${s(c, 'threshold')} available (short by ${s(c, 'breachAmount')}).`,
        [c],
      ),
    );
  }
  for (const d of byKind('DECISION')) {
    if (s(d, 'open') !== true) continue;
    out.push(attentionItem('DECISION_AWAITING_COMMITMENT', 'decision-open@1: a decision in scope has not been committed', `"${d.label}" is ${String(s(d, 'state')).replaceAll('_', ' ').toLowerCase()} and awaits commitment.`, [d]));
    for (const a of (s(d, 'alternatives') as { label: string; completeness: string | null }[] | undefined) ?? []) {
      if (a.completeness === 'PARTIAL' || a.completeness === 'INVALID') {
        out.push(attentionItem('SCENARIO_INCOMPLETE', 'scenario-incomplete@1: an alternative of an open decision rests on an incomplete future', `Alternative "${a.label}" of "${d.label}" rests on a ${a.completeness} future.`, [d], a.label));
      }
    }
  }
  for (const g of byKind('GOVERNANCE')) {
    const state = s(g, 'state');
    if (state === 'PENDING_APPROVAL' || state === 'ESCALATED') {
      out.push(attentionItem('APPROVAL_PENDING', 'approval-pending@1: a commitment awaits a required approval', `${g.label.replace(/^Governance of /, '')} awaits ${(s(g, 'pending') as string[]).join(' and ')}.`, [g]));
    } else if (state === 'NOT_AUTHORIZED' || state === 'REJECTED') {
      out.push(attentionItem('COMMITMENT_NOT_AUTHORIZED', 'commitment-not-authorized@1: a commitment stands without the authority it needs', `${g.label.replace(/^Governance of /, '')} is ${String(state).replaceAll('_', ' ')}.`, [g]));
    } else if (state === 'NOT_EVALUATED' || state === 'INDETERMINATE') {
      out.push(attentionItem('AUTHORITY_UNRESOLVED', 'authority-unresolved@1: authority over a commitment is not established', `Authority over ${g.label.replace(/^Governance of /, '')} is ${String(state).replaceAll('_', ' ')}.`, [g]));
    }
  }
  for (const a of byKind('ASSUMPTION')) {
    if (s(a, 'challenged') === true) {
      out.push(attentionItem('ASSUMPTION_CHALLENGED', 'assumption-challenged@1: an assumption carries an open challenge', `Challenged: "${a.label}".`, [a]));
    }
    if (s(a, 'outcome') === 'DISPROVED' && (s(a, 'criticality') === 'CRITICAL' || s(a, 'criticality') === 'MATERIAL')) {
      out.push(attentionItem('CRITICAL_ASSUMPTION_DISPROVED', 'assumption-disproved@1: a critical or material assumption was disproved', `Disproved (${String(s(a, 'criticality')).toLowerCase()}): "${a.label}".`, [a]));
    }
  }
  for (const o of byKind('OBJECTIVE')) {
    const suffix = unitSuffix(s(o, 'unit') as string | null, s(o, 'currency') as string | null);
    if (s(o, 'position') === 'SHORT_OF_TARGET') {
      out.push(
        attentionItem(
          'OBJECTIVE_OFF_TRACK',
          'objective-off-track@1: the current reading is on the wrong side of its target',
          `${o.label} is short of target: ${s(o, 'current')} against ${s(o, 'target')} (${s(o, 'varianceToTarget')}${suffix}).`,
          [o],
        ),
      );
    } else if (s(o, 'position') === 'FORECAST_SHORT_OF_TARGET') {
      out.push(
        attentionItem(
          'OBJECTIVE_OFF_TRACK',
          'objective-off-track@1: with no current reading, the forecast is on the wrong side of the target',
          `${o.label}: the forecast ${s(o, 'forecast')} falls short of the ${s(o, 'target')} target (${s(o, 'forecastToTarget')}${suffix}); no current reading yet.`,
          [o],
        ),
      );
    }
  }
  // Committed future vs what the enterprise became, once the committed period has ended.
  const E = Date.parse(effectiveAsOf);
  for (const cf of items.filter((i) => i.kind === 'VALUE' && i.layer === 'COMMITTED_FUTURE' && s(i, 'expectedOutcome') === true)) {
    const periodEnd = s(cf, 'periodEnd') as string | null;
    if (!periodEnd || Date.parse(periodEnd) > E || cf.status !== 'KNOWN') continue;
    const nodeId = s(cf, 'nodeId') as string;
    const period = s(cf, 'period') as string | null;
    const actual =
      items.find((i) => i.kind === 'VALUE' && i.layer === 'ACTUAL' && s(i, 'nodeId') === nodeId && s(i, 'period') === period && i.status === 'KNOWN') ??
      items.find((i) => i.kind === 'VALUE' && i.layer === 'MODELLED' && s(i, 'nodeId') === nodeId && s(i, 'period') === period && i.status === 'KNOWN');
    if (!actual) continue;
    const delta = difference(String(s(actual, 'value')), String(s(cf, 'value')));
    if (isMaterial(delta, s(cf, 'unit') as string | null) !== true) continue;
    out.push(
      attentionItem(
        'COMMITTED_FUTURE_OFF_TRACK',
        `committed-future-off-track@1: an expected outcome of an ended period differs from the ${actual.layer?.toLowerCase()} reading by at least the material line (${MATERIALITY_V1.key})`,
        `${cf.label.replace(/ — committed future$/, '')}: committed ${s(cf, 'value')}, ${actual.layer?.toLowerCase()} ${s(actual, 'value')} (${delta}${unitSuffix(s(cf, 'unit') as string | null, s(cf, 'currency') as string | null)}). Not a verdict on the decision.`,
        [cf, actual],
      ),
    );
  }
  return out;
}
