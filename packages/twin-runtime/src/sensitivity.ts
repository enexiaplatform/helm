/**
 * Sensitivity and visibility (ADR-0025).
 *
 * A deliberately small model — five classes, not a DLP product — with three
 * rules that make it deterministic:
 *
 *   1. SENSITIVITY LIVES ON THE VALUE. A value inherits the class of its
 *      metric (Gross Margin is FINANCIAL_SENSITIVE wherever it appears), unless
 *      its value node declares a stricter one. Structural, decision and
 *      governance items are GENERAL_MANAGEMENT; the financial figures behind
 *      them are separate value items with their own class.
 *   2. A CONTAINER'S LABEL IS DERIVED, NEVER DECLARED. A snapshot or a future
 *      state carries the union of its contents' classes. A scenario called
 *      "Option B" that contains gross margin is FINANCIAL_SENSITIVE because of
 *      what it contains, not because of what it is called — and a generic
 *      title can never make its figures broadly visible, because each figure is
 *      checked on its own.
 *   3. GENERAL_MANAGEMENT NEEDS NO CLEARANCE; every other class needs an
 *      explicit, time-bounded clearance (org admins hold all of them). Classes
 *      are compartments, not levels: FINANCIAL clearance does not open HR.
 *
 * Visibility is not authority. Nothing here consults the authority engine, and
 * nothing in the authority engine consults this. Being able to read the
 * margin says nothing about being allowed to commit the decision behind it.
 */

import { canSeeDecision, visibleUnits, type OrgUnit } from '@helm/authority-runtime';
import type { SensitivityClass, TwinItem, TwinSnapshot } from './types.ts';

/**
 * The shipped class of each system metric. Mirrored into
 * `helm_value_metrics.sensitivity` by the Phase 7 migration; verify:twin-schema
 * fails if the two disagree.
 */
export const METRIC_SENSITIVITY: Readonly<Record<string, SensitivityClass>> = {
  GrossMargin: 'FINANCIAL_SENSITIVE',
  GrossMarginPct: 'FINANCIAL_SENSITIVE',
  Cogs: 'FINANCIAL_SENSITIVE',
  CashImpact: 'FINANCIAL_SENSITIVE',
  WorkingCapital: 'FINANCIAL_SENSITIVE',
  UnitCost: 'FINANCIAL_SENSITIVE',
  Opex: 'FINANCIAL_SENSITIVE',
  InventoryValue: 'FINANCIAL_SENSITIVE',
  Ebitda: 'FINANCIAL_SENSITIVE',
  AverageSellingPrice: 'COMMERCIAL_CONFIDENTIAL',
  OpportunityValue: 'COMMERCIAL_CONFIDENTIAL',
  OpportunityProbability: 'COMMERCIAL_CONFIDENTIAL',
  ExpectedRevenue: 'COMMERCIAL_CONFIDENTIAL',
  CustomerValue: 'COMMERCIAL_CONFIDENTIAL',
  RevenueAtRisk: 'COMMERCIAL_CONFIDENTIAL',
  StrategicAlignment: 'STRATEGIC_RESTRICTED',
};

export function sensitivityOfMetric(metricKey: string, declared?: unknown): SensitivityClass {
  if (typeof declared === 'string' && (SENSITIVITY_ORDER as readonly string[]).includes(declared)) return declared as SensitivityClass;
  return METRIC_SENSITIVITY[metricKey] ?? 'GENERAL_MANAGEMENT';
}

/** Display and storage order only. It is NOT a hierarchy (rule 3). */
export const SENSITIVITY_ORDER: readonly SensitivityClass[] = [
  'GENERAL_MANAGEMENT',
  'FINANCIAL_SENSITIVE',
  'COMMERCIAL_CONFIDENTIAL',
  'HR_RESTRICTED',
  'STRATEGIC_RESTRICTED',
];

/** Rule 2: the derived label of a set of items. */
export function containerSensitivity(items: readonly Pick<TwinItem, 'sensitivity'>[]): SensitivityClass[] {
  const present = new Set(items.map((i) => i.sensitivity));
  return SENSITIVITY_ORDER.filter((c) => present.has(c));
}

export type SensitivityClearance = {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sensitivity: SensitivityClass;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly reason: string;
  readonly grantedBy: string | null;
  readonly recordedAt: string;
};

export type TwinViewer = {
  readonly userId: string;
  readonly orgRole: 'admin' | 'manager' | 'member' | 'viewer';
  readonly memberUnitIds: readonly string[];
  readonly clearances: readonly SensitivityClearance[];
};

const openAt = (from: string, to: string | null, at: string): boolean =>
  Date.parse(from) <= Date.parse(at) && (to === null || Date.parse(at) < Date.parse(to));

