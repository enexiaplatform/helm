import type {
  CostObject,
  Decision,
  EconomicsRow,
  InventoryItem,
  Process,
  ProcessActivity,
  Signal,
  SignalSeverity,
} from '../types.ts';
import { buildMarginLadder, buildVariances } from './economics.ts';
import { analyzeInventoryItem } from './inventory.ts';
import { analyzeProcess } from './capacity.ts';
import { formatMoney, formatNumber, formatPercent } from '../format.ts';

/**
 * The signal rule engine — HELM's deterministic attention layer.
 *
 * Contract (inherited from Memoire's policy engine): every signal carries the
 * rule that fired, the threshold it was judged against, what was measured,
 * plain-language reasoning, and evidence a manager can verify. Rules never
 * write; converting a signal into a decision is a human act.
 */

export type SignalThresholds = {
  capacityWarnUtilization: number; // e.g. 0.85
  budgetVarianceWarnPct: number; // e.g. 0.10 (absolute)
  expiryExposureWarnValue: number; // currency units
  reviewOverdueGraceDays: number;
};

export const defaultThresholds: SignalThresholds = {
  capacityWarnUtilization: 0.85,
  budgetVarianceWarnPct: 0.1,
  expiryExposureWarnValue: 0,
  reviewOverdueGraceDays: 0,
};

export type SignalCandidate = Omit<
  Signal,
  'id' | 'orgId' | 'status' | 'decisionId' | 'detectedAt'
>;

const candidate = (
  ruleCode: string,
  dedupeKey: string,
  severity: SignalSeverity,
  fields: Omit<SignalCandidate, 'ruleCode' | 'dedupeKey' | 'severity'>,
): SignalCandidate => ({ ruleCode, dedupeKey, severity, ...fields });

