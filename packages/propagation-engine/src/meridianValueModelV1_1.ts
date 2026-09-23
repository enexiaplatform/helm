/**
 * Meridian Pharma Value Model v1.1 — v1 plus the four calculations the Phase 4
 * scenarios need to have consequences worth comparing.
 *
 *   OpportunityValue ÷ AverageSellingPrice                 → OrderQuantity
 *   min(AvailableInventory, Requirement) ÷ Requirement     → DemandCoverage
 *   max(OrderQuantity − AllocatedInventory, 0)             → UnservedDemand
 *   ExpectedRevenue × UnservedDemand ÷ OrderQuantity       → RevenueAtRisk
 *
 * Why these and no others. v1 could say what expediting costs (margin, cash)
 * but nothing about what it buys: it had no measure of whether demand can be
 * served, and no notion of committing stock to one deal rather than another.
 * Without those, "expedite", "reallocate" and "delay" differ only in cost, and
 * the shared-inventory case — two opportunities, one stock position — could not
 * be executed at all. These four are the smallest identities that close that
 * gap. Each is an arithmetic identity over metrics that already exist or are
 * stated by a person; none introduces an economic behaviour HELM would have to
 * invent (no demand elasticity, no penalty model, no revenue recognition).
 *
 * v1's nine calculations are untouched, so every v1 result is reproduced
 * exactly under v1.1.
 */

import {
  difference,
  atLeastZero,
  minOf,
  ok,
  percentageOf,
  ratioOf,
  scaleByRatio,
  unitsPurchasable,
  isZero,
  mustQuantity,
  ZERO,
} from '@helm/shared';
import type { CalculationDefinition } from './types.ts';
import { meridianValueModelV1 } from './meridianValueModelV1.ts';

const OWNER = 'Country GM Vietnam';
const EFFECTIVE_FROM = '2026-10-01';
const COMMERCIAL = ['commercial', 'market'] as const;
const OPERATIONAL = ['operations', 'commercial', 'resource'] as const;

