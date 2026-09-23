/**
 * The Decision Kernel: HELM's canonical vocabulary.
 *
 * Everything HELM shows is one of these things or a view of them:
 *
 *   Organization / OrgUnit / Membership — who the tenant is and who may see what.
 *   Signal        — an explainable attention item produced by a deterministic rule.
 *   Decision      — the durable management object: context, alternatives,
 *                   assumptions, governance, expected vs actual outcome, lesson.
 *   Alternative   — an option under a decision, with structured financial lines.
 *   Assumption    — an explicit, reviewable belief the analysis depends on.
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

export const decisionStatuses = [
  'draft',
  'analyzing',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'monitoring',
  'closed',
] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

export const outcomeScores = ['better', 'as_expected', 'worse', 'mixed'] as const;
export type OutcomeScore = (typeof outcomeScores)[number];

export type ExpectedMetric = {
  metric: string;
  expected: string;
  actual?: string;
};

export type Decision = {
  id: string;
  orgId: string;
  orgUnitId: string | null;
  decisionType: DecisionType;
  title: string;
  context: string;
  problem: string;
  objective: string;
  status: DecisionStatus;
  ownerId: string | null;
  ownerLabel?: string;
  dueDate: string | null;
  reviewAfter: string | null;
  currency: string | null;
  amountAtStake: number | null;
  recommendation: string;
  decidedAlternativeId: string | null;
  decisionRationale: string;
  expectedOutcome: string;
  expectedMetrics: ExpectedMetric[];
  actualOutcome: string;
  outcomeScore: OutcomeScore | null;
  lesson: string;
  signalId: string | null;
  memoireAccountId: string | null;
  memoireOpportunityId: string | null;
  /** What the manager saw when deciding — immutable once captured. */
  contextSnapshot: Record<string, unknown> | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * A structured financial line under an alternative. `kind` is what makes the
 * relevant-cost engine explainable: sunk and allocated lines are *shown* but
 * excluded from the incremental result, so the manager sees exactly which
 * numbers were ignored and why.
 */
export const financialLineKinds = [
  'incremental_revenue',
  'relevant_cost',
  'opportunity_cost',
  'sunk_ignored',
  'allocated_ignored',
] as const;
export type FinancialLineKind = (typeof financialLineKinds)[number];

export type FinancialLine = {
  label: string;
  kind: FinancialLineKind;
  amount: number;
  note?: string;
};

export type DecisionAlternative = {
  id: string;
  orgId: string;
  decisionId: string;
  name: string;
  description: string;
  financialLines: FinancialLine[];
  qualitative: string;
  strategic: string;
  risks: string;
  isRecommended: boolean;
  sort: number;
};

export const assumptionSensitivities = ['low', 'medium', 'high'] as const;
export type AssumptionSensitivity = (typeof assumptionSensitivities)[number];

export const assumptionValidations = ['pending', 'held', 'failed'] as const;
export type AssumptionValidation = (typeof assumptionValidations)[number];

export type DecisionAssumption = {
  id: string;
  orgId: string;
  decisionId: string;
  statement: string;
  basis: string;
  sensitivity: AssumptionSensitivity;
  validated: AssumptionValidation;
};

export type DecisionEvent = {
  id: string;
  orgId: string;
  decisionId: string;
  eventType: string;
  actorId: string;
  actorLabel?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export const actionStatuses = ['open', 'done', 'cancelled'] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export type DecisionAction = {
  id: string;
  orgId: string;
  decisionId: string;
  title: string;
  ownerLabel: string;
  ownerId: string | null;
  dueDate: string | null;
  status: ActionStatus;
  writeback: Record<string, unknown> | null;
};

export type ApprovalRule = {
  id: string;
  orgId: string;
  decisionType: DecisionType | null;
  thresholdAmount: number;
  requiredRole: 'manager' | 'admin';
  active: boolean;
};

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

export const decisionStatusLabels: Record<DecisionStatus, string> = {
  draft: 'Draft',
  analyzing: 'Analyzing',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  executing: 'Executing',
  monitoring: 'Monitoring',
  closed: 'Closed',
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
