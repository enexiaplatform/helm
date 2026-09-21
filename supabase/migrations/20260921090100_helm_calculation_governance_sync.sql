-- ============================================================================
-- HELM calculation governance sync
--
-- GENERATED FILE -- produced by scripts/generate-calculation-governance.mjs from
-- packages/propagation-engine/src/meridianValueModelV1.ts. Do not hand-edit.
--
-- Carries the code registry's current declarations onto the governance rows
-- the Phase 3 migration created. Metadata only: no executable code, no change
-- to what any calculation computes. Idempotent.
--
-- The substantive change this sync carries is `resolution` on every declared
-- input: whether it reads the persistent source world under an observation
-- policy (SOURCE_POLICY_ONLY) or is an execution dependency bound to the run
-- that produced it upstream (RUN_OUTPUT_IF_PLANNED).
-- ============================================================================

UPDATE public.helm_calculations SET
  name = 'Expected Revenue',
  description = 'Probability-weighted revenue from an opportunity.',
  rationale = 'Commercial commitments are uncertain. Weighting the opportunity value by its probability gives the revenue the business can plan against, rather than the best case it can hope for.',
  owner = 'Country GM Vietnam',
  expression = 'opportunity_value × opportunity_probability',
  definition_confidence = 1,
  inputs = '[{"name":"opportunity_value","metricKey":"OpportunityValue","binding":{"kind":"SAME_SUBJECT"},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"The full value of the opportunity, before probability weighting."},{"name":"opportunity_probability","metricKey":"OpportunityProbability","binding":{"kind":"SAME_SUBJECT"},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"ratio","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Likelihood the opportunity closes, as a ratio between 0 and 1."}]'::jsonb
WHERE id = 'calc_expected_revenue@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Demand Quantity',
  description = 'Probability-weighted expected unit demand implied by expected revenue.',
  rationale = 'Expected revenue has to become physical demand before supply can be planned. Dividing by the average selling price converts money into units. The result is deliberately fractional: 8.4 units is the expected value across outcomes, not a shipment. Rounding to a whole number is a commercial commitment decision, not a calculation, so this model does not do it.',
  owner = 'Country GM Vietnam',
  expression = 'expected_revenue ÷ average_selling_price',
  definition_confidence = 0.9,
  inputs = '[{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue for this opportunity."},{"name":"average_selling_price","metricKey":"AverageSellingPrice","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"currency","preference":"ASSUMPTION_ONLY","horizon":"current","allowCrossPeriod":false,"description":"Management assumption for realised price per unit of the product sold."}]'::jsonb
WHERE id = 'calc_demand_quantity@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Inventory Requirement',
  description = 'Units of stock needed to serve expected demand.',
  rationale = 'MODEL v1: the requirement equals total demand exactly. There is no safety stock, no service-level buffer and no lead-time cover, because none of those policies is modelled yet. The arithmetic is trivial and honest; the confidence reflects that the MODEL is crude, not that the number is uncertain. Demand from EVERY opportunity selling the product is summed, which is what makes the pressure on a shared stock position a number rather than an observation about the graph.',
  owner = 'Country GM Vietnam',
  expression = 'Σ demand_quantity  (v1: no safety stock policy)',
  definition_confidence = 0.8,
  inputs = '[{"name":"demand_quantity","metricKey":"DemandQuantity","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"in","aggregate":true},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Expected unit demand from the opportunities selling this product."}]'::jsonb
WHERE id = 'calc_inventory_requirement@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Inventory Gap',
  description = 'Units of demand that cannot be served from available own stock.',
  rationale = 'The gap measures requirement against stock the business already controls. Distributor-held stock is deliberately excluded: reallocating it is a commercial decision with its own consequences, not automatic availability. Floored at zero, because surplus stock is a working-capital question, not a negative gap.',
  owner = 'Country GM Vietnam',
  expression = 'max(inventory_requirement − available_inventory, 0)',
  definition_confidence = 0.9,
  inputs = '[{"name":"inventory_requirement","metricKey":"InventoryRequirement","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Units needed to serve expected demand for this product."},{"name":"available_inventory","metricKey":"AvailableInventory","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"POSITIONS","direction":"in","subjectFilter":{"attribute":"ownership","equals":"own"},"aggregate":true},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"units","preference":"ACTUALS_FIRST","horizon":"current","allowCrossPeriod":false,"description":"Units on hand at positions the business owns outright."}]'::jsonb
