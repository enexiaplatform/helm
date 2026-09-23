/**
 * Seed value metric definitions — HELM's shipped vocabulary of quantities.
 *
 * DATA, loaded into `helm_value_metrics`. Like the Phase 1 ontology seed, this
 * is written once and feeds the migration, the in-memory adapter and the tests,
 * so the three cannot disagree.
 *
 * Scope discipline: seed what the canonical scenario needs to be expressed
 * well, not hundreds of metrics. Organizations extend this with their own
 * (`org_id` set) without a migration.
 *
 * Every definition carries machine-readable semantics — dimension, unit,
 * aggregation, directionality, temporal behaviour, scope compatibility —
 * because a metric known only by its name is useless to the agents and
 * aggregation logic that arrive in later phases.
 */

import type {
  AggregationBehavior,
  Directionality,
  TimeBehavior,
  UnitType,
  ValueDataType,
  ValueDimension,
} from './types.ts';

export type SeedValueMetric = {
  key: string;
  name: string;
  description: string;
  dimension: ValueDimension;
  unitType: UnitType;
  defaultCurrency?: string | null;
  dataType?: ValueDataType;
  aggregation: AggregationBehavior;
  directionality: Directionality;
  timeBehavior: TimeBehavior;
  scopeCategories?: readonly string[] | null;
  metadata?: Record<string, unknown>;
  /** Registry version of the definition. 1 unless its meaning has been revised. */
  version?: number;
};

const COMMERCIAL_SCOPES = ['commercial', 'market'] as const;
const OPS_SCOPES = ['operations', 'commercial', 'resource'] as const;
const ANY = null;

