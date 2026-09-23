import type {
  CostObject,
  EconomicsRow,
  InventoryItem,
  OrgUnit,
  Process,
  ProcessActivity,
  Signal,
} from '../domain/types.ts';

/** snake_case DB rows ↔ camelCase domain objects. One direction per shape;
 * writes construct row objects explicitly at the call site. */

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sn = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' ? v : v === null || v === undefined ? 0 : Number(v));
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown) => Boolean(v);

export function mapSignal(r: Row): Signal {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    ruleCode: s(r.rule_code),
    dedupeKey: s(r.dedupe_key),
    severity: s(r.severity) as Signal['severity'],
    title: s(r.title),
    reason: s(r.reason),
    thresholdLabel: s(r.threshold_label),
    measuredLabel: s(r.measured_label),
    evidence: Array.isArray(r.evidence) ? (r.evidence as Signal['evidence']) : [],
    entityKind: sn(r.entity_kind),
    entityId: sn(r.entity_id),
    status: s(r.status) as Signal['status'],
    decisionId: sn(r.decision_id),
    detectedAt: s(r.detected_at),
  };
}

export function mapCostObject(r: Row): CostObject {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    parentId: sn(r.parent_id),
    orgUnitId: sn(r.org_unit_id),
    kind: s(r.kind) as CostObject['kind'],
    name: s(r.name),
    memoireAccountId: sn(r.memoire_account_id),
    active: b(r.active),
  };
}

export function mapEconomics(r: Row): EconomicsRow {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    costObjectId: s(r.cost_object_id),
    period: s(r.period),
    kind: s(r.kind) as EconomicsRow['kind'],
    revenue: n(r.revenue),
    variableCost: n(r.variable_cost),
    traceableFixedCost: n(r.traceable_fixed_cost),
    allocatedFixedCost: n(r.allocated_fixed_cost),
    units: nn(r.units),
  };
}

export function mapInventoryItem(r: Row): InventoryItem {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    costObjectId: sn(r.cost_object_id),
    sku: s(r.sku),
    name: s(r.name),
    unitCost: n(r.unit_cost),
    unitPrice: n(r.unit_price),
    avgDailyDemand: n(r.avg_daily_demand),
    demandStddev: n(r.demand_stddev),
    leadTimeDays: n(r.lead_time_days),
    stockOnHand: n(r.stock_on_hand),
    stockInbound: n(r.stock_inbound),
    expiryDate: sn(r.expiry_date),
    shelfLifeDays: nn(r.shelf_life_days) as number | null,
    serviceLevel: nn(r.service_level),
    orderCost: nn(r.order_cost),
    holdingCostRate: nn(r.holding_cost_rate),
  };
}

export function mapProcess(r: Row): Process {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    name: s(r.name),
    description: s(r.description),
    demandPerWeek: n(r.demand_per_week),
  };
}

export function mapProcessActivity(r: Row): ProcessActivity {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    processId: s(r.process_id),
    name: s(r.name),
    ownerLabel: s(r.owner_label),
    processingMinutes: n(r.processing_minutes),
    resourcesCount: n(r.resources_count),
    availableMinutesPerWeek: n(r.available_minutes_per_week),
    waitMinutes: n(r.wait_minutes),
    sort: n(r.sort),
  };
}

export function mapOrgUnit(r: Row): OrgUnit {
  return {
    id: s(r.id),
    orgId: s(r.org_id),
    parentId: sn(r.parent_id),
    name: s(r.name),
    unitType: s(r.unit_type) as OrgUnit['unitType'],
  };
}
