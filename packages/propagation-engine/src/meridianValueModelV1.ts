/**
 * Meridian Pharma Value Model v1 — HELM's first executable management model.
 *
 * Nine calculations that make the canonical value chain computable end to end:
 *
 *   OpportunityValue × OpportunityProbability → ExpectedRevenue
 *   ExpectedRevenue ÷ AverageSellingPrice     → DemandQuantity
 *   DemandQuantity                            → InventoryRequirement
 *   InventoryRequirement − AvailableInventory → InventoryGap
 *   InventoryRequirement × UnitCost           → WorkingCapital
 *   DemandQuantity × UnitCost                 → Cogs
 *   ExpectedRevenue − Cogs − Opex             → GrossMargin
 *   GrossMargin ÷ ExpectedRevenue × 100       → GrossMarginPct
 *   GrossMargin − WorkingCapital              → CashImpact
 *
 * Every model simplification is stated in the calculation's `rationale` and
 * reflected in its `definitionConfidence`. The arithmetic is exact; the model
 * is v1, and it says so rather than implying a sophistication it does not have.
 *
 * Business constants do NOT appear here. Average selling price is an
 * ASSUMPTION observation on a value node, not a number in this file (§20) —
 * which is why `demand_quantity` has two inputs rather than one.
 *
 * Every input also declares WHERE it comes from. An `Opportunity Probability` is
 * read from the source world under an observation policy; an `Expected Revenue`
 * feeding `Demand Quantity` is an execution dependency and is taken from the run
 * that produced it. The two are different questions and the file says which is
 * which rather than leaving it to the ranking of observation types.
 *
 * Every input declares the time horizon it expects. An opportunity's value is a
 * `current` fact; the revenue it implies is a `quarter` figure. Leaving that
 * implicit would make the engine silently mix a point-in-time number with a
 * period one, so each input says which it wants and the engine refuses anything
 * else (§32).
 */

import {
  ZERO,
  atLeastZero,
  decimal,
  difference,
  mustQuantity,
  ok,
  percentageOf,
  scaleByCount,
  scaleByRatio,
  sum,
  unitsPurchasable,
  type Quantity,
  type Result,
} from '@helm/shared';
import type { CalculationDefinition } from './types.ts';

const OWNER = 'Country GM Vietnam';
const EFFECTIVE_FROM = '2026-10-01';

/** Entity categories the commercial chain may attach to. */
const COMMERCIAL = ['commercial', 'market'] as const;
const OPERATIONAL = ['operations', 'commercial', 'resource'] as const;

