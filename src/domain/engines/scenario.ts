import type { ScenarioBaseline, ScenarioDeltas, ScenarioVariant } from '../types.ts';
import { analyzeCvp } from './cvp.ts';

/**
 * Scenario engine: applies deltas to a P&L baseline and reports the outcomes
 * managers actually compare — revenue, contribution, operating profit,
 * break-even — plus the change against baseline.
 */

export type ScenarioOutcome = {
  label: string;
  unitPrice: number;
  units: number;
  variableCostPerUnit: number;
  fixedCosts: number;
  revenue: number;
  contributionMargin: number;
  contributionMarginRatio: number;
  operatingProfit: number;
  breakEvenUnits: number | null;
  profitVsBaseline: number;
  revenueVsBaseline: number;
};

export function resolveInputs(baseline: ScenarioBaseline, deltas?: ScenarioDeltas) {
  const d = deltas ?? {};
  const pct = (v: number | undefined) => 1 + (v ?? 0) / 100;
  return {
    unitPrice: baseline.unitPrice * pct(d.unitPricePct) + (d.unitPriceAbs ?? 0),
    units: baseline.unitsPerPeriod * pct(d.unitsPct) + (d.unitsAbs ?? 0),
    variableCostPerUnit:
      baseline.variableCostPerUnit * pct(d.variableCostPerUnitPct) +
      (d.variableCostPerUnitAbs ?? 0),
    fixedCosts: baseline.fixedCostsPerPeriod * pct(d.fixedCostsPct) + (d.fixedCostsAbs ?? 0),
  };
}

export function evaluateScenario(
  baseline: ScenarioBaseline,
  variant?: ScenarioVariant,
): ScenarioOutcome {
  const base = resolveInputs(baseline);
  const inputs = variant ? resolveInputs(baseline, variant.deltas) : base;

  const cvp = analyzeCvp({
    unitPrice: inputs.unitPrice,
    variableCostPerUnit: inputs.variableCostPerUnit,
    fixedCosts: inputs.fixedCosts,
    units: inputs.units,
  });
  const baseCvp = analyzeCvp({
    unitPrice: base.unitPrice,
    variableCostPerUnit: base.variableCostPerUnit,
    fixedCosts: base.fixedCosts,
    units: base.units,
  });

  const other = baseline.otherIncomePerPeriod ?? 0;

  return {
    label: variant?.name ?? baseline.label,
    unitPrice: inputs.unitPrice,
    units: inputs.units,
    variableCostPerUnit: inputs.variableCostPerUnit,
    fixedCosts: inputs.fixedCosts,
    revenue: cvp.revenue,
    contributionMargin: cvp.totalContributionMargin,
    contributionMarginRatio: cvp.contributionMarginRatio,
    operatingProfit: cvp.operatingProfit + other,
    breakEvenUnits: cvp.breakEvenUnits,
    profitVsBaseline: cvp.operatingProfit - baseCvp.operatingProfit,
    revenueVsBaseline: cvp.revenue - baseCvp.revenue,
  };
}

export type SensitivityBar = {
  variable: 'unitPrice' | 'units' | 'variableCostPerUnit' | 'fixedCosts';
  label: string;
  profitLow: number;
  profitHigh: number;
  /** Swing = |high − low|; the tornado sorts by this. */
  swing: number;
};

/**
 * One-way sensitivity: perturb each driver ±pct while holding the others at
 * baseline, report the profit range. The sort order is the tornado chart.
 */
export function sensitivity(baseline: ScenarioBaseline, pct = 10): SensitivityBar[] {
  const drivers: { variable: SensitivityBar['variable']; label: string; key: keyof ScenarioDeltas }[] = [
    { variable: 'unitPrice', label: 'Selling price', key: 'unitPricePct' },
    { variable: 'units', label: 'Volume', key: 'unitsPct' },
    { variable: 'variableCostPerUnit', label: 'Variable cost / unit', key: 'variableCostPerUnitPct' },
    { variable: 'fixedCosts', label: 'Fixed costs', key: 'fixedCostsPct' },
  ];
  const bars = drivers.map(({ variable, label, key }) => {
    const up = evaluateScenario(baseline, {
      id: 'up',
      name: 'up',
      deltas: { [key]: pct },
    }).operatingProfit;
    const down = evaluateScenario(baseline, {
      id: 'down',
      name: 'down',
      deltas: { [key]: -pct },
    }).operatingProfit;
    const profitLow = Math.min(up, down);
    const profitHigh = Math.max(up, down);
    return { variable, label, profitLow, profitHigh, swing: profitHigh - profitLow };
  });
  return bars.sort((a, b) => b.swing - a.swing);
}
