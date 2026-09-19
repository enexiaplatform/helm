import type { DecisionAlternative, FinancialLine } from '../types.ts';

/**
 * Relevant-cost engine: the incremental analysis behind every decision
 * template (special order, make-vs-buy, keep-vs-drop, …).
 *
 * The managerial-accounting rules enforced here:
 *   - Only future amounts that differ between alternatives are relevant.
 *   - Sunk costs are never relevant. They are shown, labelled, and excluded.
 *   - Allocated fixed costs that do not change with the choice are excluded.
 *   - Opportunity cost of the displaced alternative is included.
 *
 * The engine never hides an exclusion: `excludedLines` is part of the result
 * so the UI can show the manager exactly which numbers were ignored and why.
 */

export type AlternativeEvaluation = {
  alternativeId: string;
  name: string;
  incrementalRevenue: number;
  relevantCosts: number;
  opportunityCost: number;
  /** incrementalRevenue − relevantCosts − opportunityCost */
  netRelevantBenefit: number;
  excludedLines: FinancialLine[];
  includedLines: FinancialLine[];
};

export type RelevantCostComparison = {
  evaluations: AlternativeEvaluation[];
  /** Alternative with the highest net relevant benefit, null on a tie. */
  bestAlternativeId: string | null;
  /** Benefit gap between best and runner-up — the cost of choosing wrong. */
  advantageOverNext: number | null;
};

export function evaluateAlternative(
  alt: Pick<DecisionAlternative, 'id' | 'name' | 'financialLines'>,
): AlternativeEvaluation {
  let incrementalRevenue = 0;
  let relevantCosts = 0;
  let opportunityCost = 0;
  const excludedLines: FinancialLine[] = [];
  const includedLines: FinancialLine[] = [];

  for (const line of alt.financialLines) {
    switch (line.kind) {
      case 'incremental_revenue':
        incrementalRevenue += line.amount;
        includedLines.push(line);
        break;
      case 'relevant_cost':
        relevantCosts += line.amount;
        includedLines.push(line);
        break;
      case 'opportunity_cost':
        opportunityCost += line.amount;
        includedLines.push(line);
        break;
      case 'sunk_ignored':
      case 'allocated_ignored':
        excludedLines.push(line);
        break;
    }
  }

  return {
    alternativeId: alt.id,
    name: alt.name,
    incrementalRevenue,
    relevantCosts,
    opportunityCost,
    netRelevantBenefit: incrementalRevenue - relevantCosts - opportunityCost,
    excludedLines,
    includedLines,
  };
}

export function compareAlternatives(
  alternatives: Pick<DecisionAlternative, 'id' | 'name' | 'financialLines'>[],
): RelevantCostComparison {
  const evaluations = alternatives.map(evaluateAlternative);
  if (evaluations.length === 0) {
    return { evaluations, bestAlternativeId: null, advantageOverNext: null };
  }
  const sorted = [...evaluations].sort((a, b) => b.netRelevantBenefit - a.netRelevantBenefit);
  const best = sorted[0];
  const next = sorted[1];
  const tie = next !== undefined && next.netRelevantBenefit === best.netRelevantBenefit;
  return {
    evaluations,
    bestAlternativeId: tie ? null : best.alternativeId,
    advantageOverNext: next === undefined ? null : best.netRelevantBenefit - next.netRelevantBenefit,
  };
}

/**
 * The classic allocation trap check for keep-vs-drop framing: a segment with
 * positive contribution toward common fixed costs should not be dropped just
 * because allocated costs push its "net income" negative.
 */
export function allocationTrap(input: {
  revenue: number;
  variableCost: number;
  traceableFixedCost: number;
  allocatedFixedCost: number;
}): {
  segmentMargin: number;
  reportedNet: number;
  trapped: boolean;
} {
  const contribution = input.revenue - input.variableCost;
  const segmentMargin = contribution - input.traceableFixedCost;
  const reportedNet = segmentMargin - input.allocatedFixedCost;
  return {
    segmentMargin,
    reportedNet,
    // The trap: reported net is negative but the segment still covers its own
    // costs and contributes to common overhead — dropping it makes the
    // company worse off by the segment margin.
    trapped: reportedNet < 0 && segmentMargin > 0,
  };
}