export function detectSignals(input: {
  currency: string;
  costObjects: CostObject[];
  economics: EconomicsRow[];
  inventory: InventoryItem[];
  processes: Process[];
  processActivities: ProcessActivity[];
  decisions: Decision[];
  defaultServiceLevel?: number;
  thresholds?: Partial<SignalThresholds>;
  today?: Date;
}): SignalCandidate[] {
  const t = { ...defaultThresholds, ...input.thresholds };
  const today = input.today ?? new Date();
  const out: SignalCandidate[] = [];

  // ---- ECON-TRAP: segment looks unprofitable only because of allocation ----
  for (const co of input.costObjects) {
    const ladder = buildMarginLadder(co, input.economics);
    if (ladder.periods.length === 0) continue;
    if (ladder.allocationTrapped) {
      out.push(
        candidate('ECON-TRAP', `econ-trap:${co.id}`, 'warning', {
          title: `${co.name} looks unprofitable only after allocated costs`,
          reason:
            `${co.name} reports a net loss of ${formatMoney(ladder.reportedNet, input.currency)}, ` +
            `but its segment margin is positive (${formatMoney(ladder.segmentMargin, input.currency)}). ` +
            `Dropping it would remove that contribution while the allocated overhead stays.`,
          thresholdLabel: 'Reported net < 0 while segment margin > 0',
          measuredLabel: `Segment margin ${formatMoney(ladder.segmentMargin, input.currency)}, reported net ${formatMoney(ladder.reportedNet, input.currency)}`,
          evidence: [
            { label: 'Revenue', value: formatMoney(ladder.revenue, input.currency) },
            { label: 'Contribution margin', value: formatMoney(ladder.contributionMargin, input.currency) },
            { label: 'Traceable fixed costs', value: formatMoney(ladder.traceableFixedCost, input.currency) },
            { label: 'Allocated fixed costs', value: formatMoney(ladder.allocatedFixedCost, input.currency) },
          ],
          entityKind: 'cost_object',
          entityId: co.id,
          suggestedDecisionType: 'keep_or_drop',
        }),
      );
    } else if (ladder.segmentMargin < 0 && ladder.revenue > 0) {
      out.push(
        candidate('ECON-NEG', `econ-neg:${co.id}`, 'warning', {
          title: `${co.name} has a negative segment margin`,
          reason:
            `${co.name} does not cover its own traceable costs ` +
            `(segment margin ${formatMoney(ladder.segmentMargin, input.currency)}). This is a real ` +
            `economics problem, not an allocation artifact.`,
          thresholdLabel: 'Segment margin < 0',
          measuredLabel: formatMoney(ladder.segmentMargin, input.currency),
          evidence: [
            { label: 'Revenue', value: formatMoney(ladder.revenue, input.currency) },
            { label: 'Variable cost', value: formatMoney(ladder.variableCost, input.currency) },
            { label: 'Traceable fixed costs', value: formatMoney(ladder.traceableFixedCost, input.currency) },
          ],
          entityKind: 'cost_object',
          entityId: co.id,
          suggestedDecisionType: 'keep_or_drop',
        }),
      );
    }
  }

  // ---- BUD-VAR: actual vs budget variance beyond threshold ----
  const variances = buildVariances(input.costObjects, input.economics);
  const latestPeriod = variances.map((v) => v.period).sort().at(-1);
  for (const v of variances.filter((x) => x.period === latestPeriod)) {
    const pct = v.revenueVariancePct;
    if (pct === null || Math.abs(pct) < t.budgetVarianceWarnPct) continue;
    const adverse = pct < 0;
    out.push(
      candidate('BUD-VAR', `bud-var:${v.costObjectId}:${v.period}`, adverse ? 'warning' : 'info', {
        title: `${v.name}: revenue ${adverse ? 'behind' : 'ahead of'} budget by ${formatPercent(Math.abs(pct))}`,
        reason:
          `${v.name} booked ${formatMoney(v.actualRevenue, input.currency)} against a budget of ` +
          `${formatMoney(v.budgetRevenue, input.currency)} in ${v.period}.`,
        thresholdLabel: `|variance| ≥ ${formatPercent(t.budgetVarianceWarnPct)}`,
        measuredLabel: formatPercent(pct),
        evidence: [
          { label: 'Actual revenue', value: formatMoney(v.actualRevenue, input.currency) },
          { label: 'Budget revenue', value: formatMoney(v.budgetRevenue, input.currency) },
          { label: 'Profit variance', value: formatMoney(v.profitVariance, input.currency) },
        ],
        entityKind: 'cost_object',
        entityId: v.costObjectId,
        suggestedDecisionType: 'resource_allocation',
      }),
    );
  }

  // ---- INV-STOCKOUT / INV-EXPIRY ----
  for (const item of input.inventory) {
    const a = analyzeInventoryItem(item, input.defaultServiceLevel ?? 0.95, today);
    if (a.stockoutRisk) {
      const days = a.daysUntilStockout;
      out.push(
        candidate('INV-STOCKOUT', `inv-stockout:${item.id}`, 'critical', {
          title: `${item.name} is below reorder point — stock-out risk`,
          reason:
            `Projected stock (${formatNumber(item.stockOnHand + item.stockInbound)} units) is below ` +
            `the reorder point of ${formatNumber(a.reorderPoint)} units` +
            (days !== null ? `; roughly ${formatNumber(days)} days of demand remain.` : '.'),
          thresholdLabel: `On hand + inbound < reorder point (${formatNumber(a.reorderPoint)})`,
          measuredLabel: `${formatNumber(item.stockOnHand + item.stockInbound)} units`,
          evidence: [
            { label: 'On hand', value: `${formatNumber(item.stockOnHand)} units` },
            { label: 'Inbound', value: `${formatNumber(item.stockInbound)} units` },
            { label: 'Avg daily demand', value: `${formatNumber(item.avgDailyDemand, 1)} units` },
            { label: 'Lead time', value: `${formatNumber(item.leadTimeDays)} days` },
            { label: 'Safety stock', value: `${formatNumber(a.safetyStock)} units` },
          ],
          entityKind: 'inventory_item',
          entityId: item.id,
          suggestedDecisionType: 'inventory_commitment',
        }),
      );
    }
    if ((a.expiryExposureValue ?? 0) > t.expiryExposureWarnValue && (a.expiryExposureUnits ?? 0) > 0) {
      out.push(
        candidate('INV-EXPIRY', `inv-expiry:${item.id}`, 'warning', {
          title: `${item.name} carries expiry-risk stock`,
          reason:
            `${formatNumber(a.expiryExposureUnits ?? 0)} units cannot sell through before expiry at the ` +
            `current run-rate — ${formatMoney(a.expiryExposureValue ?? 0, input.currency)} of capital at risk.`,
          thresholdLabel: 'Stock beyond sellable-before-expiry demand',
          measuredLabel: `${formatNumber(a.expiryExposureUnits ?? 0)} units at risk`,
          evidence: [
            { label: 'On hand', value: `${formatNumber(item.stockOnHand)} units` },
            { label: 'Expiry date', value: item.expiryDate ?? '—' },
            { label: 'Avg daily demand', value: `${formatNumber(item.avgDailyDemand, 1)} units` },
            { label: 'Capital at risk', value: formatMoney(a.expiryExposureValue ?? 0, input.currency) },
          ],
          entityKind: 'inventory_item',
          entityId: item.id,
          suggestedDecisionType: 'inventory_commitment',
        }),
      );
    }
  }

  // ---- CAP-BOTTLENECK: utilization beyond threshold ----
  for (const p of input.processes) {
    const acts = input.processActivities.filter((a) => a.processId === p.id);
    if (acts.length === 0) continue;
    const analysis = analyzeProcess(p, acts);
    const u = analysis.utilization;
    if (u === null || u < t.capacityWarnUtilization) continue;
    const bottleneck = analysis.activities.find((a) => a.isBottleneck);
    out.push(
      candidate(
        'CAP-BOTTLENECK',
        `cap-bottleneck:${p.id}`,
        u >= 1 ? 'critical' : 'warning',
        {
          title:
            u >= 1
              ? `${p.name} cannot meet demand — bottleneck at ${bottleneck?.name ?? 'unknown'}`
              : `${p.name} is running at ${formatPercent(u, 0)} of capacity`,
          reason:
            `Demand is ${formatNumber(p.demandPerWeek)} units/week against a process capacity of ` +
            `${formatNumber(analysis.processCapacityPerWeek ?? 0)} set by ${bottleneck?.name ?? '—'}.` +
            (u >= 1 ? ' Work is queuing; lead times will grow until capacity or demand changes.' : ''),
          thresholdLabel: `Utilization ≥ ${formatPercent(t.capacityWarnUtilization, 0)}`,
          measuredLabel: formatPercent(u, 0),
          evidence: [
            { label: 'Demand / week', value: formatNumber(p.demandPerWeek) },
            { label: 'Process capacity / week', value: formatNumber(analysis.processCapacityPerWeek ?? 0) },
            { label: 'Bottleneck', value: bottleneck?.name ?? '—' },
            { label: 'Bottleneck owner', value: bottleneck?.ownerLabel || '—' },
          ],
          entityKind: 'process',
          entityId: p.id,
          suggestedDecisionType: 'hire_or_outsource',
        },
      ),
    );
  }

  // ---- DEC-REVIEW: decisions past their review date ----
  for (const d of input.decisions) {
    if (d.status !== 'monitoring' && d.status !== 'executing') continue;
    if (!d.reviewAfter) continue;
    const reviewDate = new Date(d.reviewAfter);
    const graceMs = t.reviewOverdueGraceDays * 24 * 3600 * 1000;
    if (today.getTime() - reviewDate.getTime() <= graceMs) continue;
    out.push(
      candidate('DEC-REVIEW', `dec-review:${d.id}`, 'watch', {
        title: `Decision "${d.title}" is due for outcome review`,
        reason:
          `The decision has been in ${d.status} since its review date (${d.reviewAfter}). ` +
          `Compare expected vs actual and close it with a lesson.`,
        thresholdLabel: `Review date passed`,
        measuredLabel: d.reviewAfter,
        evidence: [
          { label: 'Status', value: d.status },
          { label: 'Expected outcome', value: d.expectedOutcome || '—' },
        ],
        entityKind: 'decision',
        entityId: d.id,
      }),
    );
  }

  const severityRank: Record<SignalSeverity, number> = {
    critical: 3,
    warning: 2,
    watch: 1,
    info: 0,
  };
  return out.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
}