export const seedValueMetrics: readonly SeedValueMetric[] = [
  // ======================================================== COMMERCIAL
  {
    key: 'OpportunityValue',
    name: 'Opportunity Value',
    description:
      'The full value of an identified revenue event, before any probability weighting.',
    dimension: 'COMMERCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: COMMERCIAL_SCOPES,
  },
  {
    key: 'OpportunityProbability',
    name: 'Opportunity Probability',
    description:
      'Likelihood the opportunity closes, as a proportion. Weighted by value when rolled up, never summed.',
    dimension: 'COMMERCIAL',
    unitType: 'ratio',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: COMMERCIAL_SCOPES,
    metadata: { weightBy: 'OpportunityValue' },
  },
  {
    key: 'ExpectedRevenue',
    name: 'Expected Revenue',
    description:
      'Probability-weighted revenue from an opportunity or pipeline over a period.',
    dimension: 'COMMERCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'Revenue',
    name: 'Revenue',
    description: 'Recognised revenue for a cost object over a period.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'PipelineCoverage',
    name: 'Pipeline Coverage',
    description:
      'Weighted pipeline divided by the target for the period. A coverage ratio, not a sum.',
    dimension: 'COMMERCIAL',
    unitType: 'ratio',
    aggregation: 'NON_AGGREGATABLE',
    directionality: 'TARGET_RANGE',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
    metadata: { typicalTargetRange: [3, 5] },
  },
  {
    key: 'CustomerValue',
    name: 'Customer Value',
    description: 'Cumulative economic value attributable to a customer relationship.',
    dimension: 'CUSTOMER',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'CUMULATIVE',
    scopeCategories: COMMERCIAL_SCOPES,
  },

  // ======================================================== OPERATIONS
  {
    key: 'DemandQuantity',
    name: 'Demand Quantity',
    description: 'Units of a product demanded over a period by a commercial event.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'NEUTRAL',
    timeBehavior: 'PERIOD',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'AvailableInventory',
    name: 'Available Inventory',
    description:
      'Units on hand plus inbound within the horizon, at a specific position. More is not automatically better — it is also capital.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'CONTEXT_DEPENDENT',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'InventoryRequirement',
    name: 'Inventory Requirement',
    description: 'Units needed to serve committed and expected demand over the horizon.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'NEUTRAL',
    timeBehavior: 'PERIOD',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'InventoryGap',
    name: 'Inventory Gap',
    description:
      'Requirement minus available inventory. Positive means demand cannot be served from stock.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'ServiceLevel',
    name: 'Service Level',
    description:
      'Proportion of demand served on time, expressed 0-100. Weighted by volume when rolled up.',
    dimension: 'CUSTOMER',
    unitType: 'percentage',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
    metadata: { weightBy: 'DemandQuantity' },
  },
  {
    key: 'LeadTime',
    name: 'Lead Time',
    description: 'Days between placing a replenishment order and receiving it.',
    dimension: 'OPERATIONAL',
    unitType: 'days',
    aggregation: 'AVERAGE',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'CapacityUtilization',
    name: 'Capacity Utilization',
    description:
      'Demand as a proportion of available capacity, 0-100. Both too low and too high are problems.',
    dimension: 'RESOURCE',
    unitType: 'percentage',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'TARGET_RANGE',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
    // Weighted by the load flowing through each pool, so a busy pool dominates
    // the rolled-up figure rather than every pool counting equally.
    metadata: { typicalTargetRange: [70, 85], weightBy: 'DemandQuantity' },
  },

  // =========================================================== FINANCE
  {
    key: 'UnitCost',
    name: 'Unit Cost',
    description: 'Landed cost of one unit of product.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'AVERAGE',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },
  {
    key: 'AverageSellingPrice',
    name: 'Average Selling Price',
    description:
      'Realised price per unit after discount. Normally a management assumption rather than a measurement, which is why calculations that use it require an ASSUMPTION observation.',
    dimension: 'COMMERCIAL',
    unitType: 'currency',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
    metadata: { weightBy: 'DemandQuantity' },
  },
  {
    key: 'Cogs',
    name: 'Cost of Goods Sold',
    description:
      'Product cost of the units expected to be sold over a period. Distinct from inventory value, which follows what is held rather than what is sold.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'GrossMargin',
    name: 'Gross Margin',
    description: 'Revenue less cost of goods sold, in currency, over a period.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'GrossMarginPct',
    name: 'Gross Margin %',
    description:
      'Gross margin as a proportion of revenue, 0-100. A ratio of sums, so it cannot itself be summed.',
    dimension: 'FINANCIAL',
    unitType: 'percentage',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
    metadata: { weightBy: 'Revenue' },
  },
  {
    key: 'ContributionMargin',
    name: 'Contribution Margin',
    description:
      'Revenue less variable cost. What the cost object contributes toward fixed costs.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'WorkingCapital',
    name: 'Working Capital',
    description:
      'Capital tied up in inventory, receivables and payables. Lower frees cash, but too low starves service.',
    dimension: 'CAPITAL',
    unitType: 'currency',
    aggregation: 'SUM',
    // Revised in Phase 4 (v2): was LOWER_IS_BETTER. The description above
    // already said why that was wrong — lower frees cash but too low starves
    // service — and a comparison that labelled every increase "unfavourable"
    // would take a side the business has not taken. Without an objective or a
    // constraint, a change in working capital is shown, not judged.
    directionality: 'CONTEXT_DEPENDENT',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
    version: 2,
    metadata: { revised: { phase: 4, field: 'directionality', from: 'LOWER_IS_BETTER' } },
  },
  {
    key: 'InventoryValue',
    name: 'Inventory Value',
    description: 'Capital held as stock at a position, at cost.',
    dimension: 'CAPITAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'CONTEXT_DEPENDENT',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'CashImpact',
    name: 'Cash Impact',
    description: 'Net effect on cash over the horizon.',
    dimension: 'CAPITAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'Opex',
    name: 'Operating Expense',
    description: 'Operating cost for a cost object over a period.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },
  {
    key: 'Ebitda',
    name: 'EBITDA',
    description: 'Earnings before interest, tax, depreciation and amortization.',
    dimension: 'FINANCIAL',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },

  // ============================================================== RISK
  {
    key: 'SupplyRisk',
    name: 'Supply Risk',
    description:
      'Exposure to supply failure at a position or product, 0-100. Rolls up as the worst case, not an average.',
    dimension: 'RISK',
    unitType: 'score',
    aggregation: 'MAX',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },
  {
    key: 'CustomerRisk',
    name: 'Customer Risk',
    description: 'Exposure to losing or being unable to serve a customer, 0-100.',
    dimension: 'RISK',
    unitType: 'score',
    aggregation: 'MAX',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },
  {
    key: 'InventoryRisk',
    name: 'Inventory Risk Exposure',
    description: 'Value at risk from expiry, obsolescence or write-down.',
    dimension: 'RISK',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: OPS_SCOPES,
  },
  {
    key: 'ConcentrationRisk',
    name: 'Concentration Risk',
    description:
      'Share of a dimension dependent on a single supplier, customer or product, 0-100.',
    dimension: 'RISK',
    unitType: 'percentage',
    aggregation: 'MAX',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },
  {
    key: 'FutureOpportunityRisk',
    name: 'Future Opportunity Risk',
    description:
      'Value at risk in other opportunities because a constrained resource is committed here. The cost of foreclosing a future option.',
    dimension: 'RISK',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: ANY,
  },

  // ========================================================= STRATEGIC
  {
    key: 'StrategicAlignment',
    name: 'Strategic Alignment',
    description:
      'How well an activity advances stated management objectives, 0-100. Judgemental, not measured.',
    dimension: 'STRATEGIC',
    unitType: 'score',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
    // Weighted by what is at stake: alignment of a large commitment matters
    // more than alignment of a small one.
    metadata: { weightBy: 'ExpectedRevenue' },
  },
  {
    key: 'GrowthPotential',
    name: 'Growth Potential',
    description: 'Headroom for future value creation in a market, segment or portfolio, 0-100.',
    dimension: 'STRATEGIC',
    unitType: 'score',
    aggregation: 'AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },

  // ======================================================== RESILIENCE
  {
    key: 'SourcingResilience',
    name: 'Sourcing Resilience',
    description:
      'Ability to keep supplying if the primary source fails, 0-100. Rolls up as the weakest link.',
    dimension: 'RESILIENCE',
    unitType: 'score',
    aggregation: 'MIN',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'POINT_IN_TIME',
    scopeCategories: ANY,
  },

  // ============================================== PHASE 4 — scenario model
  //
  // The metrics Meridian model v1.1 needs so that scenarios differ in what they
  // BUY, not only in what they cost: whether demand can be served, how much of
  // an order must ship, and what an explicit allocation of stock leaves exposed.
  {
    key: 'OrderQuantity',
    name: 'Order Quantity',
    description:
      'Units the business must deliver if an opportunity is won. Not probability-weighted: ' +
      'feasibility is about what must ship, not what is expected.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'NEUTRAL',
    timeBehavior: 'PERIOD',
    scopeCategories: COMMERCIAL_SCOPES,
    metadata: { introducedIn: 'phase-4' },
  },
  {
    key: 'DemandCoverage',
    name: 'Demand Coverage',
    description:
      "Share of a period's inventory requirement that own stock covers. HELM's proxy for the " +
      'ability to serve — not a measured service level.',
    dimension: 'CUSTOMER',
    unitType: 'percentage',
    aggregation: 'WEIGHTED_AVERAGE',
    directionality: 'HIGHER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: OPS_SCOPES,
    metadata: { introducedIn: 'phase-4', weightBy: 'InventoryRequirement' },
  },
  {
    key: 'AllocatedInventory',
    name: 'Allocated Inventory',
    description:
      'Units of own stock a management choice commits to one opportunity for a period. ' +
      'Stated, never derived: HELM does not allocate.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'CONTEXT_DEPENDENT',
    timeBehavior: 'PERIOD',
    scopeCategories: COMMERCIAL_SCOPES,
    metadata: { introducedIn: 'phase-4' },
  },
  {
    key: 'UnservedDemand',
    name: 'Unserved Order Quantity',
    description: 'Units of a won order that the stock allocated to it would not cover.',
    dimension: 'OPERATIONAL',
    unitType: 'units',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: COMMERCIAL_SCOPES,
    metadata: { introducedIn: 'phase-4' },
  },
  {
    key: 'RevenueAtRisk',
    name: 'Revenue at Risk',
    description:
      'Expected revenue attached to the part of an order that cannot be served under a ' +
      'stated allocation.',
    dimension: 'RISK',
    unitType: 'currency',
    aggregation: 'SUM',
    directionality: 'LOWER_IS_BETTER',
    timeBehavior: 'PERIOD',
    scopeCategories: COMMERCIAL_SCOPES,
    metadata: { introducedIn: 'phase-4' },
  },
];

export const seedValueMetricKeys = seedValueMetrics.map((m) => m.key);