/** Rule 3. */
export function isCleared(viewer: TwinViewer, sensitivity: SensitivityClass, at: string): boolean {
  if (sensitivity === 'GENERAL_MANAGEMENT') return true;
  if (viewer.orgRole === 'admin') return true;
  return viewer.clearances.some((c) => c.userId === viewer.userId && c.sensitivity === sensitivity && openAt(c.validFrom, c.validTo, at));
}

/**
 * Who may read a snapshot: org admins, whoever built it, and members of a
 * granted unit or of any unit above one — the same subtree rule decisions use.
 * A Pharma BU snapshot granted to the Pharma BU is read by the Pharma BU and by
 * Vietnam above it, never by the Industrial BU beside it.
 */
export function canSeeSnapshot(
  viewer: TwinViewer,
  snapshot: Pick<TwinSnapshot, 'builtBy' | 'grantedUnitIds'>,
  units: readonly OrgUnit[],
): { visible: boolean; reason: string } {
  return canSeeDecision(
    { userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds },
    { createdBy: snapshot.builtBy, grantedUnitIds: snapshot.grantedUnitIds },
    units,
  );
}

export type ProjectedSnapshot = {
  readonly items: readonly TwinItem[];
  /** Never a silent absence: what was withheld, by class. */
  readonly withheld: readonly { readonly sensitivity: SensitivityClass; readonly count: number }[];
  readonly statement: string;
};

/**
 * What one viewer sees of a snapshot they may read. Items above their
 * clearance are withheld and counted, and the statement says so — a reader must
 * be able to tell "HELM has no margin figure" from "you may not see it".
 */
export function projectForViewer(items: readonly TwinItem[], viewer: TwinViewer, at: string): ProjectedSnapshot {
  const shown: TwinItem[] = [];
  const counts = new Map<SensitivityClass, number>();
  for (const item of items) {
    if (isCleared(viewer, item.sensitivity, at)) shown.push(item);
    else counts.set(item.sensitivity, (counts.get(item.sensitivity) ?? 0) + 1);
  }
  const withheld = SENSITIVITY_ORDER.filter((c) => counts.has(c)).map((c) => ({ sensitivity: c, count: counts.get(c)! }));
  const statement =
    withheld.length === 0
      ? 'Every item of this snapshot is within your clearance.'
      : `${withheld.map((w) => `${w.count} ${w.sensitivity} item${w.count === 1 ? '' : 's'}`).join(', ')} withheld: ` +
        'they exist in this snapshot and are above your clearance. Nothing was removed from the snapshot itself.';
  return { items: shown, withheld, statement };
}

/**
 * SCENARIO VISIBILITY (ADR-0025 §3) — the kernel statement of
 * `helm_private.can_see_scenario()`.
 *
 * A scenario can exist before any decision binds it, so it has its own rule:
 *
 *   visible ⇔ org admin
 *          ∨ its creator
 *          ∨ a member of a unit the scenario is shared with (or above one)
 *          ∨ it is bound to a decision the viewer can see
 *          ∨ it is ORG_WIDE and bound to no decision
 *
 * Binding a scenario to a decision CAPTURES it: from then on the org-wide
 * default no longer applies and it inherits the audience of the decisions that
 * use it. A future that became the basis of a restricted decision stops being
 * readable by everyone, whatever it was called. And each value inside it still
 * passes its own sensitivity check.
 */
export type ScenarioVisibilityFacts = {
  readonly createdBy: string | null;
  readonly visibility: 'ORG_WIDE' | 'RESTRICTED';
  readonly grantedUnitIds: readonly string[];
  /** Decisions whose alternatives bind this scenario, with their visibility facts. */
  readonly boundDecisions: readonly { readonly createdBy: string | null; readonly grantedUnitIds: readonly string[] }[];
};

export function canSeeScenario(
  viewer: TwinViewer,
  facts: ScenarioVisibilityFacts,
  units: readonly OrgUnit[],
): { visible: boolean; reason: string } {
  if (viewer.orgRole === 'admin') return { visible: true, reason: 'organization admin' };
  if (facts.createdBy !== null && facts.createdBy === viewer.userId) return { visible: true, reason: 'created the scenario' };
  const seen = visibleUnits(units, viewer.memberUnitIds);
  if (facts.grantedUnitIds.some((u) => seen.has(u))) return { visible: true, reason: 'member of a unit the scenario is shared with' };
  for (const d of facts.boundDecisions) {
    if (canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, d, units).visible) {
      return { visible: true, reason: 'bound to a decision the viewer can see' };
    }
  }
  if (facts.boundDecisions.length === 0 && facts.visibility === 'ORG_WIDE') {
    return { visible: true, reason: 'an org-wide scenario no decision has captured' };
  }
  return {
    visible: false,
    reason:
      facts.boundDecisions.length > 0
        ? 'bound to decisions the viewer cannot see; binding captured it'
        : 'restricted and not shared with the viewer',
  };
}
