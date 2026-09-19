/**
 * The seed ontology — HELM's shipped semantic vocabulary.
 *
 * This is DATA, loaded into `helm_entity_types` / `helm_relationship_types`.
 * It is written here so one definition feeds the migration, the in-memory
 * store, and the tests — three consumers that must never disagree.
 *
 * Scope discipline (Phase 1 §14): seeded types are the subset needed for the
 * canonical scenario, the enterprise structural model, and the future Value
 * Graph. Types may exist before the domain logic that reasons about them —
 * that is expected. What is *not* here is anything speculative.
 *
 * Causal relationship types (CAUSES / INFLUENCES / CORRELATES_WITH) are
 * deliberately absent: the Causal Graph is a separate specialised layer in
 * Phase 8, and mixing causal assertions into generic relationships would
 * destroy the distinction between correlation and management causal hypothesis
 * that HELM exists to preserve.
 */

import type {
  EntityCategory,
  JsonSchema,
  RelationshipCategory,
  TypeStatus,
} from './types.ts';

export type SeedEntityType = {
  key: string;
  name: string;
  description: string;
  category: EntityCategory;
  parentKey: string | null;
  attributeSchema: JsonSchema;
  status?: TypeStatus;
};

export type SeedRelationshipType = {
  key: string;
  name: string;
  description: string;
  category: RelationshipCategory;
  isDirected: boolean;
  carriesWeight: boolean;
  sourceCategories: readonly EntityCategory[] | null;
  targetCategories: readonly EntityCategory[] | null;
  inverseKey: string | null;
};

const obj = (
  properties: JsonSchema['properties'] = {},
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
});

const str = (description: string) => ({ type: 'string' as const, description });
const num = (description: string) => ({ type: 'number' as const, description });
const int = (description: string) => ({ type: 'integer' as const, description });
const bool = (description: string) => ({ type: 'boolean' as const, description });
const pct = (description: string) => ({
  type: 'number' as const,
  description,
  minimum: 0,
  maximum: 1,
});

// ===========================================================================
// ENTITY TYPES
// ===========================================================================

