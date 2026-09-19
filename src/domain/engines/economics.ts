import type { CostObject, EconomicsRow } from '../types.ts';
import { allocationTrap } from './relevantCost.ts';

/**
 * Cost-object economics: the margin ladder managers should reason with, and
 * the allocation-trap flag that stops "unprofitable on paper" segments from
 * being dropped when they still cover their own costs.
 *
 *   revenue
 *   − variable cost        = contribution margin
 *   − traceable fixed      = segment margin      ← the decision-relevant line
 *   − allocated fixed      = reported net        ← the misleading line
 */

export type MarginLadder = {
  costObjectId: string;
  name: string;
  kind: CostObject['kind'];
  periods: string[];
  revenue: number;
  variableCost: number;
  contributionMargin: number;
  contributionMarginRatio: number | null;
  traceableFixedCost: number;
  segmentMargin: number;
  segmentMarginRatio: number | null;
  allocatedFixedCost: number;
  reportedNet: number;
  /** Reported net is negative but the segment still funds common overhead. */
  allocationTrapped: boolean;
  units: number | null;
};

export function buildMarginLadder(
  costObject: CostObject,
  rows: EconomicsRow[],
): MarginLadder {
  const mine = rows.filter((r) => r.costObjectId === costObject.id && r.kind === 'actual');
  const sum = (f: (r: EconomicsRow) => number) => mine.reduce((s, r) => s + f(r), 0);

  const revenue = sum((r) => r.revenue);
  const variableCost = sum((r) => r.variableCost);
  const traceableFixedCost = sum((r) => r.traceableFixedCost);
  const allocatedFixedCost = sum((r) => r.allocatedFixedCost);
  const unitsRows = mine.filter((r) => r.units !== null);
  const units = unitsRows.length > 0 ? unitsRows.reduce((s, r) => s + (r.units ?? 0), 0) : null;

  const contributionMargin = revenue - variableCost;
  const segmentMargin = contributionMargin - traceableFixedCost;
  const trap = allocationTrap({
    revenue,
    variableCost,
    traceableFixedCost,
    allocatedFixedCost,
  });

  return {
    costObjectId: costObject.id,
    name: costObject.name,
    kind: costObject.kind,
    periods: [...new Set(mine.map((r) => r.period))].sort(),
    revenue,
    variableCost,
    contributionMargin,
    contributionMarginRatio: revenue !== 0 ? contributionMargin / revenue : null,
    traceableFixedCost,
    segmentMargin,
    segmentMarginRatio: revenue !== 0 ? segmentMargin / revenue : null,
    allocatedFixedCost,
    reportedNet: trap.reportedNet,
    allocationTrapped: trap.trapped,
    units,
  };
}

export type VarianceRow = {
  costObjectId: string;
  name: string;
  period: string;
  actualRevenue: number;
  budgetRevenue: number;
  revenueVariance: number;
  revenueVariancePct: number | null;
  actualProfit: number;
  budgetProfit: number;
  profitVariance: number;
};

/** Budget-vs-actual comparison per cost object and period. */
export function buildVariances(
  costObjects: CostObject[],
  rows: EconomicsRow[],
): VarianceRow[] {
  const out: VarianceRow[] = [];
  const profit = (r: EconomicsRow) =>
    r.revenue - r.variableCost - r.traceableFixedCost - r.allocatedFixedCost;

  for (const co of costObjects) {
    const actuals = rows.filter((r) => r.costObjectId === co.id && r.kind === 'actual');
    for (const a of actuals) {
      const budget = rows.find(
        (r) => r.costObjectId === co.id && r.period === a.period && r.kind === 'budget',
      );
      if (!budget) continue;
      out.push({
        costObjectId: co.id,
        name: co.name,
        period: a.period,
        actualRevenue: a.revenue,
        budgetRevenue: budget.revenue,
        revenueVariance: a.revenue - budget.revenue,
        revenueVariancePct:
          budget.revenue !== 0 ? (a.revenue - budget.revenue) / budget.revenue : null,
        actualProfit: profit(a),
        budgetProfit: profit(budget),
        profitVariance: profit(a) - profit(budget),
      });
    }
  }
  return out;
}
