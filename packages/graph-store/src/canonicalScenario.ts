/**
 * The canonical enterprise graph — Meridian Life Sciences Vietnam.
 *
 * A fictional multinational pharma / laboratory / industrial-technology
 * distributor. No real-world confidential data.
 *
 * This is the Phase 1 proof that HELM can represent an enterprise as a
 * connected system rather than a set of tables. It builds:
 *
 *   * the structural spine   Enterprise → Region → Country → BU → Functions
 *   * the commercial chain   Customer → Opportunity → Product
 *   * the operational chain  Product → Supplier / Inventory → Warehouse
 *   * the contention edge    two opportunities CONSUMING one inventory position
 *   * management alignment   Objective owned by a Role, supported by the deal
 *
 * It is adapter-agnostic: the same builder loads into InMemoryGraphStore or
 * PostgresGraphStore, which is what makes cross-adapter equivalence testable.
 *
 * Every entity and relationship written here also writes a provenance record
 * with method='seeded', so even fixture data is traceable and the provenance
 * mechanism is exercised from the very first row.
 */

import {
  asValidTime,
  type EntityId,
  type Result,
  type Scope,
  type SourceSystem,
} from '@helm/shared';
import { canonicalKey } from '@helm/ontology';
import type { GraphStore } from './port.ts';

export type CanonicalGraph = {
  /** Every entity by a short readable handle, for assertions and navigation. */
  ids: Record<string, EntityId>;
  entityCount: number;
  relationshipCount: number;
};

type EntitySpec = {
  handle: string;
  type: string;
  ref: string;
  name: string;
  namespace?: string;
  source?: SourceSystem;
  sourceType?: string;
  sourceId?: string;
  observedAt?: string;
  confidence?: number;
  attributes?: Record<string, unknown>;
};

type RelSpec = {
  type: string;
  from: string;
  to: string;
  weight?: number;
  confidence?: number;
  lagDays?: number;
  note?: string;
};

// ---------------------------------------------------------------- entities

