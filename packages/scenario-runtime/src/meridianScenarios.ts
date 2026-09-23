/**
 * The canonical Meridian scenarios — the Rohto opportunity, as data.
 *
 * Baseline: a 4.2B VND opportunity at 70%, four units in the HCMC warehouse,
 * eight at Distributor D, a 21-day lead time from a single supplier, and a
 * provincial tender that wants the same four units.
 *
 * Every alternative is a set of explicit overrides with a rationale, a
 * confidence and a provenance kind. NO OUTCOME IS WRITTEN HERE: not a margin,
 * not a service level, not a cash figure. Every consequence is computed by
 * Meridian model v1.1 through the propagation engine, and a scenario that
 * needed an outcome stated would be refused (OVERRIDE_TARGETS_COMPUTED_NODE).
 *
 * Handles refer to the canonical value chain and its Phase 4 extension.
 */

import { quarterPeriod, type Period, type Result, type Scope } from '@helm/shared';
import type {
  ConstraintDefinition,
  ForkPoint,
  OverrideProvenanceKind,
  OverrideType,
  Scenario,
  ScenarioRevision,
} from './types.ts';
import type { ScenarioRuntime } from './port.ts';
import type { OverrideOperation } from '@helm/propagation-engine';
import type { UnitType } from '@helm/value-graph';

export const Q4_2026: Period = quarterPeriod(2026, 4);
export const Q1_2027: Period = quarterPeriod(2027, 1);

export type CanonicalOverrideSpec = {
  readonly node: string;
  readonly overrideType: OverrideType;
  readonly operation: OverrideOperation;
  readonly value: string;
  readonly unit: UnitType;
  readonly currency?: string;
  /** Omitted = every period the scenario simulates. */
  readonly period?: Period;
  readonly provenanceKind: OverrideProvenanceKind;
  readonly rationale: string;
  readonly confidence: number;
};

export type CanonicalScenarioSpec = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly parent?: string;
  readonly periods: readonly Period[];
  readonly overrides: readonly CanonicalOverrideSpec[];
};