export const meridianScenarioCalculations: readonly CalculationDefinition[] = [
  {
    key: 'order_quantity',
    version: '1.0.0',
    name: 'Order Quantity',
    description: 'Units the business must deliver if the opportunity is won.',
    rationale:
      'Feasibility is a question about what must ship, not about what is expected. ' +
      'Expected demand (8.4 units) is right for planning revenue and wrong for asking ' +
      'whether an order can be fulfilled: a won order ships 12 units or it is late. ' +
      'Valued at the same assumed selling price demand already uses, so the two cannot ' +
      'disagree about what a unit is worth. MODEL v1.1 assumes the whole order falls in ' +
      'the modelled period.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'OrderQuantity',
    outputUnit: 'units',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.9,
    expression: 'opportunity_value ÷ average_selling_price',
    inputs: [
      {
        name: 'opportunity_value',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'OpportunityValue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'current',
        description: 'The full value of the opportunity if it is won.',
      },
      {
        name: 'average_selling_price',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'AverageSellingPrice',
        binding: { kind: 'RELATED_ENTITY', relationshipTypeKey: 'SELLS', direction: 'out' },
        required: true,
        expectUnit: 'currency',
        horizon: 'current',
        preference: 'ASSUMPTION_ONLY',
        description: 'Management assumption for realised price per unit of the product sold.',
      },
    ],
    compute(_ctx, inputs) {
      return unitsPurchasable(inputs.opportunity_value, inputs.average_selling_price);
    },
  },

  {
    key: 'demand_coverage',
    version: '1.0.0',
    name: 'Demand Coverage',
    description: 'Share of the period requirement that own stock covers.',
    rationale:
      'The ability to serve, measured the only way v1.1 can: own available stock against ' +
      'the requirement for the period, capped at the requirement because surplus stock ' +
      'does not serve more than all of the demand. This is a PROXY for service, not a ' +
      'service level — it ignores lead time, partial deliveries and the timing of demand ' +
      'within the period — and the metric is named so nobody mistakes it for the SLA.',
    owner: 'Supply Chain Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'DemandCoverage',
    outputUnit: 'percentage',
    scopeCompatibility: OPERATIONAL,
    definitionConfidence: 0.7,
    expression: 'min(available_inventory, inventory_requirement) ÷ inventory_requirement × 100',
    inputs: [
      {
        name: 'inventory_requirement',
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
        binding: {
          kind: 'RELATED_ENTITY',
          relationshipTypeKey: 'POSITIONS',
          direction: 'in',
          subjectFilter: { attribute: 'ownership', equals: 'own' },
          aggregate: true,
        },
        required: true,
        expectUnit: 'units',
        horizon: 'current',
        preference: 'ACTUALS_FIRST',
        description: 'Units on hand at positions the business owns outright.',
      },
    ],
    compute(_ctx, inputs) {
      const covered = minOf(inputs.available_inventory, inputs.inventory_requirement);
      if (!covered.ok) return covered;
      return percentageOf(covered.value, inputs.inventory_requirement);
    },
  },

  {
    key: 'unserved_demand',
    version: '1.0.0',
    name: 'Unserved Order Quantity',
    description: 'Units of a won order that the stock allocated to it would not cover.',
    rationale:
      'Allocation is a management choice, so this calculation never makes one: it reads ' +
      'the allocation a person or a scenario stated and reports what that choice leaves ' +
      'uncovered. With no allocation stated it does not assume one — it blocks, because ' +
      '"nothing allocated" and "not yet decided" are different facts.',
    owner: OWNER,
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'UnservedDemand',
    outputUnit: 'units',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.9,
    expression: 'max(order_quantity − allocated_inventory, 0)',
    inputs: [
      {
        name: 'order_quantity',
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'OrderQuantity',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units that must ship if this opportunity is won.',
      },
      {
        name: 'allocated_inventory',
        resolution: 'SOURCE_POLICY_ONLY',
        metricKey: 'AllocatedInventory',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units of own stock committed to this opportunity for the period.',
      },
    ],
    compute(_ctx, inputs) {
      const gap = difference(inputs.order_quantity, inputs.allocated_inventory);
      if (!gap.ok) return gap;
      return ok(atLeastZero(gap.value));
    },
  },

  {
    key: 'revenue_at_risk',
    version: '1.0.0',
    name: 'Revenue at Risk',
    description: 'Expected revenue attached to the part of an order that cannot be served.',
    rationale:
      'If a third of an order cannot ship, a third of its expected revenue is exposed. ' +
      'MODEL v1.1 treats that exposure proportionally and as lost rather than deferred: ' +
      'it ignores late-delivery penalties, partial acceptance and substitution, none of ' +
      'which HELM has a basis for. Probability is inherited from expected revenue, never ' +
      'introduced here.',
    owner: 'Finance Director Vietnam',
    status: 'ACTIVE',
    effectiveFrom: EFFECTIVE_FROM,
    outputMetricKey: 'RevenueAtRisk',
    outputUnit: 'currency',
    scopeCompatibility: COMMERCIAL,
    definitionConfidence: 0.6,
    expression: 'expected_revenue × unserved_demand ÷ order_quantity',
    inputs: [
      {
        name: 'expected_revenue',
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'ExpectedRevenue',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'currency',
        horizon: 'quarter',
        description: 'Probability-weighted revenue for this opportunity.',
      },
      {
        name: 'unserved_demand',
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'UnservedDemand',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units of the order the allocated stock would not cover.',
      },
      {
        name: 'order_quantity',
        resolution: 'RUN_OUTPUT_IF_PLANNED',
        metricKey: 'OrderQuantity',
        binding: { kind: 'SAME_SUBJECT' },
        required: true,
        expectUnit: 'units',
        horizon: 'quarter',
        description: 'Units that must ship if this opportunity is won.',
      },
    ],
    compute(_ctx, inputs) {
      // An order of nothing has nothing at risk; the ratio would divide by zero.
      if (isZero(inputs.order_quantity.amount)) {
        return ok(mustQuantity(ZERO, 'currency', inputs.expected_revenue.currency));
      }
      const share = ratioOf(inputs.unserved_demand, inputs.order_quantity);
      if (!share.ok) return share;
      return scaleByRatio(inputs.expected_revenue, share.value);
    },
  },
];

/** v1 unchanged, plus the scenario calculations. */
export const meridianValueModelV1_1: readonly CalculationDefinition[] = [
  ...meridianValueModelV1,
  ...meridianScenarioCalculations,
];

export const MERIDIAN_MODEL_V1_1 = 'meridian-pharma-value-model@1.1';