const ENTITIES: readonly EntitySpec[] = [
  // --- structural spine ---
  { handle: 'group', type: 'Enterprise', ref: 'meridian', name: 'Meridian Life Sciences',
    attributes: { baseCurrency: 'USD', fiscalYearStartMonth: 1 } },
  { handle: 'sea', type: 'Region', ref: 'sea', name: 'Southeast Asia',
    attributes: { regionCode: 'SEA' } },
  { handle: 'vn', type: 'Country', ref: 'vn', name: 'Vietnam',
    attributes: { iso2: 'VN', currency: 'VND' } },
  { handle: 'buPharma', type: 'BusinessUnit', ref: 'bu-pharma', name: 'Pharma BU',
    attributes: { unitCode: 'VN-PHARMA' } },
  { handle: 'buLab', type: 'BusinessUnit', ref: 'bu-lab', name: 'Laboratory BU',
    attributes: { unitCode: 'VN-LAB' } },
  { handle: 'fnCommercial', type: 'Function', ref: 'commercial', name: 'Commercial',
    attributes: { functionCode: 'COMM' } },
  { handle: 'fnSupply', type: 'Function', ref: 'supply-chain', name: 'Supply Chain',
    attributes: { functionCode: 'SCM' } },
  { handle: 'fnFinance', type: 'Function', ref: 'finance', name: 'Finance',
    attributes: { functionCode: 'FIN' } },
  { handle: 'fnService', type: 'Function', ref: 'service', name: 'Service',
    attributes: { functionCode: 'SVC' } },

  // --- accountability ---
  { handle: 'roleGM', type: 'Role', ref: 'country-gm-vn', name: 'Country GM Vietnam',
    attributes: { title: 'Country General Manager', level: 'L5' } },
  { handle: 'roleCommDir', type: 'Role', ref: 'commercial-director-vn',
    name: 'Commercial Director Vietnam',
    attributes: { title: 'Commercial Director', level: 'L4' } },
  { handle: 'personGM', type: 'Person', ref: 'p-nguyen', name: 'Nguyen Thi Mai',
    attributes: { startDate: '2024-03-01' } },

  // --- market ---
  { handle: 'mktPharmaVN', type: 'Market', ref: 'pharma-vn', name: 'Vietnam Pharma Market',
    attributes: { sizeEstimate: 7.4e12, currency: 'VND' } },
  { handle: 'segPharma', type: 'Segment', ref: 'pharma', name: 'Pharma',
    attributes: { segmentCode: 'PHARMA' } },

  // --- commercial: projected from Memoire, referenced not copied ---
  { handle: 'rohto', type: 'Customer', ref: 'a3f2c1d4', name: 'Rohto Vietnam',
    namespace: 'memoire', source: 'memoire', sourceType: 'account', sourceId: 'a3f2c1d4',
    observedAt: '2026-09-18T09:14:00.000Z', confidence: 1,
    attributes: { tier: 'key', country: 'VN' } },
  { handle: 'distD', type: 'Distributor', ref: 'dist-d', name: 'Distributor D',
    attributes: { holdsConsignment: true, tier: 'partner', country: 'VN' } },
  { handle: 'oppNow', type: 'Opportunity', ref: 'opp-8821',
    name: 'Rohto Q4 analyzer tender',
    namespace: 'memoire', source: 'memoire', sourceType: 'opportunity', sourceId: 'opp-8821',
    observedAt: '2026-09-18T11:02:00.000Z', confidence: 0.7,
    attributes: {
      value: 4.2e9, currency: 'VND', probability: 0.7,
      expectedCloseDate: '2026-10-19', stage: 'Negotiation',
    } },
  { handle: 'oppNext', type: 'Tender', ref: 'opp-8940',
    name: 'Provincial hospital tender (next month)',
    namespace: 'memoire', source: 'memoire', sourceType: 'opportunity', sourceId: 'opp-8940',
    observedAt: '2026-09-17T15:40:00.000Z', confidence: 0.45,
    attributes: {
      value: 3.1e9, currency: 'VND', probability: 0.45,
      expectedCloseDate: '2026-11-20', submissionDeadline: '2026-11-05',
    } },
  { handle: 'skuX', type: 'Product', ref: 'sku-x', name: 'SKU-X Benchtop Analyzer',
    attributes: {
      sku: 'SKU-X', listPrice: 3.5e8, standardCost: 2.17e8,
      currency: 'VND', shelfLifeDays: 540,
    } },
  { handle: 'portfolioDx', type: 'Portfolio', ref: 'diagnostics',
    name: 'Diagnostics Portfolio', attributes: { portfolioCode: 'DX' } },

  // --- operations ---
  { handle: 'supplierA', type: 'Supplier', ref: 'supplier-a', name: 'Supplier A (Osaka)',
    attributes: { leadTimeDays: 21, reliabilityScore: 0.92, country: 'JP' } },
  { handle: 'whHCMC', type: 'Warehouse', ref: 'wh-hcmc', name: 'HCMC Central Warehouse',
    attributes: { locationCode: 'VN-HCM-01', country: 'VN' } },
  { handle: 'invOwn', type: 'Inventory', ref: 'sku-x@wh-hcmc',
    name: 'SKU-X @ HCMC Warehouse',
    source: 'scm', sourceType: 'stock_position', sourceId: 'SKU-X/VN-HCM-01',
    observedAt: '2026-09-19T06:00:00.000Z', confidence: 1,
    attributes: {
      sku: 'SKU-X', stockOnHand: 4, stockInbound: 0, unitCost: 2.17e8,
      currency: 'VND', ownership: 'own', expiryDate: '2028-02-01',
    } },
  { handle: 'invDist', type: 'Inventory', ref: 'sku-x@dist-d',
    name: 'SKU-X @ Distributor D',
    source: 'scm', sourceType: 'stock_position', sourceId: 'SKU-X/DIST-D',
    observedAt: '2026-09-19T06:00:00.000Z', confidence: 0.8,
    attributes: {
      sku: 'SKU-X', stockOnHand: 8, stockInbound: 0, unitCost: 2.17e8,
      currency: 'VND', ownership: 'distributor', expiryDate: '2027-11-15',
    } },
  { handle: 'capService', type: 'Capacity', ref: 'field-service-vn',
    name: 'Field Service Engineers Vietnam',
    attributes: { availableMinutesPerWeek: 7200, resourceCount: 3, unit: 'engineer-minutes' } },
  { handle: 'slaRohto', type: 'ServiceLevel', ref: 'rohto-98',
    name: 'Rohto 98% on-time commitment',
    attributes: { targetPct: 0.98, penaltyClause: '2% of order value per week late' } },

  // --- finance ---
  { handle: 'wcInventory', type: 'WorkingCapital', ref: 'inventory-vn',
    name: 'Vietnam inventory working capital',
    attributes: { kind: 'inventory', daysOutstanding: 74 } },
  { handle: 'cashVN', type: 'Cash', ref: 'vn-operating',
    name: 'Vietnam operating cash',
    attributes: { balance: 1.8e10, currency: 'VND' } },
  { handle: 'freightCost', type: 'Cost', ref: 'expedited-freight',
    name: 'Expedited air freight',
    attributes: { behaviour: 'variable', currency: 'VND', period: '2026-10' } },
  { handle: 'ev', type: 'EnterpriseValue', ref: 'meridian-ev',
    name: 'Meridian enterprise value', attributes: { currency: 'USD' } },

  // --- management ---
  { handle: 'objMargin', type: 'Objective', ref: 'protect-gm-38',
    name: 'Protect 38% gross margin in Vietnam',
    attributes: { targetValue: 0.38, targetDate: '2026-12-31', unit: 'ratio' } },
  { handle: 'riskConcentration', type: 'Risk', ref: 'supplier-concentration',
    name: 'Single-source dependency on Supplier A',
    attributes: { likelihood: 0.3, impact: 2.4e9, currency: 'VND',
      mitigation: 'Qualify second source (not started)' } },
];