export const meridianCanonicalScenarios: readonly CanonicalScenarioSpec[] = [
  {
    key: 'expedite',
    name: 'A — Expedite supply',
    description:
      'Air-freight eight units from Supplier A so the Rohto order can ship from own stock in Q4.',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'availOwn', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '8', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.8,
        rationale: 'An expedited air shipment of 8 units lands in HCMC before the delivery date.',
      },
      {
        node: 'freightOpex', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '80000000',
        unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', confidence: 0.85,
        rationale: 'Air-freight premium quoted by the forwarder, on top of the current 140M estimate.',
      },
      {
        node: 'leadTime', overrideType: 'ASSUMPTION_OVERRIDE', operation: 'SET', value: '7', unit: 'days',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.7,
        rationale: 'Expedited lead time from Supplier A: 7 days instead of 21.',
      },
    ],
  },
  {
    key: 'expedite-price-increase',
    name: 'A+ — Expedite, and price the urgency',
    description:
      'Inherits Expedite, then raises the realised price and restates the freight premium. ' +
      'Shows inheritance: the child\'s freight shadows the parent\'s, visibly.',
    parent: 'expedite',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'aspProduct', overrideType: 'ASSUMPTION_OVERRIDE', operation: 'SET', value: '385000000',
        unit: 'currency', currency: 'VND', provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.5,
        rationale: 'Pass a 10% urgency premium to Rohto on the realised unit price.',
      },
      {
        node: 'freightOpex', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '100000000',
        unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', confidence: 0.8,
        rationale: 'Second forwarder quote for a guaranteed slot: 100M premium instead of 80M.',
      },
    ],
  },
  {
    key: 'reallocate',
    name: 'B — Reallocate distributor stock',
    description: 'Pull Distributor D\'s eight consignment units into own stock for the Rohto order.',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'availOwn', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '8', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.75,
        rationale: 'Distributor D\'s 8 consignment units are transferred into the HCMC warehouse.',
      },
      {
        node: 'availDist', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.75,
        rationale: 'Distributor D gives up its consignment stock for the quarter.',
      },
      {
        node: 'freightOpex', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '25000000',
        unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', confidence: 0.7,
        rationale: 'Transfer and re-labelling cost from Distributor D, from the logistics quote.',
      },
    ],
  },
  {
    key: 'alternative-product',
    name: 'C — Offer the alternative analyzer',
    description:
      'Offer an in-stock alternative at a lower price and a higher landed cost. Modelled as ' +
      'substitute economics on the SKU-X position: re-pointing the deal at a different product ' +
      'is a structural change, deferred.',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'aspProduct', overrideType: 'ASSUMPTION_OVERRIDE', operation: 'SET', value: '330000000',
        unit: 'currency', currency: 'VND', provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.6,
        rationale: 'Realised price of the alternative analyzer after the standard discount.',
      },
      {
        node: 'unitCost', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '238700000',
        unit: 'currency', currency: 'VND', provenanceKind: 'EXTERNAL_SIGNAL', confidence: 0.7,
        rationale: 'Landed cost of the alternative analyzer, from its supplier quote.',
      },
      {
        node: 'availOwn', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '12', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.7,
        rationale: 'Twelve units of the alternative are already in the HCMC warehouse.',
      },
    ],
  },
  {
    key: 'delay-delivery',
    name: 'D — Delay Rohto delivery to 2027-Q1',
    description:
      'Move the Rohto delivery into 2027-Q1 and let standard replenishment arrive. Simplified ' +
      'revenue timing: an order is recognised wholly in the quarter it is delivered.',
    periods: [Q4_2026, Q1_2027],
    overrides: [
      {
        node: 'oppValue', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0',
        unit: 'currency', currency: 'VND', period: Q4_2026, provenanceKind: 'MODEL_ASSUMPTION',
        confidence: 0.9,
        rationale:
          'Simplified timing: delivery moves to 2027-Q1, so the order contributes nothing to 2026-Q4.',
      },
      {
        node: 'freightOpex', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0',
        unit: 'currency', currency: 'VND', period: Q4_2026, provenanceKind: 'MANAGEMENT_ASSUMPTION',
        confidence: 0.8,
        rationale: 'Nothing ships to Rohto in 2026-Q4, so no fulfilment cost falls there.',
      },
      {
        node: 'oppValueNext', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0',
        unit: 'currency', currency: 'VND', period: Q1_2027, provenanceKind: 'MODEL_ASSUMPTION',
        confidence: 0.8,
        rationale: 'The provincial tender delivers in 2026-Q4 (closes 20 Nov); it draws nothing in 2027-Q1.',
      },
      {
        node: 'freightOpex', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0',
        unit: 'currency', currency: 'VND', period: Q1_2027, provenanceKind: 'MANAGEMENT_ASSUMPTION',
        confidence: 0.7,
        rationale: 'A planned delivery ships by sea at standard cost, already inside unit cost.',
      },
      {
        node: 'availOwn', overrideType: 'VALUE_OVERRIDE', operation: 'ADD', value: '4', unit: 'units',
        period: Q1_2027, provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.7,
        rationale: 'A standard replenishment of 4 units (21-day lead time) lands before 2027-Q1.',
      },
    ],
  },
  {
    key: 'prioritize-rohto',
    name: 'P — Commit own stock to Rohto',
    description: 'All four own units go to the Rohto order; nothing is held for the provincial tender.',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'allocated', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '4', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.9,
        rationale: 'All four HCMC units are committed to the Rohto order.',
      },
      {
        node: 'allocatedNext', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.9,
        rationale: 'No own stock is held back for the provincial tender.',
      },
    ],
  },
  {
    key: 'preserve-tender',
    name: 'T — Preserve own stock for the tender',
    description: 'The four own units are held for the provincial tender; the Rohto order gets none.',
    periods: [Q4_2026],
    overrides: [
      {
        node: 'allocated', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '0', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.9,
        rationale: 'No own stock is committed to the Rohto order.',
      },
      {
        node: 'allocatedNext', overrideType: 'VALUE_OVERRIDE', operation: 'SET', value: '4', unit: 'units',
        provenanceKind: 'MANAGEMENT_ASSUMPTION', confidence: 0.9,
        rationale: 'All four HCMC units are held for the provincial tender.',
      },
    ],
  },
];

/**
 * Feasibility, not optimization: each asks whether a state's requirement fits
 * what it has available, and says by how much it does not.
 */