WHERE id = 'calc_inventory_gap@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Working Capital Requirement',
  description = 'Capital tied up by holding the required inventory.',
  rationale = 'Inventory is capital before it is service. Valuing the requirement at unit cost shows what serving this demand ties up, which is the number that competes with every other use of cash. v1 values at cost and ignores payment terms. This is working capital for ONE product; the entity-level position a finance team reports is an aggregate across products that v1 deliberately does not attempt, which is why the calculation refuses to run on a finance subject rather than producing a number that looks like a balance-sheet figure and is not one.',
  owner = 'Finance Director Vietnam',
  expression = 'inventory_requirement × unit_cost',
  definition_confidence = 0.85,
  inputs = '[{"name":"inventory_requirement","metricKey":"InventoryRequirement","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Units of stock the business needs to hold."},{"name":"unit_cost","metricKey":"UnitCost","binding":{"kind":"SAME_SUBJECT"},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Landed cost of one unit of the product."}]'::jsonb
WHERE id = 'calc_working_capital@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Cost of Goods Sold',
  description = 'Product cost of the units expected to be sold.',
  rationale = 'Separated from working capital on purpose: the same unit cost drives both, but COGS follows what is sold while working capital follows what is held. Keeping them as distinct calculations means a change in stock policy moves one and not the other.',
  owner = 'Finance Director Vietnam',
  expression = 'demand_quantity × unit_cost',
  definition_confidence = 0.95,
  inputs = '[{"name":"demand_quantity","metricKey":"DemandQuantity","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"units","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Expected units sold under this opportunity."},{"name":"unit_cost","metricKey":"UnitCost","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"resolution":"SOURCE_POLICY_ONLY","required":true,"expectUnit":"currency","preference":null,"horizon":"current","allowCrossPeriod":false,"description":"Landed cost of one unit of the product being sold."}]'::jsonb
WHERE id = 'calc_cogs@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Gross Margin',
  description = 'Expected revenue less product cost and incremental fulfilment cost.',
  rationale = 'Margin is what survives after the cost of the goods and the cost of getting them there. Fulfilment cost is optional because most opportunities carry none; when expediting is on the table it becomes the visible price of protecting the deal. Deal-level only: an enterprise margin is a consolidation, not this formula summed.',
  owner = 'Finance Director Vietnam',
  expression = 'expected_revenue − cogs − fulfilment_cost',
  definition_confidence = 0.9,
  inputs = '[{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue for this opportunity."},{"name":"cogs","metricKey":"Cogs","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Product cost of the units expected to be sold."},{"name":"fulfilment_cost","metricKey":"Opex","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"INCURS","direction":"out"},"resolution":"SOURCE_POLICY_ONLY","required":false,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Incremental operating cost of fulfilling this opportunity, if any."}]'::jsonb
WHERE id = 'calc_gross_margin@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Gross Margin %',
  description = 'Gross margin as a percentage of expected revenue.',
  rationale = 'The percentage is what management steers by and what objectives are written against. Derived from the currency figures rather than stated separately, so the two can never disagree.',
  owner = 'Finance Director Vietnam',
  expression = 'gross_margin ÷ expected_revenue × 100',
  definition_confidence = 1,
  inputs = '[{"name":"gross_margin","metricKey":"GrossMargin","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Gross margin in currency for this subject."},{"name":"expected_revenue","metricKey":"ExpectedRevenue","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Probability-weighted revenue the margin is measured against."}]'::jsonb
WHERE id = 'calc_gross_margin_pct@1.0.0' AND org_id IS NULL;

UPDATE public.helm_calculations SET
  name = 'Cash Impact',
  description = 'Net cash effect of serving this demand over the horizon.',
  rationale = 'MODEL v1, deliberately simple: margin earned less capital tied up. It ignores payment terms, collection timing and tax. It is stated as a v1 cash model rather than dressed up as a cash-flow statement, because a model that looks more sophisticated than it is would be trusted more than it deserves.',
  owner = 'Finance Director Vietnam',
  expression = 'gross_margin − working_capital  (v1: ignores payment terms and timing)',
  definition_confidence = 0.7,
  inputs = '[{"name":"gross_margin","metricKey":"GrossMargin","binding":{"kind":"SAME_SUBJECT"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Gross margin expected from this opportunity."},{"name":"working_capital","metricKey":"WorkingCapital","binding":{"kind":"RELATED_ENTITY","relationshipTypeKey":"SELLS","direction":"out"},"resolution":"RUN_OUTPUT_IF_PLANNED","required":true,"expectUnit":"currency","preference":null,"horizon":"quarter","allowCrossPeriod":false,"description":"Capital tied up holding the inventory this demand requires."}]'::jsonb
WHERE id = 'calc_cash_impact@1.0.0' AND org_id IS NULL;
