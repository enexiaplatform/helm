/**
 * Value Graph types — how enterprise entities participate in value.
 *
 * The ontology holds nouns; this holds quantities. See ADR-0015.
 *
 * Nothing here computes. A value link records that one quantity depends on
 * another; it does not evaluate anything. Propagation is Phase 3.
 */

import type {
  Confidence,
  EntityId,
  OrgId,
  ProvenanceId,
  RecordTime,
  SourceSystem,
  UserId,
  ValidTime,
} from '@helm/shared';

// ------------------------------------------------------------- dimensions

/**
 * Enterprise value is multi-dimensional. These dimensions reinforce, compete
 * with and constrain each other — higher inventory raises service level AND
 * working capital. HELM must be able to see both, so it must never collapse
 * them into one number (see ADR-0015 and the phase brief §31).
 *
 * Fixed in code because kernel logic branches on them; the *metrics* inside
 * each dimension are open, registry-backed data.
 */
export const valueDimensions = [
  'FINANCIAL',
  'COMMERCIAL',
  'CUSTOMER',
  'OPERATIONAL',
  'CAPITAL',
  'RISK',
  'STRATEGIC',
  'RESOURCE',
  'RESILIENCE',
] as const;
export type ValueDimension = (typeof valueDimensions)[number];

// ------------------------------------------------------------------ units

/**
 * Business-relevant unit types. Deliberately not a physical-units library.
 *
 * `percentage` and `ratio` are separate on purpose: 38% and 0.38 are the same
 * proportion written two ways, and silently mixing them is exactly the class of
 * error the phase brief §9 calls out. A `percentage` value is 0–100; a `ratio`
 * value is 0–1. Both are enforced.
 */
export const unitTypes = [
  'currency',
  'percentage', // 0..100
  'ratio', // 0..1
  'units',
  'count',
  'days',
  'hours',
  'capacity',
  'score', // bounded qualitative index, 0..100
  'index', // unbounded relative index, 100 = baseline
] as const;
export type UnitType = (typeof unitTypes)[number];

/** Unit types whose observations require an explicit currency. */
export const currencyBearingUnits: readonly UnitType[] = ['currency'];

/** Bounds enforced per unit type. null = unbounded. */
export const unitBounds: Record<UnitType, { min: number | null; max: number | null }> = {
  currency: { min: null, max: null },
  percentage: { min: 0, max: 100 },
  ratio: { min: 0, max: 1 },
  units: { min: null, max: null },
  count: { min: 0, max: null },
  days: { min: null, max: null },
  hours: { min: null, max: null },
  capacity: { min: 0, max: null },
  score: { min: 0, max: 100 },
  index: { min: 0, max: null },
};

// ------------------------------------------------------- metric semantics

/**
 * How a metric may be rolled up. Revenue sums; gross margin percentage does
 * not. Encoding this now means a future aggregation engine cannot silently do
 * the wrong thing — the semantics are data, not folklore.
 */
export const aggregationBehaviors = [
  'SUM',
  'AVERAGE',
  'WEIGHTED_AVERAGE',
  'MIN',
  'MAX',
  'LAST',
  'NON_AGGREGATABLE',
  'CUSTOM',
] as const;
export type AggregationBehavior = (typeof aggregationBehaviors)[number];

/** Which direction is "good". Needed later for trade-off reasoning, not scoring. */
export const directionalities = [
  'HIGHER_IS_BETTER',
  'LOWER_IS_BETTER',
  'TARGET_RANGE',
  'NEUTRAL',
  'CONTEXT_DEPENDENT',
] as const;
export type Directionality = (typeof directionalities)[number];

/** How the metric relates to time — determines which observation fields apply. */
export const timeBehaviors = [
  'POINT_IN_TIME', // a stock: inventory on hand, cash balance
  'PERIOD', // a flow over an interval: revenue in October
  'CUMULATIVE', // running total to date
  'RATE', // per unit time
] as const;
export type TimeBehavior = (typeof timeBehaviors)[number];