export const meridianConstraintsV1: readonly ConstraintDefinition[] = [
  {
    key: 'rohto-order-fulfilment',
    version: '1.0.0',
    name: 'Rohto order ships from own stock',
    description:
      'If the Rohto deal is won, its full order must ship from stock the business owns in the period.',
    kind: 'INVENTORY',
    severity: 'HIGH',
    required: { metricKey: 'OrderQuantity', subject: 'memoire:opportunity:opp-8821' },
    available: { metricKey: 'AvailableInventory', subject: 'helm:inventory:sku-x@wh-hcmc' },
  },
  {
    key: 'own-stock-allocation',
    version: '1.0.0',
    name: 'Allocations fit own stock',
    description: 'Stock committed to opportunities cannot exceed the own stock there is.',
    kind: 'INVENTORY',
    severity: 'MEDIUM',
    required: {
      sumOf: {
        metricKey: 'AllocatedInventory',
        subjects: ['memoire:opportunity:opp-8821', 'memoire:tender:opp-8940'],
      },
    },
    available: { metricKey: 'AvailableInventory', subject: 'helm:inventory:sku-x@wh-hcmc' },
  },
];

/**
 * Value positions every Meridian state shows, even where v1.1 computes nothing
 * about them. They are carried from the baseline and labelled as such — the
 * service level and the risk scores a manager expects to see do not vanish
 * because no model derives them yet, and they are never presented as modelled.
 */
export const meridianStateFrame: readonly string[] = [
  'ServiceLevel',
  'SupplyRisk',
  'InventoryRisk',
  'LeadTime',
  'FutureOpportunityRisk',
  'AvailableInventory',
  'AllocatedInventory',
];

/**
 * Creates the canonical scenarios through the runtime — the same path a user's
 * scenario takes — and seals each one. Parents are sealed before their
 * children are created, because a child pins a sealed parent revision.
 */
export async function buildMeridianScenarios(
  runtime: ScenarioRuntime,
  scope: Scope,
  nodeIds: Readonly<Record<string, string>>,
  options: { fork?: Partial<ForkPoint>; only?: readonly string[] } = {},
): Promise<Result<Record<string, { scenario: Scenario; revision: ScenarioRevision }>>> {
  const built: Record<string, { scenario: Scenario; revision: ScenarioRevision }> = {};
  const specs = meridianCanonicalScenarios.filter(
    (s) => !options.only || options.only.includes(s.key) || options.only.some((k) => isAncestor(s.key, k)),
  );
  for (const spec of specs) {
    const parent = spec.parent ? built[spec.parent] : undefined;
    const created = await runtime.createScenario(scope, {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      parentScenarioId: parent?.scenario.id ?? null,
      fork: parent ? undefined : options.fork,
      periods: spec.periods,
      metadata: { canonical: true },
    });
    if (!created.ok) return created;
    for (const o of spec.overrides) {
      const nodeId = nodeIds[o.node];
      if (!nodeId) throw new Error(`canonical scenario ${spec.key}: unknown node handle ${o.node}`);
      const added = await runtime.addOverride(scope, created.value.revision.id, {
        overrideType: o.overrideType,
        targetNodeId: nodeId,
        operation: o.operation,
        value: o.value,
        unit: o.unit,
        currency: o.currency ?? null,
        period: o.period ?? null,
        provenanceKind: o.provenanceKind,
        rationale: o.rationale,
        confidence: o.confidence,
      });
      if (!added.ok) return added;
    }
    const sealed = await runtime.markReady(scope, created.value.revision.id);
    if (!sealed.ok) return sealed;
    const scenario = await runtime.getScenario(scope, created.value.scenario.id);
    if (!scenario.ok) return scenario;
    built[spec.key] = { scenario: scenario.value!, revision: sealed.value };
  }
  return { ok: true, value: built };
}

/** Is `ancestorKey` an ancestor of `key` in the canonical set? */
function isAncestor(ancestorKey: string, key: string): boolean {
  let cursor = meridianCanonicalScenarios.find((s) => s.key === key);
  while (cursor?.parent) {
    if (cursor.parent === ancestorKey) return true;
    cursor = meridianCanonicalScenarios.find((s) => s.key === cursor!.parent);
  }
  return false;
}
