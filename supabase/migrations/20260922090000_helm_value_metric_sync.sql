-- ============================================================================
-- HELM value-metric sync
--
-- GENERATED FILE -- produced by scripts/generate-value-metric-sync.mjs from
-- packages/value-graph/src/seed.ts. Do not hand-edit.
--
-- Brings the system metric vocabulary (org_id IS NULL) to exactly what the seed
-- declares. Idempotent: an upsert of every system metric, touching nothing an
-- organization defined for itself. Only helm_value_metrics is written.
--
-- Metrics introduced since the Phase 2 migration: OrderQuantity, DemandCoverage, AllocatedInventory, UnservedDemand, RevenueAtRisk.
-- Definitions revised since: WorkingCapital.directionality (was LOWER_IS_BETTER).
-- ============================================================================

INSERT INTO public.helm_value_metrics
  (id, org_id, key, name, description, dimension, unit_type, default_currency, data_type,
   aggregation, directionality, time_behavior, scope_categories, version, status, is_system,
   metadata)
VALUES
  ('vm_opportunityvalue', NULL, 'OpportunityValue', 'Opportunity Value', 'The full value of an identified revenue event, before any probability weighting.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_opportunityprobability', NULL, 'OpportunityProbability', 'Opportunity Probability', 'Likelihood the opportunity closes, as a proportion. Weighted by value when rolled up, never summed.', 'COMMERCIAL', 'ratio', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"weightBy":"OpportunityValue"}'::jsonb),
  ('vm_expectedrevenue', NULL, 'ExpectedRevenue', 'Expected Revenue', 'Probability-weighted revenue from an opportunity or pipeline over a period.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_revenue', NULL, 'Revenue', 'Revenue', 'Recognised revenue for a cost object over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_pipelinecoverage', NULL, 'PipelineCoverage', 'Pipeline Coverage', 'Weighted pipeline divided by the target for the period. A coverage ratio, not a sum.', 'COMMERCIAL', 'ratio', NULL, 'numeric', 'NON_AGGREGATABLE', 'TARGET_RANGE', 'PERIOD', NULL, 1, 'active', true, '{"typicalTargetRange":[3,5]}'::jsonb),
  ('vm_customervalue', NULL, 'CustomerValue', 'Customer Value', 'Cumulative economic value attributable to a customer relationship.', 'CUSTOMER', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'CUMULATIVE', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_demandquantity', NULL, 'DemandQuantity', 'Demand Quantity', 'Units of a product demanded over a period by a commercial event.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'NEUTRAL', 'PERIOD', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_availableinventory', NULL, 'AvailableInventory', 'Available Inventory', 'Units on hand plus inbound within the horizon, at a specific position. More is not automatically better — it is also capital.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_inventoryrequirement', NULL, 'InventoryRequirement', 'Inventory Requirement', 'Units needed to serve committed and expected demand over the horizon.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'NEUTRAL', 'PERIOD', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_inventorygap', NULL, 'InventoryGap', 'Inventory Gap', 'Requirement minus available inventory. Positive means demand cannot be served from stock.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_servicelevel', NULL, 'ServiceLevel', 'Service Level', 'Proportion of demand served on time, expressed 0-100. Weighted by volume when rolled up.', 'CUSTOMER', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_leadtime', NULL, 'LeadTime', 'Lead Time', 'Days between placing a replenishment order and receiving it.', 'OPERATIONAL', 'days', NULL, 'numeric', 'AVERAGE', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_capacityutilization', NULL, 'CapacityUtilization', 'Capacity Utilization', 'Demand as a proportion of available capacity, 0-100. Both too low and too high are problems.', 'RESOURCE', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'TARGET_RANGE', 'PERIOD', NULL, 1, 'active', true, '{"typicalTargetRange":[70,85],"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_unitcost', NULL, 'UnitCost', 'Unit Cost', 'Landed cost of one unit of product.', 'FINANCIAL', 'currency', NULL, 'numeric', 'AVERAGE', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_averagesellingprice', NULL, 'AverageSellingPrice', 'Average Selling Price', 'Realised price per unit after discount. Normally a management assumption rather than a measurement, which is why calculations that use it require an ASSUMPTION observation.', 'COMMERCIAL', 'currency', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{"weightBy":"DemandQuantity"}'::jsonb),
  ('vm_cogs', NULL, 'Cogs', 'Cost of Goods Sold', 'Product cost of the units expected to be sold over a period. Distinct from inventory value, which follows what is held rather than what is sold.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_grossmargin', NULL, 'GrossMargin', 'Gross Margin', 'Revenue less cost of goods sold, in currency, over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_grossmarginpct', NULL, 'GrossMarginPct', 'Gross Margin %', 'Gross margin as a proportion of revenue, 0-100. A ratio of sums, so it cannot itself be summed.', 'FINANCIAL', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{"weightBy":"Revenue"}'::jsonb),
  ('vm_contributionmargin', NULL, 'ContributionMargin', 'Contribution Margin', 'Revenue less variable cost. What the cost object contributes toward fixed costs.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_workingcapital', NULL, 'WorkingCapital', 'Working Capital', 'Capital tied up in inventory, receivables and payables. Lower frees cash, but too low starves service.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'POINT_IN_TIME', NULL, 2, 'active', true, '{"revised":{"phase":4,"field":"directionality","from":"LOWER_IS_BETTER"}}'::jsonb),
  ('vm_inventoryvalue', NULL, 'InventoryValue', 'Inventory Value', 'Capital held as stock at a position, at cost.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_cashimpact', NULL, 'CashImpact', 'Cash Impact', 'Net effect on cash over the horizon.', 'CAPITAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_opex', NULL, 'Opex', 'Operating Expense', 'Operating cost for a cost object over a period.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_ebitda', NULL, 'Ebitda', 'EBITDA', 'Earnings before interest, tax, depreciation and amortization.', 'FINANCIAL', 'currency', NULL, 'numeric', 'SUM', 'HIGHER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_supplyrisk', NULL, 'SupplyRisk', 'Supply Risk', 'Exposure to supply failure at a position or product, 0-100. Rolls up as the worst case, not an average.', 'RISK', 'score', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_customerrisk', NULL, 'CustomerRisk', 'Customer Risk', 'Exposure to losing or being unable to serve a customer, 0-100.', 'RISK', 'score', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_inventoryrisk', NULL, 'InventoryRisk', 'Inventory Risk Exposure', 'Value at risk from expiry, obsolescence or write-down.', 'RISK', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'POINT_IN_TIME', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{}'::jsonb),
  ('vm_concentrationrisk', NULL, 'ConcentrationRisk', 'Concentration Risk', 'Share of a dimension dependent on a single supplier, customer or product, 0-100.', 'RISK', 'percentage', NULL, 'numeric', 'MAX', 'LOWER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_futureopportunityrisk', NULL, 'FutureOpportunityRisk', 'Future Opportunity Risk', 'Value at risk in other opportunities because a constrained resource is committed here. The cost of foreclosing a future option.', 'RISK', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_strategicalignment', NULL, 'StrategicAlignment', 'Strategic Alignment', 'How well an activity advances stated management objectives, 0-100. Judgemental, not measured.', 'STRATEGIC', 'score', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{"weightBy":"ExpectedRevenue"}'::jsonb),
  ('vm_growthpotential', NULL, 'GrowthPotential', 'Growth Potential', 'Headroom for future value creation in a market, segment or portfolio, 0-100.', 'STRATEGIC', 'score', NULL, 'numeric', 'AVERAGE', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_sourcingresilience', NULL, 'SourcingResilience', 'Sourcing Resilience', 'Ability to keep supplying if the primary source fails, 0-100. Rolls up as the weakest link.', 'RESILIENCE', 'score', NULL, 'numeric', 'MIN', 'HIGHER_IS_BETTER', 'POINT_IN_TIME', NULL, 1, 'active', true, '{}'::jsonb),
  ('vm_orderquantity', NULL, 'OrderQuantity', 'Order Quantity', 'Units the business must deliver if an opportunity is won. Not probability-weighted: feasibility is about what must ship, not what is expected.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'NEUTRAL', 'PERIOD', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"introducedIn":"phase-4"}'::jsonb),
  ('vm_demandcoverage', NULL, 'DemandCoverage', 'Demand Coverage', 'Share of a period''s inventory requirement that own stock covers. HELM''s proxy for the ability to serve — not a measured service level.', 'CUSTOMER', 'percentage', NULL, 'numeric', 'WEIGHTED_AVERAGE', 'HIGHER_IS_BETTER', 'PERIOD', ARRAY['operations', 'commercial', 'resource']::text[], 1, 'active', true, '{"introducedIn":"phase-4","weightBy":"InventoryRequirement"}'::jsonb),
  ('vm_allocatedinventory', NULL, 'AllocatedInventory', 'Allocated Inventory', 'Units of own stock a management choice commits to one opportunity for a period. Stated, never derived: HELM does not allocate.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'CONTEXT_DEPENDENT', 'PERIOD', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"introducedIn":"phase-4"}'::jsonb),
  ('vm_unserveddemand', NULL, 'UnservedDemand', 'Unserved Order Quantity', 'Units of a won order that the stock allocated to it would not cover.', 'OPERATIONAL', 'units', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"introducedIn":"phase-4"}'::jsonb),
  ('vm_revenueatrisk', NULL, 'RevenueAtRisk', 'Revenue at Risk', 'Expected revenue attached to the part of an order that cannot be served under a stated allocation.', 'RISK', 'currency', NULL, 'numeric', 'SUM', 'LOWER_IS_BETTER', 'PERIOD', ARRAY['commercial', 'market']::text[], 1, 'active', true, '{"introducedIn":"phase-4"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  dimension = EXCLUDED.dimension,
  unit_type = EXCLUDED.unit_type,
  default_currency = EXCLUDED.default_currency,
  data_type = EXCLUDED.data_type,
  aggregation = EXCLUDED.aggregation,
  directionality = EXCLUDED.directionality,
  time_behavior = EXCLUDED.time_behavior,
  scope_categories = EXCLUDED.scope_categories,
  version = EXCLUDED.version,
  metadata = EXCLUDED.metadata
WHERE public.helm_value_metrics.org_id IS NULL;