export const seedEntityTypes: readonly SeedEntityType[] = [
  // ------------------------------------------------------------ organization
  {
    key: 'Enterprise',
    name: 'Enterprise',
    description: 'The whole group. Root of every organizational hierarchy.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({
      baseCurrency: str('ISO 4217 reporting currency'),
      fiscalYearStartMonth: int('1-12'),
    }),
  },
  {
    key: 'Region',
    name: 'Region',
    description: 'A multi-country grouping used for management reporting.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ regionCode: str('Internal region code') }),
  },
  {
    key: 'Country',
    name: 'Country',
    description: 'A legal and geographic operating unit.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({
      iso2: str('ISO 3166-1 alpha-2'),
      currency: str('Local currency'),
    }),
  },
  {
    key: 'BusinessUnit',
    name: 'Business Unit',
    description: 'A P&L-bearing unit of the enterprise.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ unitCode: str('Internal BU code') }),
  },
  {
    key: 'Function',
    name: 'Function',
    description: 'A functional organization: Commercial, Supply Chain, Finance, Service.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ functionCode: str('Function identifier') }),
  },
  {
    key: 'Team',
    name: 'Team',
    description: 'An operating team within a function or business unit.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ headcount: int('Current headcount') }),
  },
  {
    key: 'Role',
    name: 'Role',
    description:
      'A position carrying accountability and authority, independent of the person holding it. ' +
      'Authority attaches here so a change of seat never silently moves decision rights.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ title: str('Role title'), level: str('Seniority band') }),
  },
  {
    key: 'Person',
    name: 'Person',
    description: 'A named individual. Holds roles over time.',
    category: 'organization',
    parentKey: null,
    attributeSchema: obj({ email: str('Work email'), startDate: str('ISO date') }),
  },

  // -------------------------------------------------------------- commercial
  {
    key: 'Market',
    name: 'Market',
    description: 'An addressable market HELM tracks position in.',
    category: 'market',
    parentKey: null,
    attributeSchema: obj({ sizeEstimate: num('Estimated value'), currency: str('Currency') }),
  },
  {
    key: 'Segment',
    name: 'Segment',
    description: 'A customer or product segment, e.g. Pharma, Laboratory, Industrial.',
    category: 'market',
    parentKey: null,
    attributeSchema: obj({ segmentCode: str('Segment identifier') }),
  },
  {
    key: 'Customer',
    name: 'Customer',
    description: 'A buying organization. Operational record stays in Memoire or ERP.',
    category: 'commercial',
    parentKey: null,
    attributeSchema: obj({ tier: str('Account tier'), country: str('ISO 3166-1 alpha-2') }),
  },
  {
    key: 'Distributor',
    name: 'Distributor',
    description: 'A channel partner that may hold stock on our behalf.',
    category: 'commercial',
    parentKey: 'Customer',
    attributeSchema: obj({ holdsConsignment: bool('Holds consignment stock') }),
  },
  {
    key: 'Opportunity',
    name: 'Opportunity',
    description:
      'An identified revenue event. HELM holds a semantic projection; Memoire remains ' +
      'the operational system of record.',
    category: 'commercial',
    parentKey: null,
    attributeSchema: obj({
      value: num('Estimated value in currency'),
      currency: str('ISO 4217'),
      probability: pct('0..1'),
      expectedCloseDate: str('ISO date'),
      stage: str('Commercial stage as reported by the source'),
    }),
  },
  {
    key: 'Tender',
    name: 'Tender',
    description: 'A formal competitive bid.',
    category: 'commercial',
    parentKey: 'Opportunity',
    attributeSchema: obj({ submissionDeadline: str('ISO date') }),
  },
  {
    key: 'Product',
    name: 'Product',
    description: 'A sellable item.',
    category: 'commercial',
    parentKey: null,
    attributeSchema: obj({
      sku: str('Stock keeping unit'),
      listPrice: num('List price'),
      standardCost: num('Standard unit cost'),
      currency: str('ISO 4217'),
      shelfLifeDays: int('Shelf life in days'),
    }),
  },
  {
    key: 'Portfolio',
    name: 'Portfolio',
    description: 'A managed grouping of products.',
    category: 'commercial',
    parentKey: null,
    attributeSchema: obj({ portfolioCode: str('Portfolio identifier') }),
  },
  {
    key: 'Channel',
    name: 'Channel',
    description: 'A route to market.',
    category: 'commercial',
    parentKey: null,
    attributeSchema: obj({ channelCode: str('Channel identifier') }),
  },
  {
    key: 'Revenue',
    name: 'Revenue',
    description: 'A revenue stream attributable to a cost object or product.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({ currency: str('ISO 4217'), period: str('YYYY-MM') }),
  },

  // -------------------------------------------------------------- operations
  {
    key: 'Supplier',
    name: 'Supplier',
    description: 'An upstream source of product or service.',
    category: 'operations',
    parentKey: null,
    attributeSchema: obj({
      leadTimeDays: int('Typical lead time'),
      reliabilityScore: pct('0..1 on-time performance'),
      country: str('ISO 3166-1 alpha-2'),
    }),
  },
  {
    key: 'Warehouse',
    name: 'Warehouse',
    description: 'A physical stock location.',
    category: 'operations',
    parentKey: null,
    attributeSchema: obj({ locationCode: str('Site code'), country: str('ISO alpha-2') }),
  },
  {
    key: 'Inventory',
    name: 'Inventory Position',
    description:
      'Stock of a product at a location. The unit inventory decisions act on: four units ' +
      'in our warehouse and eight at a distributor are different assets.',
    category: 'operations',
    parentKey: null,
    attributeSchema: obj({
      sku: str('Product SKU'),
      stockOnHand: num('Units on hand'),
      stockInbound: num('Units inbound'),
      unitCost: num('Unit cost'),
      currency: str('ISO 4217'),
      expiryDate: str('ISO date of earliest expiry'),
      ownership: str('own | consignment | distributor'),
    }),
  },
  {
    key: 'Capacity',
    name: 'Capacity Pool',
    description: 'A constrained resource: service engineers, QC, cold-chain, a line.',
    category: 'resource',
    parentKey: null,
    attributeSchema: obj({
      availableMinutesPerWeek: num('Available minutes'),
      resourceCount: int('Number of resources'),
      unit: str('What the capacity is measured in'),
    }),
  },
  {
    key: 'Shipment',
    name: 'Shipment',
    description: 'An in-transit consignment.',
    category: 'operations',
    parentKey: null,
    attributeSchema: obj({
      etaDate: str('ISO date'),
      mode: str('air | sea | road'),
      quantity: num('Units'),
    }),
  },
  {
    key: 'ServiceLevel',
    name: 'Service Level Target',
    description: 'A promised service standard, and the exposure created by missing it.',
    category: 'operations',
    parentKey: null,
    attributeSchema: obj({
      targetPct: pct('0..1'),
      penaltyClause: str('Contractual consequence'),
    }),
  },

  // ----------------------------------------------------------------- finance
  {
    key: 'Cost',
    name: 'Cost Pool',
    description:
      'A grouped cost with a behaviour. `behaviour` is load-bearing: it lets the ' +
      'relevant-cost engine decide relevance mechanically instead of asking a human.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({
      behaviour: {
        type: 'string',
        description: 'Cost behaviour',
        enum: ['variable', 'traceable_fixed', 'allocated_fixed'],
      },
      currency: str('ISO 4217'),
      period: str('YYYY-MM'),
    }),
  },
  {
    key: 'Margin',
    name: 'Margin',
    description: 'A margin measure for a cost object.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({ basis: str('gross | contribution | segment | net') }),
  },
  {
    key: 'WorkingCapital',
    name: 'Working Capital Item',
    description: 'Inventory, receivable or payable position tying up capital.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({
      kind: {
        type: 'string',
        description: 'Working capital kind',
        enum: ['inventory', 'receivable', 'payable'],
      },
      daysOutstanding: num('DIO / DSO / DPO'),
    }),
  },
  {
    key: 'Cash',
    name: 'Cash Position',
    description: 'Cash at a point in time.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({ balance: num('Balance'), currency: str('ISO 4217') }),
  },
  {
    key: 'EBITDA',
    name: 'EBITDA',
    description: 'Earnings before interest, tax, depreciation and amortization.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({ currency: str('ISO 4217'), period: str('YYYY-MM') }),
  },
  {
    key: 'Investment',
    name: 'Investment',
    description: 'Committed capital carrying a return expectation.',
    category: 'finance',
    parentKey: null,
    attributeSchema: obj({
      amount: num('Committed amount'),
      currency: str('ISO 4217'),
      hurdleRate: pct('Required return'),
    }),
  },

  // -------------------------------------------------------------- management
  {
    key: 'Objective',
    name: 'Objective',
    description: 'What management is trying to achieve.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      targetValue: num('Target'),
      targetDate: str('ISO date'),
      unit: str('Unit of the target'),
    }),
  },
  {
    key: 'KPI',
    name: 'KPI',
    description: 'A tracked measure with a target and a threshold.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      metricCode: str('Which metric'),
      target: num('Target value'),
      threshold: num('Alert threshold'),
    }),
  },
  {
    key: 'Constraint',
    name: 'Constraint',
    description: 'A limit management must respect.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      kind: {
        type: 'string',
        description: 'Constraint kind',
        enum: ['policy', 'physical', 'contractual', 'regulatory'],
      },
      limitValue: num('The limit'),
      unit: str('Unit of the limit'),
    }),
  },
  {
    key: 'Assumption',
    name: 'Assumption',
    description: 'An explicit belief an analysis depends on.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      statement: str('What is assumed'),
      basis: str('Why we believe it'),
      sensitivity: {
        type: 'string',
        description: 'How much the conclusion moves with it',
        enum: ['low', 'medium', 'high'],
      },
      validated: {
        type: 'string',
        description: 'Outcome of testing the assumption',
        enum: ['pending', 'held', 'failed'],
      },
    }),
  },
  {
    key: 'Risk',
    name: 'Risk',
    description: 'A potential adverse event with likelihood and impact.',
    category: 'risk',
    parentKey: null,
    attributeSchema: obj({
      likelihood: pct('0..1'),
      impact: num('Impact if it occurs'),
      currency: str('ISO 4217'),
      mitigation: str('Current mitigation'),
    }),
  },
  {
    key: 'Signal',
    name: 'Signal',
    description: 'A detected attention item carrying its rule, threshold and evidence.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      ruleCode: str('Which rule fired'),
      severity: {
        type: 'string',
        description: 'Severity',
        enum: ['info', 'watch', 'warning', 'critical'],
      },
      thresholdLabel: str('What it was judged against'),
      measuredLabel: str('What was measured'),
    }),
  },
  {
    key: 'Issue',
    name: 'Issue',
    description: 'A confirmed problem under management.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({ status: str('open | mitigating | resolved') }),
  },
  {
    key: 'Scenario',
    name: 'Scenario',
    description: 'A modelled alternative world. Overlays reality; never mutates it.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({ kind: str('base | variant') }),
  },
  {
    key: 'Decision',
    name: 'Decision',
    description:
      'A managerial choice with a lifecycle. The relational helm_decisions record ' +
      'remains authoritative for governance; this is its semantic projection.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      decisionType: str('Template used'),
      status: str('Lifecycle state'),
      amountAtStake: num('Value at stake'),
      currency: str('ISO 4217'),
    }),
  },
  {
    key: 'Action',
    name: 'Action',
    description: 'An execution instruction produced by an approved decision.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({ dueDate: str('ISO date'), status: str('open | done | cancelled') }),
  },
  {
    key: 'Outcome',
    name: 'Outcome',
    description: 'What actually happened, against what was expected.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      expected: str('Expected outcome as stated before approval'),
      actual: str('Observed outcome'),
      score: str('better | as_expected | worse | mixed'),
    }),
  },
  {
    key: 'Lesson',
    name: 'Lesson',
    description: 'Generalised learning derived from one or more outcomes.',
    category: 'management',
    parentKey: null,
    attributeSchema: obj({
      statement: str('What the organization should conclude'),
      confidence: pct('0..1'),
    }),
  },

  // ------------------------------------------------------------------- value
  {
    key: 'EnterpriseValue',
    name: 'Enterprise Value',
    description:
      'The terminal node every value chain reaches. Phase 2 attaches value nodes; ' +
      'Phase 1 seeds the concept so the spine has an endpoint.',
    category: 'value',
    parentKey: null,
    attributeSchema: obj({ currency: str('ISO 4217') }),
  },
];

