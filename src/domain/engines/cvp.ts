/**
 * Cost-Volume-Profit engine. Pure, deterministic, unit-tested.
 *
 * Everything here works from the managerial-accounting identity:
 *   operating profit = units × (price − variable cost per unit) − fixed costs
 */

export type CvpInputs = {
  unitPrice: number;
  variableCostPerUnit: number;
  fixedCosts: number;
  units?: number;
};

export type CvpResult = {
  contributionMarginPerUnit: number;
  contributionMarginRatio: number;
  breakEvenUnits: number | null;
  breakEvenRevenue: number | null;
  revenue: number;
  totalVariableCost: number;
  totalContributionMargin: number;
  operatingProfit: number;
  marginOfSafetyUnits: number | null;
  marginOfSafetyRatio: number | null;
  /** Degree of operating leverage at the given volume (CM / operating profit). */
  operatingLeverage: number | null;
};

export function analyzeCvp(inputs: CvpInputs): CvpResult {
  const { unitPrice, variableCostPerUnit, fixedCosts } = inputs;
  const units = inputs.units ?? 0;

  const cmPerUnit = unitPrice - variableCostPerUnit;
  const cmRatio = unitPrice !== 0 ? cmPerUnit / unitPrice : 0;

  // Break-even is undefined when contribution margin is non-positive: no
  // volume ever covers fixed costs. Returning null keeps callers honest.
  const breakEvenUnits = cmPerUnit > 0 ? fixedCosts / cmPerUnit : null;
  const breakEvenRevenue = breakEvenUnits !== null ? breakEvenUnits * unitPrice : null;

  const revenue = units * unitPrice;
  const totalVariableCost = units * variableCostPerUnit;
  const totalContributionMargin = units * cmPerUnit;
  const operatingProfit = totalContributionMargin - fixedCosts;

  const marginOfSafetyUnits = breakEvenUnits !== null ? units - breakEvenUnits : null;
  const marginOfSafetyRatio =
    breakEvenUnits !== null && units > 0 ? (units - breakEvenUnits) / units : null;

  const operatingLeverage =
    operatingProfit !== 0 ? totalContributionMargin / operatingProfit : null;

  return {
    contributionMarginPerUnit: cmPerUnit,
    contributionMarginRatio: cmRatio,
    breakEvenUnits,
    breakEvenRevenue,
    revenue,
    totalVariableCost,
    totalContributionMargin,
    operatingProfit,
    marginOfSafetyUnits,
    marginOfSafetyRatio,
    operatingLeverage,
  };
}

/** Units required to hit a target operating profit. Null when CM ≤ 0. */
export function unitsForTargetProfit(inputs: CvpInputs, targetProfit: number): number | null {
  const cmPerUnit = inputs.unitPrice - inputs.variableCostPerUnit;
  if (cmPerUnit <= 0) return null;
  return (inputs.fixedCosts + targetProfit) / cmPerUnit;
}

export type ProductMix = {
  name: string;
  unitPrice: number;
  variableCostPerUnit: number;
  mixShare: number; // fraction of total units, must sum to 1 across products
};

export type MultiProductCvpResult = {
  weightedCmPerUnit: number;
  breakEvenTotalUnits: number | null;
  breakEvenByProduct: { name: string; units: number }[] | null;
};

/**
 * Multi-product break-even under a constant sales mix — the standard
 * weighted-contribution-margin treatment.
 */
export function analyzeMultiProductCvp(
  products: ProductMix[],
  fixedCosts: number,
): MultiProductCvpResult {
  const totalShare = products.reduce((s, p) => s + p.mixShare, 0);
  if (products.length === 0 || Math.abs(totalShare - 1) > 1e-6) {
    return { weightedCmPerUnit: 0, breakEvenTotalUnits: null, breakEvenByProduct: null };
  }
  const weightedCmPerUnit = products.reduce(
    (s, p) => s + p.mixShare * (p.unitPrice - p.variableCostPerUnit),
    0,
  );
  if (weightedCmPerUnit <= 0) {
    return { weightedCmPerUnit, breakEvenTotalUnits: null, breakEvenByProduct: null };
  }
  const breakEvenTotalUnits = fixedCosts / weightedCmPerUnit;
  return {
    weightedCmPerUnit,
    breakEvenTotalUnits,
    breakEvenByProduct: products.map((p) => ({
      name: p.name,
      units: breakEvenTotalUnits * p.mixShare,
    })),
  };
}