// ----------------------------------------------------------- relationships

const RELATIONSHIPS: readonly RelSpec[] = [
  // structural spine
  { type: 'BELONGS_TO', from: 'sea', to: 'group' },
  { type: 'BELONGS_TO', from: 'vn', to: 'sea' },
  { type: 'BELONGS_TO', from: 'buPharma', to: 'vn' },
  { type: 'BELONGS_TO', from: 'buLab', to: 'vn' },
  { type: 'BELONGS_TO', from: 'fnCommercial', to: 'vn' },
  { type: 'BELONGS_TO', from: 'fnSupply', to: 'vn' },
  { type: 'BELONGS_TO', from: 'fnFinance', to: 'vn' },
  { type: 'BELONGS_TO', from: 'fnService', to: 'vn' },

  // accountability: authority attaches to the Role, the Person merely holds it
  { type: 'HOLDS_ROLE', from: 'personGM', to: 'roleGM' },
  { type: 'REPORTS_TO', from: 'roleCommDir', to: 'roleGM' },
  { type: 'RESPONSIBLE_FOR', from: 'roleGM', to: 'vn' },
  { type: 'RESPONSIBLE_FOR', from: 'roleCommDir', to: 'fnCommercial' },
  { type: 'OWNED_BY', from: 'objMargin', to: 'roleGM' },

  // market position
  { type: 'SERVES', from: 'buPharma', to: 'mktPharmaVN' },
  { type: 'IN_SEGMENT_PLACEHOLDER', from: 'mktPharmaVN', to: 'segPharma', note: 'replaced below' },

  // commercial chain
  { type: 'OWNS', from: 'buPharma', to: 'portfolioDx' },
  { type: 'BELONGS_TO', from: 'skuX', to: 'portfolioDx' },
  { type: 'HELD_BY', from: 'oppNow', to: 'rohto' },
  { type: 'HELD_BY', from: 'oppNext', to: 'rohto' },
  { type: 'SELLS', from: 'oppNow', to: 'skuX', weight: 12, confidence: 0.7 },
  { type: 'SELLS', from: 'oppNext', to: 'skuX', weight: 9, confidence: 0.45 },
  { type: 'SERVES', from: 'fnCommercial', to: 'rohto' },

  // operational chain
  { type: 'SUPPLIED_BY', from: 'skuX', to: 'supplierA', lagDays: 21, confidence: 0.92 },
  { type: 'POSITIONS', from: 'invOwn', to: 'skuX', confidence: 1 },
  { type: 'POSITIONS', from: 'invDist', to: 'skuX', confidence: 0.8 },
  { type: 'STOCKED_AT', from: 'invOwn', to: 'whHCMC' },
  { type: 'STOCKED_AT', from: 'invDist', to: 'distD' },

  // THE CONTENTION: two demands consuming one position, plus the explicit
  // competition edge. This is what lets HELM price the cost of saying yes today.
  { type: 'CONSUMES', from: 'oppNow', to: 'invOwn', weight: 4, confidence: 0.7 },
  { type: 'CONSUMES', from: 'oppNow', to: 'invDist', weight: 8, confidence: 0.55 },
  { type: 'CONSUMES', from: 'oppNext', to: 'invOwn', weight: 4, confidence: 0.45 },
  { type: 'COMPETES_WITH', from: 'oppNow', to: 'oppNext' },

  // service capacity
  { type: 'REQUIRES', from: 'skuX', to: 'capService', weight: 240 },
  { type: 'SERVES', from: 'capService', to: 'rohto' },
  { type: 'AFFECTS', from: 'oppNow', to: 'slaRohto', weight: 1 },

  // financial chain into enterprise value
  { type: 'REQUIRES', from: 'invOwn', to: 'wcInventory', weight: 8.68e8 },
  { type: 'CONVERTS_TO', from: 'wcInventory', to: 'cashVN' },
  { type: 'INCURS', from: 'oppNow', to: 'freightCost', weight: 1.4e8 },
  { type: 'CONTRIBUTES_TO', from: 'cashVN', to: 'ev', weight: 1 },
  { type: 'CONTRIBUTES_TO', from: 'slaRohto', to: 'ev', weight: 0.3 },

  // management alignment and exposure
  { type: 'SUPPORTS', from: 'oppNow', to: 'objMargin' },
  { type: 'EXPOSED_TO', from: 'skuX', to: 'riskConcentration', weight: 1 },
  { type: 'EXPOSED_TO', from: 'oppNow', to: 'riskConcentration', weight: 0.6 },
];