/** What kind of value the observation carries. Quantitative first, extensible. */
export const valueDataTypes = ['numeric', 'ordinal', 'categorical'] as const;
export type ValueDataType = (typeof valueDataTypes)[number];

export const metricStatuses = ['draft', 'active', 'deprecated'] as const;
export type MetricStatus = (typeof metricStatuses)[number];

/**
 * The meaning of a metric, expressed so a machine can reason about it.
 *
 * A definition that is only `{ name: 'Gross Margin' }` is useless to an agent.
 * Every field below exists because some later phase needs to ask a question of
 * it: can I sum this? is more of it better? does it need a currency? what
 * kind of entity can it attach to?
 */
export type ValueMetricDefinition = {
  id: string;
  /** null = shipped by HELM, available to every organization. */
  orgId: OrgId | null;
  key: string;
  name: string;
  description: string;
  dimension: ValueDimension;
  unitType: UnitType;
  /** Default currency for currency-typed metrics; the observation may override. */
  defaultCurrency: string | null;
  dataType: ValueDataType;
  aggregation: AggregationBehavior;
  directionality: Directionality;
  timeBehavior: TimeBehavior;
  /**
   * Entity-type categories this metric may attach to. null = unconstrained.
   * Stops "Gross Margin" being attached to a Person.
   */
  scopeCategories: readonly string[] | null;
  version: number;
  status: MetricStatus;
  isSystem: boolean;
  metadata: Readonly<Record<string, unknown>>;
};

// ------------------------------------------------------------ value nodes

/**
 * Where a value node sits when it is not attached to a single entity.
 * "Working capital for Vietnam" is scoped, not entity-bound.
 */
export const valueScopeKinds = [
  'enterprise',
  'region',
  'country',
  'business_unit',
  'function',
  'customer',
  'portfolio',
  'product',
  'opportunity',
  'supplier',
  'resource',
] as const;
export type ValueScopeKind = (typeof valueScopeKinds)[number];

export const timeHorizons = ['current', 'month', 'quarter', 'year', 'lifetime'] as const;
export type TimeHorizon = (typeof timeHorizons)[number];

/**
 * A management-relevant value state: one metric, about one subject, at one
 * horizon. One entity participates in many value nodes — SKU-X has a revenue
 * contribution, a gross margin, an inventory exposure, a working-capital draw,
 * a supply risk and a service impact, and they are six different nodes.
 */
export type ValueNode = {
  id: string;
  orgId: OrgId;
  metricId: string;
  /** Denormalised for readability; always matches metricId. */
  metricKey: string;
  /** The ontology entity this is about. Referenced, never duplicated. */
  subjectEntityId: EntityId | null;
  /** Used when the node is scoped rather than entity-bound. */
  scopeKind: ValueScopeKind | null;
  scopeRef: string | null;
  timeHorizon: TimeHorizon | null;
  label: string;
  metadata: Readonly<Record<string, unknown>>;
  createdBy: UserId | null;
  createdAt: RecordTime;
  updatedAt: RecordTime;
};

export type ValueNodeInput = {
  metricKey: string;
  subjectEntityId?: EntityId | null;
  scopeKind?: ValueScopeKind | null;
  scopeRef?: string | null;
  timeHorizon?: TimeHorizon | null;
  label?: string;
  metadata?: Record<string, unknown>;
  createdBy?: UserId | null;
};

// ------------------------------------------------------------ value links

/**
 * How one quantity depends on another.
 *
 * `CAUSES` is deliberately absent. A value link is a management/value
 * dependency, not a validated causal claim — the Causal Graph is Phase 8, and
 * keeping the vocabularies apart is what preserves the distinction.
 */
export const valueLinkTypes = [
  'DRIVES',
  'CONTRIBUTES_TO',
  'CONSUMES',
  'ENABLES',
  'CONSTRAINS',
  'REDUCES',
  'INCREASES',
  'EXPOSES',
  'PROTECTS',
  'DEPENDS_ON',
  'ALLOCATES_TO',
  'TRANSFERS_TO',
] as const;
export type ValueLinkType = (typeof valueLinkTypes)[number];

/**
 * Link types whose effect on the target runs opposite to the source's movement.
 * Recorded as semantics only — nothing applies a sign in Phase 2.
 */
