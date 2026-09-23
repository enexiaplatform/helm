/**
 * The Decision Kernel: HELM's canonical vocabulary.
 *
 * Everything HELM shows is one of these things or a view of them:
 *
 *   Organization / OrgUnit / Membership — who the tenant is and who may see what.
 *   Signal        — an explainable attention item produced by a deterministic rule.
 *   Decision      — now a kernel object (@helm/decision-runtime): one management
 *                   question, its alternatives bound to scenario futures, the
 *                   criteria, evidence and assumptions behind them, and the
 *                   commitment management made. The pre-kernel Decision record
 *                   was retired in Phase 5.
 *   CostObject    — a profitability lens (company, unit, brand, product, customer…).
 *   EconomicsRow  — one period of economics for a cost object.
 *   InventoryItem — inventory viewed as capital, risk, and service level.
 *   Process       — a managerial process map for capacity/bottleneck diagnosis.
 *   Action        — an execution instruction produced by an approved decision.
 *
 * No page invents its own meaning for these concepts, and no state transition
 * happens outside `decisionStates.ts` commands.
 */

// ------------------------------------------------------------------ tenancy

export const orgRoles = ['admin', 'manager', 'member', 'viewer'] as const;
export type OrgRole = (typeof orgRoles)[number];

export const orgRoleRank: Record<OrgRole, number> = {
  admin: 4,
  manager: 3,
  member: 2,
  viewer: 1,
};

export type Organization = {
  id: string;
  name: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  role: OrgRole;
};

export const orgUnitTypes = [
  'company',
  'business_unit',
  'division',
  'department',
  'region',
  'country',
  'territory',
  'team',
] as const;
export type OrgUnitType = (typeof orgUnitTypes)[number];

export type OrgUnit = {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  unitType: OrgUnitType;
};

export type OrgMember = {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
};

// ------------------------------------------------------------------ signals

export const signalSeverities = ['info', 'watch', 'warning', 'critical'] as const;
export type SignalSeverity = (typeof signalSeverities)[number];

export const signalStatuses = ['open', 'acknowledged', 'converted', 'dismissed'] as const;
export type SignalStatus = (typeof signalStatuses)[number];

export type SignalEvidence = {
  label: string;
  value: string;
};

/**
 * Every signal is explainable by construction: the rule that fired, the
 * threshold it was judged against, what was measured, and the evidence rows a
 * manager can check. Rules never write — conversion to a decision is a human
 * act.
 */
export type Signal = {
  id: string;
  orgId: string;
  ruleCode: string;
  dedupeKey: string;
  severity: SignalSeverity;
  title: string;
  reason: string;
  thresholdLabel: string;
  measuredLabel: string;
  evidence: SignalEvidence[];
  entityKind: string | null;
  entityId: string | null;
  status: SignalStatus;
  decisionId: string | null;
  detectedAt: string;
  /** Suggested decision template when converting this signal. */
  suggestedDecisionType?: DecisionType;
};

// ---------------------------------------------------------------- decisions

export const decisionTypes = [
  'pricing',
  'special_order',
  'make_or_buy',
  'keep_or_drop',
  'hire_or_outsource',
  'replace_or_retain',
  'investment',
  'inventory_commitment',
  'resource_allocation',
  'market_entry_exit',
  'custom',
] as const;
export type DecisionType = (typeof decisionTypes)[number];

// ---------------------------------------------------------------- economics

export const costObjectKinds = [
  'company',
  'business_unit',
  'brand',
  'product',
  'customer',
  'channel',
  'territory',
  'project',
] as const;
export type CostObjectKind = (typeof costObjectKinds)[number];

export type CostObject = {
  id: string;
  orgId: string;
  parentId: string | null;
  orgUnitId: string | null;
  kind: CostObjectKind;
  name: string;
  memoireAccountId: string | null;
  active: boolean;
};

export const economicsKinds = ['actual', 'budget', 'forecast'] as const;
export type EconomicsKind = (typeof economicsKinds)[number];

export type EconomicsRow = {
  id: string;
  orgId: string;
  costObjectId: string;
  period: string; // YYYY-MM
  kind: EconomicsKind;
  revenue: number;
  variableCost: number;
  traceableFixedCost: number;
  allocatedFixedCost: number;
  units: number | null;
};

// ---------------------------------------------------------------- inventory

export type InventoryItem = {
  id: string;
  orgId: string;
  costObjectId: string | null;
  sku: string;
  name: string;
  unitCost: number;
  unitPrice: number;
  avgDailyDemand: number;
  demandStddev: number;
  leadTimeDays: number;
  stockOnHand: number;
  stockInbound: number;
  expiryDate: string | null;
  shelfLifeDays: number | null;
  serviceLevel: number | null;
  orderCost: number | null;
  holdingCostRate: number | null;
};

// ---------------------------------------------------------------- processes

export type Process = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  demandPerWeek: number;
};

export type ProcessActivity = {
  id: string;
  orgId: string;
  processId: string;
  name: string;
  ownerLabel: string;
  processingMinutes: number;
  resourcesCount: number;
  availableMinutesPerWeek: number;
  waitMinutes: number;
  sort: number;
};

// ------------------------------------------------------------------- labels

export const decisionTypeLabels: Record<DecisionType, string> = {
  pricing: 'Pricing',
  special_order: 'Special order',
  make_or_buy: 'Make vs buy',
  keep_or_drop: 'Keep vs drop',
  hire_or_outsource: 'Hire vs outsource',
  replace_or_retain: 'Replace vs retain',
  investment: 'Investment',
  inventory_commitment: 'Inventory commitment',
  resource_allocation: 'Resource allocation',
  market_entry_exit: 'Market entry / exit',
  custom: 'Custom decision',
};

export const costObjectKindLabels: Record<CostObjectKind, string> = {
  company: 'Company',
  business_unit: 'Business unit',
  brand: 'Brand',
  product: 'Product',
  customer: 'Customer',
  channel: 'Channel',
  territory: 'Territory',
  project: 'Project',
};