// ===========================================================================
// RELATIONSHIP TYPES
// ===========================================================================

const ORG_LIKE: readonly EntityCategory[] = ['organization'];
const ANY = null;

export const seedRelationshipTypes: readonly SeedRelationshipType[] = [
  // ---------------------------------------------------------------- structural
  {
    key: 'BELONGS_TO',
    name: 'belongs to',
    description: 'Primary hierarchy edge: this sits within that.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: 'CONTAINS',
  },
  {
    key: 'CONTAINS',
    name: 'contains',
    description: 'Inverse of BELONGS_TO, for readable traversal in the other direction.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: 'BELONGS_TO',
  },
  {
    key: 'OWNS',
    name: 'owns',
    description: 'Ownership or stewardship of an asset, portfolio or position.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: 'OWNED_BY',
  },
  {
    key: 'OWNED_BY',
    name: 'owned by',
    description: 'Inverse of OWNS. Used for accountability lookups.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ORG_LIKE,
    inverseKey: 'OWNS',
  },
  {
    key: 'RESPONSIBLE_FOR',
    name: 'responsible for',
    description: 'Management accountability. Attaches to a Role, not a Person.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ORG_LIKE,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'HOLDS_ROLE',
    name: 'holds role',
    description: 'A person occupies a role. Temporal: closed when they move on.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ORG_LIKE,
    targetCategories: ORG_LIKE,
    inverseKey: null,
  },
  {
    key: 'REPORTS_TO',
    name: 'reports to',
    description: 'The authority spine, role to role.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ORG_LIKE,
    targetCategories: ORG_LIKE,
    inverseKey: null,
  },
  {
    key: 'LOCATED_IN',
    name: 'located in',
    description: 'Geographic placement, used for scoping.',
    category: 'structural',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ORG_LIKE,
    inverseKey: null,
  },

  // ---------------------------------------------------------------- commercial
  {
    key: 'SERVES',
    name: 'serves',
    description: 'This unit, team or capacity serves that market, segment or customer.',
    category: 'commercial',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'SELLS',
    name: 'sells',
    description: 'A commercial event or channel moves a product. Weight carries quantity.',
    category: 'commercial',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ['commercial'],
    inverseKey: null,
  },
  {
    key: 'HELD_BY',
    name: 'held by',
    description: 'An opportunity belongs to a customer.',
    category: 'commercial',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['commercial'],
    targetCategories: ['commercial'],
    inverseKey: null,
  },
  {
    key: 'SUPPLIES',
    name: 'supplies',
    description: 'A supplier provides a product. Lag carries lead time.',
    category: 'operational',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['operations'],
    targetCategories: ['commercial'],
    inverseKey: 'SUPPLIED_BY',
  },
  {
    key: 'SUPPLIED_BY',
    name: 'supplied by',
    description: 'Inverse of SUPPLIES — the direction a product-first traversal needs.',
    category: 'operational',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['commercial'],
    targetCategories: ['operations'],
    inverseKey: 'SUPPLIES',
  },
  {
    key: 'STOCKED_AT',
    name: 'stocked at',
    description: 'An inventory position sits at a warehouse or distributor.',
    category: 'operational',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['operations'],
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'POSITIONS',
    name: 'positions',
    description: 'An inventory position is stock *of* this product.',
    category: 'operational',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['operations'],
    targetCategories: ['commercial'],
    inverseKey: null,
  },

  // ------------------------------------------------------------------- value
  {
    key: 'GENERATES',
    name: 'generates',
    description: 'This creates that: an opportunity generates demand or revenue.',
    category: 'commercial',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'CONSUMES',
    name: 'consumes',
    description:
      'This draws on a finite resource. Two CONSUMES edges into one position is how ' +
      'HELM sees contention between competing demands.',
    category: 'operational',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'REQUIRES',
    name: 'requires',
    description: 'This cannot proceed without that.',
    category: 'operational',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'DEPENDS_ON',
    name: 'depends on',
    description: 'A softer dependency than REQUIRES: degraded, not blocked.',
    category: 'operational',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'CONSTRAINS',
    name: 'constrains',
    description: 'A constraint or capacity limits what this can do.',
    category: 'operational',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'AFFECTS',
    name: 'affects',
    description:
      'A declared impact surface — a decision or scenario changes this. NOT a causal ' +
      'assertion: causality is Phase 8 and lives in its own layer.',
    category: 'management',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'CONTRIBUTES_TO',
    name: 'contributes to',
    description: 'The terminal edge of a value chain, usually into EnterpriseValue.',
    category: 'financial',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'CONVERTS_TO',
    name: 'converts to',
    description: 'Working capital becoming cash. Lag carries the conversion period.',
    category: 'financial',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['finance'],
    targetCategories: ['finance'],
    inverseKey: null,
  },
  {
    key: 'INCURS',
    name: 'incurs',
    description: 'This gives rise to a cost.',
    category: 'financial',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ['finance'],
    inverseKey: null,
  },

  // -------------------------------------------------------------- management
  {
    key: 'SUPPORTS',
    name: 'supports',
    description: 'This advances that objective.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'ALIGNS_WITH',
    name: 'aligns with',
    description: 'Strategic consistency without a direct contribution claim.',
    category: 'management',
    isDirected: false,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'EXPOSED_TO',
    name: 'exposed to',
    description: 'This carries exposure to that risk.',
    category: 'management',
    isDirected: true,
    carriesWeight: true,
    sourceCategories: ANY,
    targetCategories: ['risk'],
    inverseKey: null,
  },
  {
    key: 'MITIGATES',
    name: 'mitigates',
    description: 'A decision or action reduces a risk.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['management'],
    targetCategories: ['risk'],
    inverseKey: null,
  },
  {
    key: 'DERIVED_FROM',
    name: 'derived from',
    description: 'A lesson from an outcome, a figure from a source.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'COMPETES_WITH',
    name: 'competes with',
    description:
      'Two demands contend for the same constrained resource. This is the edge that ' +
      'lets HELM price the cost of foreclosing a future option.',
    category: 'commercial',
    isDirected: false,
    carriesWeight: false,
    sourceCategories: ANY,
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'RAISED_BY',
    name: 'raised by',
    description: 'A signal points at what the rule observed.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['management'],
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'RESOLVES',
    name: 'resolves',
    description: 'A decision closes a signal or issue — the attention loop closing.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['management'],
    targetCategories: ['management'],
    inverseKey: null,
  },
  {
    key: 'TRACKS',
    name: 'tracks',
    description: 'A KPI measures this.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['management'],
    targetCategories: ANY,
    inverseKey: null,
  },
  {
    key: 'ASSUMES',
    name: 'assumes',
    description: 'An analysis rests on this assumption.',
    category: 'management',
    isDirected: true,
    carriesWeight: false,
    sourceCategories: ['management'],
    targetCategories: ['management'],
    inverseKey: null,
  },
];

/** Lookup helpers used by the registry loader and the migration generator. */
export const seedEntityTypeKeys = seedEntityTypes.map((t) => t.key);
export const seedRelationshipTypeKeys = seedRelationshipTypes.map((t) => t.key);