export const invertingLinkTypes: readonly ValueLinkType[] = ['REDUCES', 'CONSUMES'];

export type ValueLink = {
  id: string;
  orgId: OrgId;
  linkType: ValueLinkType;
  sourceNodeId: string;
  targetNodeId: string;
  weight: number | null;
  confidence: Confidence | null;
  lagDays: number | null;
  validFrom: ValidTime;
  validTo: ValidTime | null;
  observedAt: ValidTime | null;
  ingestedAt: RecordTime;
  updatedAt: RecordTime;
  sourceSystem: SourceSystem;
  metadata: Readonly<Record<string, unknown>>;
  createdBy: UserId | null;
};

export type ValueLinkInput = {
  linkType: ValueLinkType;
  sourceNodeId: string;
  targetNodeId: string;
  weight?: number | null;
  confidence?: Confidence | null;
  lagDays?: number | null;
  validFrom?: ValidTime;
  validTo?: ValidTime | null;
  observedAt?: ValidTime | null;
  sourceSystem: SourceSystem;
  metadata?: Record<string, unknown>;
  createdBy?: UserId | null;
};

// ----------------------------------------------------------- observations

/**
 * What kind of claim an observation is. These are NOT interchangeable and must
 * never be collapsed:
 *
 *   ACTUAL      what happened
 *   FORECAST    what we expect to happen
 *   TARGET      what we want to happen
 *   SCENARIO    what would happen under a modelled alternative
 *   ESTIMATE    a best guess where no measurement exists
 *   DERIVED     computed from other observations (Phase 3 writes these)
 *   ASSUMPTION  a value a manager asserted as an input
 *
 * Keeping them apart is what later powers scenario comparison, the digital
 * twin, forecast-accuracy learning and counterfactual analysis. A system that
 * cannot tell a target from an actual cannot learn whether it was wrong.
 */
export const observationTypes = [
  'ACTUAL',
  'FORECAST',
  'TARGET',
  'SCENARIO',
  'ESTIMATE',
  'DERIVED',
  'ASSUMPTION',
] as const;
export type ObservationType = (typeof observationTypes)[number];

export type ValueObservation = {
  id: string;
  orgId: OrgId;
  nodeId: string;
  observationType: ObservationType;
  /** One of numericValue / textValue is always set; numeric is the common case. */
  numericValue: number | null;
  textValue: string | null;
  unitType: UnitType;
  currency: string | null;

  /** POINT_IN_TIME metrics anchor here. */
  effectiveAt: ValidTime | null;
  /** PERIOD / CUMULATIVE metrics use the interval. */
  periodStart: ValidTime | null;
  periodEnd: ValidTime | null;

  /** Valid time: when the source asserted it. */
  observedAt: ValidTime | null;
  /** Record time: when HELM learned it. */
  recordedAt: RecordTime;

  /** Required when observationType is SCENARIO; an ontology Scenario entity. */
  scenarioEntityId: EntityId | null;
  /** For ASSUMPTION observations: the Assumption entity it rests on. */
  assumptionEntityId: EntityId | null;

  confidence: Confidence | null;
  sourceSystem: SourceSystem;
  /** Lineage hook. Phase 3 attaches calculation traces through provenance. */
  provenanceId: ProvenanceId | null;
  /** Reserved for Phase 3; always null here. */
  calculationRunId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdBy: UserId | null;
};

export type ValueObservationInput = {
  nodeId: string;
  observationType: ObservationType;
  numericValue?: number | null;
  textValue?: string | null;
  unitType?: UnitType;
  currency?: string | null;
  effectiveAt?: ValidTime | null;
  periodStart?: ValidTime | null;
  periodEnd?: ValidTime | null;
  observedAt?: ValidTime | null;
  scenarioEntityId?: EntityId | null;
  assumptionEntityId?: EntityId | null;
  confidence?: Confidence | null;
  sourceSystem: SourceSystem;
  provenanceId?: ProvenanceId | null;
  metadata?: Record<string, unknown>;
  createdBy?: UserId | null;
};