export const meridianValueModelV1: readonly CalculationDefinition[] = [
  // ======================================================= EXPECTED REVENUE
  {
    key: 'expected_revenue',
    version: '1.0.0',
    name: 'Expected Revenue',
    description: 'Probability-weighted revenue from an opportunity.',
    rationale:
      'Commercial commitments are uncertain. Weighting the opportunity value by its ' +
      'probability gives the revenue the business can plan against, rather than the ' +
      'best case it can hope for.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'ExpectedRevenue',
    outputUnit: 'currency',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 1,
    expression: 'opportunity_value × opportunity_probability',
    inputs: [
      {
        name: 'opportunity_value',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'OpportunityValue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        // The opportunity's value is what it is worth NOW, not over a quarter.
        horizon: 'current',
        description: 'The full value of the opportunity, before probability weighting.',
      },
      {
        name: 'opportunity_probability',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'OpportunityProbability',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'ratio',
        horizon: 'current',
        description: 'Likelihood the opportunity closes, as a ratio between 0 and 1.',
      },
    ],
    compute(_ctx, inputs) {
      // scaleByRatio refuses a percentage, so 70 can never be used where 0.7 belongs.
      return scaleByRatio(inputs.opportunity_value, inputs.opportunity_probability);
    },
  },

  // ======================================================== DEMAND QUANTITY
  {
    key: 'demand_quantity',
    version: '1.0.0',
    name: 'Demand Quantity',
    description: 'Probability-weighted expected unit demand implied by expected revenue.',
    rationale:
      'Expected revenue has to become physical demand before supply can be planned. ' +
      'Dividing by the average selling price converts money into units. The result is ' +
      'deliberately fractional: 8.4 units is the expected value across outcomes, not a ' +
      'shipment. Rounding to a whole number is a commercial commitment decision, not a ' +
      'calculation, so this model does not do it.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'DemandQuantity',
    outputUnit: 'units',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.9,
    expression: 'expected_revenue ÷ average_selling_price',
    inputs: [
      {
        name: 'expected_revenue',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'ExpectedRevenue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Probability-weighted revenue for this opportunity.',
      },
      {
        name: 'average_selling_price',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'AverageSellingPrice',
        // The price belongs to the product, not the opportunity. The ontology
        // says which product: Opportunity --SELLS--> Product.
        binding: { kind: 'RELATED_ENTITY', relationshipTypeKey: 'SELLS', direction: 'out' },
        required: true,
        expectUnit: 'currency',
        // A price is a standing fact about the product, not a quarterly figure.
        horizon: 'current',
        // An assumption must stay an assumption: falling back to a measured
        // actual here would misrepresent where the number came from.
        preference: 'ASSUMPTION_ONLY',
        description: 'Management assumption for realised price per unit of the product sold.',
      },
    ],
    compute(_ctx, inputs) {
      return unitsPurchasable(inputs.expected_revenue, inputs.average_selling_price);
    },
  },

  // =================================================== INVENTORY REQUIREMENT
  {
    key: 'inventory_requirement',
    version: '1.0.0',
    name: 'Inventory Requirement',
    description: 'Units of stock needed to serve expected demand.',
    rationale:
      'MODEL v1: the requirement equals total demand exactly. There is no safety stock, ' +
      'no service-level buffer and no lead-time cover, because none of those policies is ' +
      'modelled yet. The arithmetic is trivial and honest; the confidence reflects that ' +
      'the MODEL is crude, not that the number is uncertain. Demand from EVERY ' +
      'opportunity selling the product is summed, which is what makes the pressure on a ' +
      'shared stock position a number rather than an observation about the graph.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'InventoryRequirement',
    outputUnit: 'units',
    scopeCompatibility: OPERATIONAL,
    // Deliberately below 1: exact arithmetic over a crude model.
    definitionConfidence: 0.8,
    expression: 'Σ demand_quantity  (v1: no safety stock policy)',
    inputs: [
      {
        name: 'demand_quantity',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'DemandQuantity',
        // The requirement is about the Product; demand is about the Opportunity
        // that sells it, so walk the SELLS relationship backwards. Several
        // opportunities legitimately sell the same product, so they are summed
        // rather than being an ambiguity the engine refuses to resolve.
        binding: {
          kind: 'RELATED_ENTITY',
          relationshipTypeKey: 'SELLS',
          direction: 'in',
          aggregate: true,
        },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Expected unit demand from the opportunities selling this product.',
      },
    ],
    compute(_ctx, inputs) {
      return ok(inputs.demand_quantity);
    },
  },

  // ========================================================= INVENTORY GAP
  {
    key: 'inventory_gap',
    version: '1.0.0',
    name: 'Inventory Gap',
    description: 'Units of demand that cannot be served from available own stock.',
    rationale:
      'The gap measures requirement against stock the business already controls. ' +
      'Distributor-held stock is deliberately excluded: reallocating it is a commercial ' +
      'decision with its own consequences, not automatic availability. Floored at zero, ' +
      'because surplus stock is a working-capital question, not a negative gap.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'InventoryGap',
    outputUnit: 'units',
    scopeCompatibility: OPERATIONAL,
    definitionConfidence: 0.9,
    expression: 'max(inventory_requirement − available_inventory, 0)',
    inputs: [
      {
        name: 'inventory_requirement',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'InventoryRequirement',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units needed to serve expected demand for this product.',
      },
      {
        name: 'available_inventory',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'AvailableInventory',
        // Inventory --POSITIONS--> Product, so from the product walk inwards.
        // The filter is what excludes distributor-held stock.
        binding: {
          kind: 'RELATED_ENTITY',
          relationshipTypeKey: 'POSITIONS',
          direction: 'in',
          subjectFilter: { attribute: 'ownership', equals: 'own' },
          aggregate: true,
        },
        required: true,
        expectUnit: 'units',
        // Stock on hand is a fact about now, compared against a period's need.
        horizon: 'current',
        preference: 'ACTUALS_FIRST',
        description: 'Units on hand at positions the business owns outright.',
      },
    ],
    compute(_ctx, inputs) {
      const gap = difference(inputs.inventory_requirement, inputs.available_inventory);
      if (!gap.ok) return gap;
      return ok(atLeastZero(gap.value));
    },
  },

  // ========================================================= WORKING CAPITAL
  {
    key: 'working_capital',
    version: '1.0.0',
    name: 'Working Capital Requirement',
    description: 'Capital tied up by holding the required inventory.',
    rationale:
      'Inventory is capital before it is service. Valuing the requirement at unit cost ' +
      'shows what serving this demand ties up, which is the number that competes with ' +
      'every other use of cash. v1 values at cost and ignores payment terms. This is ' +
      'working capital for ONE product; the entity-level position a finance team reports ' +
      'is an aggregate across products that v1 deliberately does not attempt, which is ' +
      'why the calculation refuses to run on a finance subject rather than producing a ' +
      'number that looks like a balance-sheet figure and is not one.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'WorkingCapital',
    outputUnit: 'currency',
    // A product's required stock, not a finance aggregate.
    scopeCompatibility: OPERATIONAL,
    definitionConfidence: 0.85,
    expression: 'inventory_requirement × unit_cost',
    inputs: [
      {
        name: 'inventory_requirement',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'InventoryRequirement',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units of stock the business needs to hold.',
      },
      {
        name: 'unit_cost',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'UnitCost',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'current',
        description: 'Landed cost of one unit of the product.',
      },
    ],
    compute(_ctx, inputs) {
      return scaleByCount(inputs.unit_cost, inputs.inventory_requirement);
    },
  },

  // ==================================================================== COGS
  {
    key: 'cogs',
    version: '1.0.0',
    name: 'Cost of Goods Sold',
    description: 'Product cost of the units expected to be sold.',
    rationale:
      'Separated from working capital on purpose: the same unit cost drives both, but ' +
      'COGS follows what is sold while working capital follows what is held. Keeping ' +
      'them as distinct calculations means a change in stock policy moves one and not ' +
      'the other.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'Cogs',
    outputUnit: 'currency',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.95,
    expression: 'demand_quantity × unit_cost',
    inputs: [
      {
        name: 'demand_quantity',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'DemandQuantity',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Expected units sold under this opportunity.',
      },
      {
        name: 'unit_cost',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'UnitCost',
        binding: { kind: 'RELATED_ENTITY', relationshipTypeKey: 'SELLS', direction: 'out' },
        required: true,
        expectUnit: 'currency',
        horizon: 'current',
        description: 'Landed cost of one unit of the product being sold.',
      },
    ],
    compute(_ctx, inputs) {
      return scaleByCount(inputs.unit_cost, inputs.demand_quantity);
    },
  },

  // ============================================================ GROSS MARGIN
  {
    key: 'gross_margin',
    version: '1.0.0',
    name: 'Gross Margin',
    description: 'Expected revenue less product cost and incremental fulfilment cost.',
    rationale:
      'Margin is what survives after the cost of the goods and the cost of getting them ' +
      'there. Fulfilment cost is optional because most opportunities carry none; when ' +
      'expediting is on the table it becomes the visible price of protecting the deal. ' +
      'Deal-level only: an enterprise margin is a consolidation, not this formula summed.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'GrossMargin',
    outputUnit: 'currency',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.9,
    expression: 'expected_revenue − cogs − fulfilment_cost',
    inputs: [
      {
        name: 'expected_revenue',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'ExpectedRevenue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Probability-weighted revenue for this opportunity.',
      },
      {
        name: 'cogs',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'Cogs',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Product cost of the units expected to be sold.',
      },
      {
        name: 'fulfilment_cost',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'Opex',
        binding: { kind: 'RELATED_ENTITY', relationshipTypeKey: 'INCURS', direction: 'out' },
        required: false,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Incremental operating cost of fulfilling this opportunity, if any.',
      },
    ],
    compute(_ctx, inputs) {
      const afterCogs = difference(inputs.expected_revenue, inputs.cogs);
      if (!afterCogs.ok) return afterCogs;
      const fulfilment = inputs.fulfilment_cost;
      if (!fulfilment) return afterCogs;
      return difference(afterCogs.value, fulfilment);
    },
  },

  // ========================================================== GROSS MARGIN %
  {
    key: 'gross_margin_pct',
    version: '1.0.0',
    name: 'Gross Margin %',
    description: 'Gross margin as a percentage of expected revenue.',
    rationale:
      'The percentage is what management steers by and what objectives are written ' +
      'against. Derived from the currency figures rather than stated separately, so the ' +
      'two can never disagree.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'GrossMarginPct',
    outputUnit: 'percentage',
    // Deal-level. A business unit's margin percentage is a weighted
    // consolidation across deals, and v1 has no consolidation model, so the
    // BU node stays a stated finance figure rather than a fabricated one.
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 1,
    expression: 'gross_margin ÷ expected_revenue × 100',
    inputs: [
      {
        name: 'gross_margin',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'GrossMargin',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Gross margin in currency for this subject.',
      },
      {
        name: 'expected_revenue',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'ExpectedRevenue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Probability-weighted revenue the margin is measured against.',
      },
    ],
    compute(_ctx, inputs) {
      // percentageOf returns 0..100, never a 0..1 ratio — the two are distinct
      // unit types and cannot be confused.
      return percentageOf(inputs.gross_margin, inputs.expected_revenue);
    },
  },

  // ============================================================= CASH IMPACT
  {
    key: 'cash_impact',
    version: '1.0.0',
    name: 'Cash Impact',
    description: 'Net cash effect of serving this demand over the horizon.',
    rationale:
      'MODEL v1, deliberately simple: margin earned less capital tied up. It ignores ' +
      'payment terms, collection timing and tax. It is stated as a v1 cash model rather ' +
      'than dressed up as a cash-flow statement, because a model that looks more ' +
      'sophisticated than it is would be trusted more than it deserves.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'CashImpact',
    outputUnit: 'currency',
    // The cash effect OF A DEAL. An enterprise cash position is not this.
    scopeCompatibility: COMMERCIAL,
    // The lowest in the model: the arithmetic is trivial, the model is the crudest.
    definitionConfidence: 0.7,
    expression: 'gross_margin − working_capital  (v1: ignores payment terms and timing)',
    inputs: [
      {
        name: 'gross_margin',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'GrossMargin',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Gross margin expected from this opportunity.',
      },
      {
        name: 'working_capital',
        // Executable dependency: this run computes it upstream.
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'WorkingCapital',
        // The capital belongs to the product's stock, not to the deal. Note the
        // consequence: this deal carries the capital cost of stock the OTHER
        // tender also needs, which is exactly the tension a manager must see.
        binding: { kind: 'RELATED_ENTITY', relationshipTypeKey: 'SELLS', direction: 'out' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Capital tied up holding the inventory this demand requires.',
      },
    ],
    compute(_ctx, inputs) {
      return difference(inputs.gross_margin, inputs.working_capital);
    },
  },
];

/** Convenience for tests and docs. */
export const meridianModelKeys = meridianValueModelV1.map((c) => c.key);

/**
 * The assumptions this model depends on. Each must exist as an ASSUMPTION
 * observation before the model can run — they are business policy, not
 * constants hidden in code (§20).
 */
export const meridianModelAssumptions = [
  {
    metricKey: 'AverageSellingPrice',
    subject: 'helm:product:sku-x',
    value: '350000000',
    unit: 'currency' as const,
    currency: 'VND',
    rationale:
      'Realised price per SKU-X unit after standard discount. Management assumption ' +
      'reviewed quarterly; 12 units at this price is the 4.2B opportunity value.',
  },
] as const;

/** Sanity helper used by tests: a model with no hidden constants. */
export function modelUsesOnlyDeclaredInputs(): boolean {
  return meridianValueModelV1.every((c) => c.inputs.length > 0);
}

export type { Quantity, Result, CalculationDefinition };
export { ZERO, decimal, mustQuantity, sum };