// The SERVES edge to a segment is the one relationship above that needed a
// real type; keeping the list literal and fixing it here avoids a fake type.
const RELATIONSHIP_LIST: readonly RelSpec[] = RELATIONSHIPS.map((r) =>
  r.type === 'IN_SEGMENT_PLACEHOLDER' ? { ...r, type: 'SERVES' } : r,
);

/**
 * Builds the canonical graph into any GraphStore. Idempotent: it upserts, so
 * running it twice leaves the same graph (and the conformance suite asserts
 * exactly that).
 */
export async function buildCanonicalScenario(
  store: GraphStore,
  scope: Scope,
): Promise<Result<CanonicalGraph>> {
  const ids: Record<string, EntityId> = {};

  const evt = await store.startIngestionEvent(scope, 'helm', 'canonical-scenario@0.1.0', null);
  if (!evt.ok) return evt;

  let relationshipCount = 0;

  for (const spec of ENTITIES) {
    const r = await store.upsertEntity(scope, {
      entityTypeKey: spec.type,
      canonicalKey: canonicalKey(spec.namespace ?? 'helm', spec.type.toLowerCase(), spec.ref),
      name: spec.name,
      sourceSystem: spec.source ?? 'helm',
      sourceEntityType: spec.sourceType ?? null,
      sourceEntityId: spec.sourceId ?? null,
      observedAt: spec.observedAt ? asValidTime(spec.observedAt) : null,
      confidence: spec.confidence ?? null,
      attributes: spec.attributes ?? {},
    });
    if (!r.ok) return r;
    ids[spec.handle] = r.value.entity.id;

    // Even fixture data carries provenance — the mechanism is exercised from
    // the first row rather than bolted on when a real connector arrives.
    const prov = await store.recordProvenance(scope, {
      subjectKind: 'entity',
      subjectId: r.value.entity.id,
      sourceField: null,
      method: spec.source && spec.source !== 'helm' ? 'ingested' : 'seeded',
      system: spec.source ?? 'helm',
      connector: 'canonical-scenario@0.1.0',
      sourceObjectType: spec.sourceType ?? null,
      sourceObjectId: spec.sourceId ?? null,
      ingestionEventId: evt.value.id,
      transformation: spec.source === 'memoire'
        ? 'projected from Memoire; reference + snapshot, values not copied'
        : null,
      inputs: null,
      actorId: null,
      confidence: spec.confidence ?? null,
      notes: null,
      payload: spec.sourceId ? { sourceRef: spec.sourceId } : null,
      observedAt: spec.observedAt ? asValidTime(spec.observedAt) : null,
    });
    if (!prov.ok) return prov;

    // External identifiers become aliases, so identity resolution has somewhere
    // to work later (docs/architecture/identity-resolution.md).
    if (spec.source && spec.source !== 'helm' && spec.sourceId) {
      const alias = await store.addAlias(scope, {
        entityId: r.value.entity.id,
        system: spec.source,
        aliasKind: 'source_id',
        aliasValue: spec.sourceId,
        matchMethod: 'exact',
        confidence: 1,
        evidence: null,
        createdBy: null,
      });
      if (!alias.ok) return alias;
    }
  }

  // Rohto is the worked identity-resolution example: the same management entity
  // named three different ways by three different systems.
  for (const [system, kind, value] of [
    ['erp', 'code', 'C004182'],
    ['finance', 'code', 'ROHTO-VN-001'],
  ] as const) {
    const alias = await store.addAlias(scope, {
      entityId: ids.rohto,
      system,
      aliasKind: kind,
      aliasValue: value,
      matchMethod: 'exact',
      confidence: 1,
      evidence: { note: 'seeded cross-system identifier' },
      createdBy: null,
    });
    if (!alias.ok) return alias;
  }

  for (const spec of RELATIONSHIP_LIST) {
    const from = ids[spec.from];
    const to = ids[spec.to];
    if (!from || !to) {
      throw new Error(`canonical scenario: unknown handle ${spec.from} -> ${spec.to}`);
    }
    const r = await store.createRelationship(scope, {
      relationshipTypeKey: spec.type,
      sourceEntityId: from,
      targetEntityId: to,
      weight: spec.weight ?? null,
      confidence: spec.confidence ?? null,
      sourceSystem: 'helm',
      metadata: spec.lagDays ? { lagDays: spec.lagDays } : {},
    });
    if (!r.ok) return r;
    relationshipCount += 1;

    const prov = await store.recordProvenance(scope, {
      subjectKind: 'relationship',
      subjectId: r.value.id,
      sourceField: null,
      method: 'seeded',
      system: 'helm',
      connector: 'canonical-scenario@0.1.0',
      sourceObjectType: null,
      sourceObjectId: null,
      ingestionEventId: evt.value.id,
      transformation: null,
      inputs: null,
      actorId: null,
      confidence: spec.confidence ?? null,
      notes: spec.note ?? null,
      payload: null,
      observedAt: null,
    });
    if (!prov.ok) return prov;
  }

  const done = await store.finishIngestionEvent(
    scope,
    evt.value.id,
    'succeeded',
    ENTITIES.length + relationshipCount,
    'canonical scenario: Meridian Life Sciences Vietnam',
  );
  if (!done.ok) return done;

  return {
    ok: true,
    value: { ids, entityCount: ENTITIES.length, relationshipCount },
  };
}

export const canonicalEntitySpecs = ENTITIES;
export const canonicalRelationshipSpecs = RELATIONSHIP_LIST;
