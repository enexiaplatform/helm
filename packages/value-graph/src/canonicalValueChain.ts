/**
 * The canonical value chain — Meridian Life Sciences Vietnam.
 *
 * Builds the VALUE layer over the Phase 1 entity graph:
 *
 *   Rohto Vietnam → Opportunity-001 → Expected Revenue → Product Demand
 *     → Inventory Requirement → { Inventory Gap, Service Level }
 *     → Working Capital → Gross Margin → Cash → Enterprise Value dimensions
 *
 * Two structural points this fixture exists to prove:
 *
 *  1. **Enterprise value is not one number.** The chain terminates in several
 *     dimension nodes attached to the EnterpriseValue entity — cash, margin,
 *     service, risk, strategic alignment. They trade off against each other and
 *     are deliberately not collapsed into a score (phase brief §31).
 *
 *  2. **A constrained resource is shared.** Two opportunities' demand both
 *     CONSUME one inventory position's availability, so the cost of committing
 *     it to today's deal is structurally visible.
 *
 * Nothing here computes. Observations are recorded as stated facts of a given
 * type; no value is derived from another.
 */

import {
  asValidTime,
  type EntityId,
  type Result,
  type Scope,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import { canonicalKey } from '@helm/ontology';
import type { ValueGraph } from './port.ts';
import type {
  ObservationType,
  TimeHorizon,
  UnitType,
  ValueLinkType,
  ValueScopeKind,
} from './types.ts';

export type CanonicalValueChain = {
  /** Value node ids by readable handle. */
  nodeIds: Record<string, string>;
  /** Scenario entity ids by handle, for SCENARIO observations. */
  scenarioIds: Record<string, EntityId>;
  nodeCount: number;
  linkCount: number;
  observationCount: number;
};

type NodeSpec = {
  handle: string;
  metric: string;
  /** Canonical key of the ontology entity this is about. */
  subject: string | null;
  scopeKind?: ValueScopeKind;
  scopeRef?: string;
  horizon?: TimeHorizon;
  label: string;
};

type LinkSpec = {
  type: ValueLinkType;
  from: string;
  to: string;
  weight?: number;
  confidence?: number;
  lagDays?: number;
  note?: string;
};

type ObsSpec = {
  node: string;
  type: ObservationType;
  value: number;
  unit: UnitType;
  currency?: string;
  effectiveAt?: string;
  periodStart?: string;
  periodEnd?: string;
  observedAt?: string;
  source: 'memoire' | 'erp' | 'finance' | 'scm' | 'helm' | 'manual' | 'market';
  scenario?: string;
  confidence?: number;
  note?: string;
};

const Q4_START = '2026-10-01T00:00:00.000Z';
const Q4_END = '2027-01-01T00:00:00.000Z';
const TODAY = '2026-09-19T00:00:00.000Z';

// ---------------------------------------------------------------- nodes

export const canonicalValueNodeSpecs: readonly NodeSpec[] = [
  // --- commercial origin ---
  { handle: 'oppValue', metric: 'OpportunityValue', subject: 'memoire:opportunity:opp-8821',
    horizon: 'current', label: 'Opportunity Value — Rohto Q4 tender' },
  { handle: 'oppProb', metric: 'OpportunityProbability', subject: 'memoire:opportunity:opp-8821',
    horizon: 'current', label: 'Opportunity Probability — Rohto Q4 tender' },
  { handle: 'expRevenue', metric: 'ExpectedRevenue', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Expected Revenue — Rohto Q4 tender' },
  { handle: 'customerValue', metric: 'CustomerValue', subject: 'memoire:customer:a3f2c1d4',
    horizon: 'lifetime', label: 'Customer Value — Rohto Vietnam' },

  // --- the competing tender ---
  { handle: 'oppValueNext', metric: 'OpportunityValue', subject: 'memoire:tender:opp-8940',
    horizon: 'current', label: 'Opportunity Value — provincial tender' },
  { handle: 'expRevenueNext', metric: 'ExpectedRevenue', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Expected Revenue — provincial tender' },
  { handle: 'demandNext', metric: 'DemandQuantity', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Product Demand — provincial tender' },

  // --- demand and supply ---
  { handle: 'demand', metric: 'DemandQuantity', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Product Demand — SKU-X for Rohto' },
  { handle: 'invRequirement', metric: 'InventoryRequirement', subject: 'helm:product:sku-x',
    horizon: 'quarter', label: 'Inventory Requirement — SKU-X' },
  { handle: 'availOwn', metric: 'AvailableInventory', subject: 'helm:inventory:sku-x@wh-hcmc',
    horizon: 'current', label: 'Available Inventory — SKU-X @ HCMC' },
  { handle: 'availDist', metric: 'AvailableInventory', subject: 'helm:inventory:sku-x@dist-d',
    horizon: 'current', label: 'Available Inventory — SKU-X @ Distributor D' },
  { handle: 'invGap', metric: 'InventoryGap', subject: 'helm:product:sku-x',
    horizon: 'current', label: 'Inventory Gap — SKU-X' },
  { handle: 'leadTime', metric: 'LeadTime', subject: 'helm:supplier:supplier-a',
    horizon: 'current', label: 'Lead Time — Supplier A' },
  { handle: 'capUtil', metric: 'CapacityUtilization', subject: 'helm:capacity:field-service-vn',
    horizon: 'quarter', label: 'Capacity Utilization — field service VN' },

  // --- customer-facing consequence ---
  { handle: 'serviceLevel', metric: 'ServiceLevel', subject: 'helm:servicelevel:rohto-98',
    horizon: 'quarter', label: 'Service Level — Rohto commitment' },

  // --- capital and economics ---
  { handle: 'unitCost', metric: 'UnitCost', subject: 'helm:product:sku-x',
    horizon: 'current', label: 'Unit Cost — SKU-X' },
  { handle: 'invValue', metric: 'InventoryValue', subject: 'helm:inventory:sku-x@wh-hcmc',
    horizon: 'current', label: 'Inventory Value — SKU-X @ HCMC' },
  { handle: 'workingCapital', metric: 'WorkingCapital', subject: 'helm:workingcapital:inventory-vn',
    horizon: 'current', label: 'Working Capital — Vietnam inventory' },
  { handle: 'grossMargin', metric: 'GrossMargin', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Gross Margin — Rohto Q4 tender' },
  { handle: 'grossMarginPct', metric: 'GrossMarginPct', subject: 'helm:businessunit:bu-pharma',
    horizon: 'quarter', label: 'Gross Margin % — Pharma BU' },
  { handle: 'freightOpex', metric: 'Opex', subject: 'helm:cost:expedited-freight',
    horizon: 'quarter', label: 'Operating Expense — expedited freight' },

  // --- risk dimension ---
  { handle: 'supplyRisk', metric: 'SupplyRisk', subject: 'helm:product:sku-x',
    horizon: 'current', label: 'Supply Risk — SKU-X' },
  { handle: 'invRisk', metric: 'InventoryRisk', subject: 'helm:inventory:sku-x@dist-d',
    horizon: 'current', label: 'Inventory Risk — SKU-X @ Distributor D' },
  { handle: 'futureOppRisk', metric: 'FutureOpportunityRisk', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Future Opportunity Risk — provincial tender' },
  { handle: 'concentration', metric: 'ConcentrationRisk', subject: 'helm:supplier:supplier-a',
    horizon: 'current', label: 'Concentration Risk — Supplier A' },
  { handle: 'resilience', metric: 'SourcingResilience', subject: 'helm:product:sku-x',
    horizon: 'current', label: 'Sourcing Resilience — SKU-X' },

  // --- strategic dimension ---
  { handle: 'strategicAlign', metric: 'StrategicAlignment', subject: 'helm:objective:protect-gm-38',
    horizon: 'current', label: 'Strategic Alignment — protect 38% GM' },

  // === TERMINAL: enterprise value as SEVERAL dimensions, never one score ===
  { handle: 'evCash', metric: 'CashImpact', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'quarter', label: 'Enterprise Value — Cash dimension' },
  { handle: 'evMargin', metric: 'GrossMargin', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'quarter', label: 'Enterprise Value — Margin dimension' },
  { handle: 'evService', metric: 'ServiceLevel', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'quarter', label: 'Enterprise Value — Customer dimension' },
  { handle: 'evRisk', metric: 'SupplyRisk', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'current', label: 'Enterprise Value — Risk dimension' },
  { handle: 'evStrategic', metric: 'StrategicAlignment', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'current', label: 'Enterprise Value — Strategic dimension' },
  { handle: 'evWorkingCapital', metric: 'WorkingCapital', subject: 'helm:enterprisevalue:meridian-ev',
    horizon: 'current', label: 'Enterprise Value — Capital dimension' },
];

// ---------------------------------------------------------------- links

export const canonicalValueLinkSpecs: readonly LinkSpec[] = [
  // origin: value and probability drive expected revenue
  { type: 'DRIVES', from: 'oppValue', to: 'expRevenue', confidence: 1,
    note: 'expected revenue depends on the opportunity value' },
  { type: 'DRIVES', from: 'oppProb', to: 'expRevenue', confidence: 1,
    note: 'and on the probability of closing it' },
  { type: 'CONTRIBUTES_TO', from: 'expRevenue', to: 'customerValue', confidence: 0.8 },

  // revenue drives demand drives requirement
  { type: 'DRIVES', from: 'expRevenue', to: 'demand', weight: 12, confidence: 0.7 },
  { type: 'DRIVES', from: 'demand', to: 'invRequirement', weight: 1, confidence: 0.9 },
  { type: 'DRIVES', from: 'oppValueNext', to: 'expRevenueNext', confidence: 1 },
  { type: 'DRIVES', from: 'expRevenueNext', to: 'demandNext', weight: 9, confidence: 0.45 },

  // THE CONTENTION: two demands consume one inventory position's availability
  { type: 'CONSUMES', from: 'demand', to: 'availOwn', weight: 4, confidence: 0.7,
    note: 'Rohto Q4 tender draws on company stock' },
  { type: 'CONSUMES', from: 'demandNext', to: 'availOwn', weight: 4, confidence: 0.45,
    note: 'the provincial tender draws on the SAME company stock' },
  { type: 'CONSUMES', from: 'demand', to: 'availDist', weight: 8, confidence: 0.55 },

  // availability and requirement determine the gap
  { type: 'DRIVES', from: 'invRequirement', to: 'invGap', confidence: 0.9 },
  { type: 'CONSTRAINS', from: 'availOwn', to: 'invGap', confidence: 1 },
  { type: 'CONSTRAINS', from: 'availDist', to: 'invGap', confidence: 0.8 },
  { type: 'CONSTRAINS', from: 'leadTime', to: 'availOwn', lagDays: 21, confidence: 0.92 },

  // the gap threatens service; availability enables it
  { type: 'REDUCES', from: 'invGap', to: 'serviceLevel', confidence: 0.75 },
  { type: 'ENABLES', from: 'availOwn', to: 'serviceLevel', confidence: 0.8 },
  { type: 'CONSTRAINS', from: 'capUtil', to: 'serviceLevel', confidence: 0.6 },

  // inventory is capital
  { type: 'DRIVES', from: 'invRequirement', to: 'invValue', confidence: 0.85 },
  { type: 'DRIVES', from: 'unitCost', to: 'invValue', confidence: 1 },
  { type: 'CONSUMES', from: 'invValue', to: 'workingCapital', confidence: 0.9,
    note: 'stock ties up capital' },

  // economics
  { type: 'DRIVES', from: 'expRevenue', to: 'grossMargin', confidence: 0.7 },
  { type: 'REDUCES', from: 'unitCost', to: 'grossMargin', confidence: 0.9 },
  { type: 'REDUCES', from: 'freightOpex', to: 'grossMargin', confidence: 0.8,
    note: 'expediting protects revenue and costs margin — the trade-off in one edge' },
  { type: 'CONTRIBUTES_TO', from: 'grossMargin', to: 'grossMarginPct', confidence: 0.9 },

  // risk
  { type: 'EXPOSES', from: 'leadTime', to: 'supplyRisk', confidence: 0.8 },
  { type: 'EXPOSES', from: 'concentration', to: 'supplyRisk', confidence: 0.85 },
  { type: 'PROTECTS', from: 'availDist', to: 'supplyRisk', confidence: 0.6 },
  { type: 'EXPOSES', from: 'availDist', to: 'invRisk', confidence: 0.7,
    note: 'distributor stock nearest expiry' },
  { type: 'EXPOSES', from: 'availOwn', to: 'futureOppRisk', confidence: 0.5,
    note: 'committing this stock puts the next tender at risk' },
  { type: 'REDUCES', from: 'concentration', to: 'resilience', confidence: 0.8 },

  // strategy
  { type: 'CONTRIBUTES_TO', from: 'grossMarginPct', to: 'strategicAlign', confidence: 0.7 },

  // === terminal: into the enterprise value DIMENSIONS ===
  { type: 'CONTRIBUTES_TO', from: 'workingCapital', to: 'evWorkingCapital', confidence: 0.9 },
  { type: 'CONSUMES', from: 'workingCapital', to: 'evCash', confidence: 0.85,
    note: 'capital tied up is cash not available' },
  { type: 'CONTRIBUTES_TO', from: 'grossMargin', to: 'evMargin', confidence: 0.9 },
  { type: 'CONTRIBUTES_TO', from: 'grossMargin', to: 'evCash', confidence: 0.8 },
  { type: 'CONTRIBUTES_TO', from: 'serviceLevel', to: 'evService', confidence: 0.8 },
  { type: 'CONTRIBUTES_TO', from: 'supplyRisk', to: 'evRisk', confidence: 0.8 },
  { type: 'CONTRIBUTES_TO', from: 'futureOppRisk', to: 'evRisk', confidence: 0.6 },
  { type: 'CONTRIBUTES_TO', from: 'strategicAlign', to: 'evStrategic', confidence: 0.7 },
];

// --------------------------------------------------------- observations

/**
 * Note the deliberate spread of observation types on Gross Margin %:
 * an ACTUAL, a FORECAST, a TARGET and two SCENARIO values coexist. None
 * supersedes another — they are different kinds of fact about the same node.
 */
export const canonicalObservationSpecs: readonly ObsSpec[] = [
  // --- commercial, straight from Memoire ---
  { node: 'oppValue', type: 'ACTUAL', value: 4.2e9, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, observedAt: '2026-09-18T11:02:00.000Z', source: 'memoire', confidence: 1 },
  { node: 'oppProb', type: 'ACTUAL', value: 0.7, unit: 'ratio',
    effectiveAt: TODAY, observedAt: '2026-09-18T11:02:00.000Z', source: 'memoire', confidence: 0.7 },
  { node: 'expRevenue', type: 'FORECAST', value: 2.94e9, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, observedAt: '2026-09-18T11:02:00.000Z',
    source: 'memoire', confidence: 0.7,
    note: 'stated by the commercial system; HELM does not derive it in Phase 2' },
  { node: 'customerValue', type: 'ACTUAL', value: 1.86e10, unit: 'currency', currency: 'VND',
    periodStart: '2022-01-01T00:00:00.000Z', periodEnd: TODAY, source: 'finance', confidence: 0.9 },

  { node: 'oppValueNext', type: 'ACTUAL', value: 3.1e9, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, observedAt: '2026-09-17T15:40:00.000Z', source: 'memoire', confidence: 1 },
  { node: 'expRevenueNext', type: 'FORECAST', value: 1.395e9, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'memoire', confidence: 0.45 },
  { node: 'demandNext', type: 'FORECAST', value: 9, unit: 'units',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'memoire', confidence: 0.45 },

  // --- operations, from SCM ---
  { node: 'demand', type: 'FORECAST', value: 12, unit: 'units',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'memoire', confidence: 0.7 },
  { node: 'invRequirement', type: 'FORECAST', value: 12, unit: 'units',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'scm', confidence: 0.7 },
  { node: 'availOwn', type: 'ACTUAL', value: 4, unit: 'units',
    effectiveAt: '2026-09-19T06:00:00.000Z', observedAt: '2026-09-19T06:00:00.000Z',
    source: 'scm', confidence: 1 },
  { node: 'availDist', type: 'ACTUAL', value: 8, unit: 'units',
    effectiveAt: '2026-09-19T06:00:00.000Z', observedAt: '2026-09-19T06:00:00.000Z',
    source: 'scm', confidence: 0.8 },
  { node: 'invGap', type: 'ESTIMATE', value: 8, unit: 'units',
    effectiveAt: TODAY, source: 'helm', confidence: 0.7,
    note: 'stated as an estimate — Phase 3 will DERIVE it from requirement minus availability' },
  { node: 'leadTime', type: 'ACTUAL', value: 21, unit: 'days',
    effectiveAt: TODAY, source: 'scm', confidence: 0.92 },
  { node: 'capUtil', type: 'ACTUAL', value: 78, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'scm', confidence: 0.85 },

  // --- service level: target vs forecast diverge, which is the point ---
  { node: 'serviceLevel', type: 'TARGET', value: 98, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'manual', confidence: 1 },
  { node: 'serviceLevel', type: 'FORECAST', value: 84, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', confidence: 0.6 },

  // --- capital and economics ---
  { node: 'unitCost', type: 'ACTUAL', value: 2.17e8, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, source: 'erp', confidence: 1 },
  { node: 'invValue', type: 'ACTUAL', value: 8.68e8, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, source: 'erp', confidence: 1 },
  { node: 'workingCapital', type: 'ACTUAL', value: 1.24e10, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, source: 'finance', confidence: 0.95 },
  { node: 'grossMargin', type: 'FORECAST', value: 1.1172e9, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'finance', confidence: 0.7 },
  { node: 'freightOpex', type: 'ESTIMATE', value: 1.4e8, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'scm', confidence: 0.6 },

  // Gross Margin %: the full spread of observation types on one node.
  { node: 'grossMarginPct', type: 'ACTUAL', value: 38, unit: 'percentage',
    periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z',
    observedAt: '2026-10-02T09:00:00.000Z', source: 'erp', confidence: 1 },
  { node: 'grossMarginPct', type: 'FORECAST', value: 35, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'finance', confidence: 0.7 },
  { node: 'grossMarginPct', type: 'TARGET', value: 40, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'manual', confidence: 1 },
  { node: 'grossMarginPct', type: 'SCENARIO', value: 34, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', scenario: 'expedite', confidence: 0.6,
    note: 'expediting protects the deal and costs margin' },
  { node: 'grossMarginPct', type: 'SCENARIO', value: 37, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', scenario: 'reallocate', confidence: 0.55 },

  // Service level under the same two scenarios — so a reader can see the trade-off.
  { node: 'serviceLevel', type: 'SCENARIO', value: 97, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', scenario: 'expedite', confidence: 0.6 },
  { node: 'serviceLevel', type: 'SCENARIO', value: 95, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', scenario: 'reallocate', confidence: 0.55 },

  // --- risk ---
  { node: 'supplyRisk', type: 'ESTIMATE', value: 62, unit: 'score',
    effectiveAt: TODAY, source: 'helm', confidence: 0.6 },
  { node: 'invRisk', type: 'ESTIMATE', value: 4.34e8, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, source: 'scm', confidence: 0.55 },
  { node: 'futureOppRisk', type: 'SCENARIO', value: 1.395e9, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', scenario: 'reallocate', confidence: 0.5,
    note: 'reallocating distributor stock puts the provincial tender at risk' },
  { node: 'concentration', type: 'ACTUAL', value: 100, unit: 'percentage',
    effectiveAt: TODAY, source: 'scm', confidence: 0.9, note: 'single source' },
  { node: 'resilience', type: 'ESTIMATE', value: 25, unit: 'score',
    effectiveAt: TODAY, source: 'helm', confidence: 0.5 },

  // --- strategy ---
  { node: 'strategicAlign', type: 'ASSUMPTION', value: 72, unit: 'score',
    effectiveAt: TODAY, source: 'manual', confidence: 0.5,
    note: 'a management judgement, recorded as an assumption rather than a measurement' },

  // --- enterprise value dimensions ---
  { node: 'evCash', type: 'FORECAST', value: -8.4e8, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', confidence: 0.55 },
  { node: 'evMargin', type: 'FORECAST', value: 1.1172e9, unit: 'currency', currency: 'VND',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', confidence: 0.6 },
  { node: 'evService', type: 'FORECAST', value: 84, unit: 'percentage',
    periodStart: Q4_START, periodEnd: Q4_END, source: 'helm', confidence: 0.6 },
  { node: 'evRisk', type: 'ESTIMATE', value: 62, unit: 'score',
    effectiveAt: TODAY, source: 'helm', confidence: 0.5 },
  { node: 'evStrategic', type: 'ASSUMPTION', value: 72, unit: 'score',
    effectiveAt: TODAY, source: 'manual', confidence: 0.5 },
  { node: 'evWorkingCapital', type: 'ACTUAL', value: 1.24e10, unit: 'currency', currency: 'VND',
    effectiveAt: TODAY, source: 'finance', confidence: 0.95 },
];

/** Scenario entities the SCENARIO observations refer to. */
const SCENARIOS = [
  { handle: 'expedite', ref: 'opt-a-expedite', name: 'Option A — Expedite import' },
  { handle: 'reallocate', ref: 'opt-b-reallocate', name: 'Option B — Reallocate distributor stock' },
] as const;

/**
 * Builds the canonical value chain on top of an existing Phase 1 entity graph.
 * Idempotent: value nodes upsert, so running twice yields the same structure.
 */
export async function buildCanonicalValueChain(
  valueGraph: ValueGraph,
  graphStore: GraphStore,
  scope: Scope,
): Promise<Result<CanonicalValueChain>> {
  // --- scenario entities, so SCENARIO observations have somewhere to point ---
  const scenarioIds: Record<string, EntityId> = {};
  for (const s of SCENARIOS) {
    const r = await graphStore.upsertEntity(scope, {
      entityTypeKey: 'Scenario',
      canonicalKey: canonicalKey('helm', 'scenario', s.ref),
      name: s.name,
      sourceSystem: 'helm',
      attributes: { kind: 'variant' },
    });
    if (!r.ok) return r;
    scenarioIds[s.handle] = r.value.entity.id;
  }

  // --- resolve ontology subjects by canonical key ---
  const subjectIds = new Map<string, EntityId>();
  for (const spec of canonicalValueNodeSpecs) {
    if (!spec.subject || subjectIds.has(spec.subject)) continue;
    const [ns, kind] = spec.subject.split(':');
    void ns;
    void kind;
    const found = await graphStore.findEntities(scope, {
      canonicalKeys: [spec.subject],
      limit: 1,
    });
    if (!found.ok) return found;
    if (found.value.length === 0) {
      throw new Error(
        `canonical value chain: no ontology entity with canonical key "${spec.subject}". ` +
          'Build the Phase 1 canonical scenario first.',
      );
    }
    subjectIds.set(spec.subject, found.value[0].id);
  }

  // --- nodes ---
  const nodeIds: Record<string, string> = {};
  for (const spec of canonicalValueNodeSpecs) {
    const r = await valueGraph.upsertValueNode(scope, {
      metricKey: spec.metric,
      subjectEntityId: spec.subject ? subjectIds.get(spec.subject)! : null,
      scopeKind: spec.scopeKind ?? null,
      scopeRef: spec.scopeRef ?? null,
      timeHorizon: spec.horizon ?? null,
      label: spec.label,
    });
    if (!r.ok) return r;
    nodeIds[spec.handle] = r.value.id;
  }

  // --- links ---
  let linkCount = 0;
  const existingLinks = await valueGraph.findValueLinks(scope, { limit: 1000 });
  if (!existingLinks.ok) return existingLinks;
  const linkSeen = new Set(
    existingLinks.value.map((l) => `${l.linkType}|${l.sourceNodeId}|${l.targetNodeId}`),
  );

  for (const spec of canonicalValueLinkSpecs) {
    const from = nodeIds[spec.from];
    const to = nodeIds[spec.to];
    if (!from || !to) {
      throw new Error(`canonical value chain: unknown node handle ${spec.from} -> ${spec.to}`);
    }
    const key = `${spec.type}|${from}|${to}`;
    if (linkSeen.has(key)) {
      linkCount += 1;
      continue;
    }
    const r = await valueGraph.createValueLink(scope, {
      linkType: spec.type,
      sourceNodeId: from,
      targetNodeId: to,
      weight: spec.weight ?? null,
      confidence: spec.confidence ?? null,
      lagDays: spec.lagDays ?? null,
      sourceSystem: 'helm',
      metadata: spec.note ? { note: spec.note } : {},
    });
    if (!r.ok) return r;
    linkSeen.add(key);
    linkCount += 1;
  }

  // --- observations, each with provenance ---
  let observationCount = 0;
  for (const spec of canonicalObservationSpecs) {
    const nodeId = nodeIds[spec.node];
    if (!nodeId) throw new Error(`canonical value chain: unknown node handle ${spec.node}`);

    // Skip if this exact claim already exists — keeps the build idempotent.
    const existing = await valueGraph.getObservations(scope, {
      nodeId,
      types: [spec.type],
      scenarioEntityId: spec.scenario ? scenarioIds[spec.scenario] : null,
      limit: 50,
    });
    if (!existing.ok) return existing;
    if (existing.value.some((o) => o.numericValue === spec.value)) {
      observationCount += 1;
      continue;
    }

    const prov = await valueGraph.recordProvenance(scope, {
      subjectKind: 'value_observation',
      subjectId: 'pending',
      sourceField: null,
      method:
        spec.type === 'ASSUMPTION'
          ? 'human_assumption'
          : spec.source === 'helm'
            ? 'derived'
            : 'ingested',
      system: spec.source,
      connector: 'canonical-value-chain@0.1.0',
      sourceObjectType: null,
      sourceObjectId: null,
      ingestionEventId: null,
      transformation: spec.note ?? null,
      inputs: null,
      actorId: null,
      confidence: spec.confidence ?? null,
      notes: spec.note ?? null,
      payload: null,
      observedAt: spec.observedAt ? asValidTime(spec.observedAt) : null,
    });
    if (!prov.ok) return prov;

    const r = await valueGraph.recordObservation(scope, {
      nodeId,
      observationType: spec.type,
      numericValue: spec.value,
      unitType: spec.unit,
      currency: spec.currency ?? null,
      effectiveAt: spec.effectiveAt ? asValidTime(spec.effectiveAt) : null,
      periodStart: spec.periodStart ? asValidTime(spec.periodStart) : null,
      periodEnd: spec.periodEnd ? asValidTime(spec.periodEnd) : null,
      observedAt: spec.observedAt ? asValidTime(spec.observedAt) : null,
      scenarioEntityId: spec.scenario ? scenarioIds[spec.scenario] : null,
      confidence: spec.confidence ?? null,
      sourceSystem: spec.source,
      provenanceId: prov.value.id,
      metadata: spec.note ? { note: spec.note } : {},
    });
    if (!r.ok) return r;

    // Re-point the provenance record at the observation now that it has an id.
    const linked = await valueGraph.recordProvenance(scope, {
      ...prov.value,
      subjectId: r.value.id,
    });
    if (!linked.ok) return linked;
    observationCount += 1;
  }

  return {
    ok: true,
    value: {
      nodeIds,
      scenarioIds,
      nodeCount: canonicalValueNodeSpecs.length,
      linkCount,
      observationCount,
    },
  };
}
