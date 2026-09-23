/**
 * The allocation trap — the one piece of the pre-kernel relevant-cost engine
 * that survives Phase 5.
 *
 * Its incremental-analysis half (evaluateAlternative / compareAlternatives)
 * was the pre-kernel decision model: hand-typed financial lines compared to
 * pick a "best" alternative. A kernel decision alternative carries no
 * economics of its own — it references the scenario future state that computed
 * them — and HELM does not pick. Both were retired
 * (docs/architecture/decision-engine-assessment.md).
 *
 * What remains is a genuine managerial-accounting check the Economics surface
 * uses, and it decides nothing: it states when a reported net loss hides a
 * positive segment margin.
 */

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
