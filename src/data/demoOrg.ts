import type {
  ApprovalRule,
  CostObject,
  Decision,
  DecisionAction,
  DecisionAlternative,
  DecisionAssumption,
  DecisionEvent,
  EconomicsRow,
  InventoryItem,
  OrgMember,
  OrgUnit,
  Organization,
  Process,
  ProcessActivity,
} from '../domain/types.ts';

/**
 * The demo organization: Meridian Life Sciences Vietnam, a B2B life-science
 * and food-ingredient distributor. Deterministic, in-memory, and never synced
 * to the cloud (the ecosystem's sample-data rule).
 *
 * The dataset stages real managerial situations:
 *   - Bidiphar (key pharma account) requesting a 12% discount on a 450M deal
 *   - VitaPlex Premix looking unprofitable only because of allocated overhead
 *   - the LegacyDye D40 line with a genuinely negative segment margin
 *   - the installation team past capacity (bottleneck at Installation)
 *   - PMM Reagent Kits below reorder point while the Bidiphar deal needs them
 *   - VitaPlex stock at expiry risk
 *   - F&B revenue behind budget in the latest month
 *   - a closed-decision history that shows systematic forecast optimism
 */

export const DEMO_ORG_ID = 'demo-org';
export const DEMO_USER_ID = 'demo-user';

export const demoOrganization: Organization = {
  id: DEMO_ORG_ID,
  name: 'Meridian Life Sciences Vietnam',
  baseCurrency: 'VND',
  fiscalYearStartMonth: 1,
  role: 'admin',
};

export const demoMembers: OrgMember[] = [
  { userId: DEMO_USER_ID, email: 'you@meridian.example', displayName: 'You — Country Manager', role: 'admin' },
  { userId: 'demo-lan', email: 'lan.pham@meridian.example', displayName: 'Lan Pham — Pharma Sales Manager', role: 'manager' },
  { userId: 'demo-minh', email: 'minh.tran@meridian.example', displayName: 'Minh Tran — Technical Service Lead', role: 'manager' },
  { userId: 'demo-thu', email: 'thu.nguyen@meridian.example', displayName: 'Thu Nguyen — Finance', role: 'member' },
];

export const demoUnits: OrgUnit[] = [
  { id: 'unit-vn', orgId: DEMO_ORG_ID, parentId: null, name: 'Vietnam', unitType: 'country' },
  { id: 'unit-pharma', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Pharma Sales', unitType: 'team' },
  { id: 'unit-fnb', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'F&B Ingredients Sales', unitType: 'team' },
  { id: 'unit-service', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Technical Service', unitType: 'team' },
  { id: 'unit-ops', orgId: DEMO_ORG_ID, parentId: 'unit-vn', name: 'Operations', unitType: 'department' },
];

// ------------------------------------------------------------- cost objects

export const demoCostObjects: CostObject[] = [
  { id: 'co-company', orgId: DEMO_ORG_ID, parentId: null, orgUnitId: 'unit-vn', kind: 'company', name: 'Meridian Vietnam', memoireAccountId: null, active: true },
  { id: 'co-pharma', orgId: DEMO_ORG_ID, parentId: 'co-company', orgUnitId: 'unit-pharma', kind: 'business_unit', name: 'Pharma Distribution', memoireAccountId: null, active: true },
  { id: 'co-fnb', orgId: DEMO_ORG_ID, parentId: 'co-company', orgUnitId: 'unit-fnb', kind: 'business_unit', name: 'F&B Ingredients', memoireAccountId: null, active: true },
  { id: 'co-service', orgId: DEMO_ORG_ID, parentId: 'co-company', orgUnitId: 'unit-service', kind: 'business_unit', name: 'Technical Service', memoireAccountId: null, active: true },
  { id: 'co-pmm', orgId: DEMO_ORG_ID, parentId: 'co-pharma', orgUnitId: null, kind: 'product', name: 'PMM Reagent Kit', memoireAccountId: null, active: true },
  { id: 'co-vitaplex', orgId: DEMO_ORG_ID, parentId: 'co-fnb', orgUnitId: null, kind: 'product', name: 'VitaPlex Premix', memoireAccountId: null, active: true },
  { id: 'co-legacydye', orgId: DEMO_ORG_ID, parentId: 'co-fnb', orgUnitId: null, kind: 'product', name: 'LegacyDye D40', memoireAccountId: null, active: true },
  { id: 'co-bidiphar', orgId: DEMO_ORG_ID, parentId: 'co-pharma', orgUnitId: null, kind: 'customer', name: 'Bidiphar', memoireAccountId: null, active: true },
  { id: 'co-acecook', orgId: DEMO_ORG_ID, parentId: 'co-fnb', orgUnitId: null, kind: 'customer', name: 'Acecook Vietnam', memoireAccountId: null, active: true },
];

// ---------------------------------------------------------------- economics
// Six months of actuals (Feb–Jul 2026) plus budgets. Figures in VND.

const M = 1_000_000;

type EconSeed = [costObjectId: string, period: string, kind: EconomicsRow['kind'], revenue: number, variableCost: number, traceable: number, allocated: number, units: number | null];

const econSeeds: EconSeed[] = [
  // Pharma Distribution BU — healthy, slightly ahead of budget.
  ['co-pharma', '2026-05', 'actual', 2380 * M, 1500 * M, 420 * M, 260 * M, null],
  ['co-pharma', '2026-06', 'actual', 2455 * M, 1540 * M, 420 * M, 260 * M, null],
  ['co-pharma', '2026-07', 'actual', 2510 * M, 1570 * M, 425 * M, 265 * M, null],
  ['co-pharma', '2026-05', 'budget', 2300 * M, 1470 * M, 420 * M, 260 * M, null],
  ['co-pharma', '2026-06', 'budget', 2350 * M, 1490 * M, 420 * M, 260 * M, null],
  ['co-pharma', '2026-07', 'budget', 2400 * M, 1515 * M, 425 * M, 265 * M, null],

  // F&B Ingredients BU — behind budget in July (−12.4%): BUD-VAR fires.
  ['co-fnb', '2026-05', 'actual', 1610 * M, 1130 * M, 300 * M, 190 * M, null],
  ['co-fnb', '2026-06', 'actual', 1545 * M, 1090 * M, 300 * M, 190 * M, null],
  ['co-fnb', '2026-07', 'actual', 1402 * M, 995 * M, 305 * M, 195 * M, null],
  ['co-fnb', '2026-05', 'budget', 1600 * M, 1120 * M, 300 * M, 190 * M, null],
  ['co-fnb', '2026-06', 'budget', 1620 * M, 1130 * M, 300 * M, 190 * M, null],
  ['co-fnb', '2026-07', 'budget', 1600 * M, 1120 * M, 305 * M, 195 * M, null],

  // Technical Service BU — small, stable, on budget.
  ['co-service', '2026-05', 'actual', 520 * M, 210 * M, 220 * M, 70 * M, null],
  ['co-service', '2026-06', 'actual', 540 * M, 215 * M, 220 * M, 70 * M, null],
  ['co-service', '2026-07', 'actual', 555 * M, 220 * M, 225 * M, 72 * M, null],
  ['co-service', '2026-07', 'budget', 545 * M, 218 * M, 225 * M, 72 * M, null],

  // VitaPlex Premix — the allocation trap: positive segment margin
  // (CM 165 − traceable 90 = +75/mo) turned into a paper loss by 110/mo of
  // allocated corporate overhead.
  ['co-vitaplex', '2026-05', 'actual', 540 * M, 380 * M, 90 * M, 110 * M, 13500],
  ['co-vitaplex', '2026-06', 'actual', 520 * M, 362 * M, 90 * M, 110 * M, 13000],
  ['co-vitaplex', '2026-07', 'actual', 505 * M, 348 * M, 92 * M, 112 * M, 12600],

  // LegacyDye D40 — genuinely negative segment margin: real problem.
  ['co-legacydye', '2026-05', 'actual', 120 * M, 96 * M, 38 * M, 15 * M, 2400],
  ['co-legacydye', '2026-06', 'actual', 112 * M, 92 * M, 38 * M, 15 * M, 2240],
  ['co-legacydye', '2026-07', 'actual', 104 * M, 88 * M, 38 * M, 15 * M, 2080],

  // PMM Reagent Kit — strong product economics behind the Bidiphar deal.
  ['co-pmm', '2026-05', 'actual', 880 * M, 495 * M, 120 * M, 95 * M, 320],
  ['co-pmm', '2026-06', 'actual', 905 * M, 508 * M, 120 * M, 95 * M, 329],
  ['co-pmm', '2026-07', 'actual', 930 * M, 522 * M, 122 * M, 96 * M, 338],

  // Customers.
  ['co-bidiphar', '2026-06', 'actual', 415 * M, 250 * M, 45 * M, 30 * M, null],
  ['co-bidiphar', '2026-07', 'actual', 430 * M, 258 * M, 45 * M, 30 * M, null],
  ['co-acecook', '2026-06', 'actual', 380 * M, 270 * M, 40 * M, 28 * M, null],
  ['co-acecook', '2026-07', 'actual', 348 * M, 250 * M, 40 * M, 28 * M, null],
];

export const demoEconomics: EconomicsRow[] = econSeeds.map(
  ([costObjectId, period, kind, revenue, variableCost, traceableFixedCost, allocatedFixedCost, units], i) => ({
    id: `econ-${i}`,
    orgId: DEMO_ORG_ID,
    costObjectId,
    period,
    kind,
    revenue,
    variableCost,
    traceableFixedCost,
    allocatedFixedCost,
    units,
  }),
);

// ---------------------------------------------------------------- inventory

export const demoInventory: InventoryItem[] = [
  {
    // Below reorder point → INV-STOCKOUT (critical). Demand ~11/day, LT 21
    // days → ROP ≈ 231 + SS ≈ 47; on hand + inbound = 150.
    id: 'inv-pmm',
    orgId: DEMO_ORG_ID,
    costObjectId: 'co-pmm',
    sku: 'PMM-250',
    name: 'PMM Reagent Kit',
    unitCost: 2_750_000,
    unitPrice: 4_100_000,
    avgDailyDemand: 11,
    demandStddev: 6,
    leadTimeDays: 21,
    stockOnHand: 90,
    stockInbound: 60,
    expiryDate: null,
    shelfLifeDays: 540,
    serviceLevel: null,
    orderCost: 8_500_000,
    holdingCostRate: 0.18,
    },
  {
    // Expiry exposure: 60 days to expiry × 45/day = 2,700 sellable; 4,100 on
    // hand → ~1,400 units (≈176M VND) at risk.
    id: 'inv-vitaplex',
    orgId: DEMO_ORG_ID,
    costObjectId: 'co-vitaplex',
    sku: 'VPX-20',
    name: 'VitaPlex Premix 20kg',
    unitCost: 126_000,
    unitPrice: 208_000,
    avgDailyDemand: 45,
    demandStddev: 18,
    leadTimeDays: 35,
    stockOnHand: 4_100,
    stockInbound: 0,
    expiryDate: '2026-10-07',
    shelfLifeDays: 270,
    serviceLevel: null,
    orderCost: 12_000_000,
    holdingCostRate: 0.22,
  },
  {
    id: 'inv-plates',
    orgId: DEMO_ORG_ID,
    costObjectId: null,
    sku: 'BAP-96',
    name: 'BioAssay Plates 96w',
    unitCost: 310_000,
    unitPrice: 520_000,
    avgDailyDemand: 28,
    demandStddev: 8,
    leadTimeDays: 12,
    stockOnHand: 1_150,
    stockInbound: 400,
    expiryDate: null,
    shelfLifeDays: null,
    serviceLevel: null,
    orderCost: 4_000_000,
    holdingCostRate: 0.15,
  },
];

/** Working-capital snapshot for the operations view (annualized, VND). */
export const demoWorkingCapital = {
  annualRevenue: 53_000 * M,
  annualCogs: 35_500 * M,
  inventoryValue: 6_200 * M,
  receivables: 8_900 * M,
  payables: 4_300 * M,
};

// ---------------------------------------------------------------- processes

export const demoProcesses: Process[] = [
  {
    id: 'proc-install',
    orgId: DEMO_ORG_ID,
    name: 'Instrument installation & commissioning',
    description: 'From signed order to a validated instrument at the customer site.',
    demandPerWeek: 20,
  },
  {
    id: 'proc-quote',
    orgId: DEMO_ORG_ID,
    name: 'Quotation turnaround',
    description: 'From qualified request to a sent quotation.',
    demandPerWeek: 45,
  },
];

export const demoProcessActivities: ProcessActivity[] = [
  { id: 'act-survey', orgId: DEMO_ORG_ID, processId: 'proc-install', name: 'Site survey', ownerLabel: 'Technical Service', processingMinutes: 60, resourcesCount: 1, availableMinutesPerWeek: 2400, waitMinutes: 480, sort: 0 },
  { id: 'act-install', orgId: DEMO_ORG_ID, processId: 'proc-install', name: 'Installation', ownerLabel: 'Technical Service', processingMinutes: 150, resourcesCount: 1, availableMinutesPerWeek: 2400, waitMinutes: 2880, sort: 1 },
  { id: 'act-calibrate', orgId: DEMO_ORG_ID, processId: 'proc-install', name: 'Calibration & handover', ownerLabel: 'Technical Service', processingMinutes: 80, resourcesCount: 1, availableMinutesPerWeek: 2400, waitMinutes: 720, sort: 2 },
  { id: 'act-spec', orgId: DEMO_ORG_ID, processId: 'proc-quote', name: 'Specification review', ownerLabel: 'Pharma Sales', processingMinutes: 35, resourcesCount: 2, availableMinutesPerWeek: 1200, waitMinutes: 240, sort: 0 },
  { id: 'act-price', orgId: DEMO_ORG_ID, processId: 'proc-quote', name: 'Pricing & approval', ownerLabel: 'Finance', processingMinutes: 25, resourcesCount: 1, availableMinutesPerWeek: 2000, waitMinutes: 960, sort: 1 },
];

// ----------------------------------------------------------- approval rules

export const demoApprovalRules: ApprovalRule[] = [
  { id: 'rule-any', orgId: DEMO_ORG_ID, decisionType: null, thresholdAmount: 500 * M, requiredRole: 'manager', active: true },
  { id: 'rule-pricing', orgId: DEMO_ORG_ID, decisionType: 'pricing', thresholdAmount: 200 * M, requiredRole: 'manager', active: true },
  { id: 'rule-invest', orgId: DEMO_ORG_ID, decisionType: 'investment', thresholdAmount: 0, requiredRole: 'admin', active: true },
];

// ---------------------------------------------------------------- decisions

const now = '2026-08-08T08:00:00.000Z';

export const demoDecisions: Decision[] = [
  {
    id: 'dec-bidiphar',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-pharma',
    decisionType: 'pricing',
    title: 'Bidiphar PMM order — 12% discount request',
    context:
      'Bidiphar is our largest pharma QC account. Their procurement asked for a 12% discount on the ' +
      '450M PMM reagent order for the new plant, citing a competing offer from a regional distributor. ' +
      'PMM stock is already below reorder point, and the deal would consume most of the inbound batch.',
    problem: 'Concede margin to protect a key account, or defend price with a stock-constrained supply position?',
    objective: 'Keep Bidiphar lifetime value while protecting PMM contribution margin and honoring existing commitments.',
    status: 'analyzing',
    ownerId: DEMO_USER_ID,
    ownerLabel: 'You — Country Manager',
    dueDate: '2026-08-14',
    reviewAfter: null,
    currency: 'VND',
    amountAtStake: 450 * M,
    recommendation:
      'Counter at 6% with a bundled calibration-service credit. The relevant-cost gap between full discount ' +
      'and counter is ~27M; the service bundle costs 9M incremental but defends the price ladder.',
    decidedAlternativeId: null,
    decisionRationale: '',
    expectedOutcome: '',
    expectedMetrics: [],
    actualOutcome: '',
    outcomeScore: null,
    lesson: '',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: {
      source: 'memoire-demo',
      account: 'Bidiphar',
      opportunity: 'PMM reagent supply — new QC plant',
      value: 450 * M,
      stage: 'negotiation',
      capturedAt: now,
    },
    approvedBy: null,
    approvedAt: null,
    rejectedReason: '',
    closedAt: null,
    createdBy: DEMO_USER_ID,
    createdAt: '2026-08-05T03:00:00.000Z',
    updatedAt: now,
  },
  {
    id: 'dec-outsource',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-service',
    decisionType: 'hire_or_outsource',
    title: 'Installation overflow: certify a subcontractor vs hire a technician',
    context:
      'The installation process is running past capacity (125% at the Installation step). Backlog is 6 weeks ' +
      'and two customers have escalated. A certified subcontractor quotes 9.5M per installation; a new ' +
      'technician costs ~65M/month fully loaded after a 3-month certification ramp.',
    problem: 'Add permanent capacity or buy flexible capacity for what may be a temporary demand peak?',
    objective: 'Bring installation lead time under 2 weeks within a quarter without stranding fixed cost.',
    status: 'pending_approval',
    ownerId: 'demo-minh',
    ownerLabel: 'Minh Tran — Technical Service Lead',
    dueDate: '2026-08-20',
    reviewAfter: null,
    currency: 'VND',
    amountAtStake: 780 * M,
    recommendation: 'Subcontract the overflow for two quarters, revisit hiring if demand persists.',
    decidedAlternativeId: null,
    decisionRationale: '',
    expectedOutcome: '',
    expectedMetrics: [],
    actualOutcome: '',
    outcomeScore: null,
    lesson: '',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: '',
    closedAt: null,
    createdBy: 'demo-minh',
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-06T09:00:00.000Z',
  },
  {
    id: 'dec-vitaplex-stock',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-ops',
    decisionType: 'inventory_commitment',
    title: 'Raise VitaPlex safety stock to 60 days of inventory',
    context:
      'Two stock-outs in Q1 cost an estimated 180M in lost F&B orders. Ops proposed raising VitaPlex ' +
      'safety stock from 30 to 60 DOI ahead of the September demand season.',
    problem: 'Service level vs expiry risk on a 270-day shelf-life product.',
    objective: 'Cut stock-outs materially without growing expiry write-offs.',
    status: 'monitoring',
    ownerId: DEMO_USER_ID,
    ownerLabel: 'You — Country Manager',
    dueDate: '2026-06-15',
    reviewAfter: '2026-08-01',
    currency: 'VND',
    amountAtStake: 520 * M,
    recommendation: 'Approve the increase with a monthly expiry-exposure check.',
    decidedAlternativeId: 'alt-vp-60',
    decisionRationale: 'Stock-out cost dominated projected expiry cost at the assumed demand level.',
    expectedOutcome: 'Stock-outs down ~80%; expiry write-offs held under 2% of VitaPlex COGS.',
    expectedMetrics: [
      { metric: 'Stock-out incidents / quarter', expected: '−80% (from 5 to ≤1)', actual: '−72% (down to ~1.4)' },
      { metric: 'Expiry write-off % of COGS', expected: '≤ 2%', actual: '3.1% and rising' },
    ],
    actualOutcome: '',
    outcomeScore: null,
    lesson: '',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2026-06-12T04:00:00.000Z',
    rejectedReason: '',
    closedAt: null,
    createdBy: DEMO_USER_ID,
    createdAt: '2026-06-02T02:00:00.000Z',
    updatedAt: '2026-07-15T02:00:00.000Z',
  },
  {
    id: 'dec-acecook',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-fnb',
    decisionType: 'special_order',
    title: 'Acecook trial batch below list price',
    context:
      'Acecook requested a 15,000-unit VitaPlex trial batch at 168K/unit (list 208K) for a new noodle line. ' +
      'Blending capacity has slack in August; regular sales are unaffected.',
    problem: 'Accept a below-list special order using idle capacity?',
    objective: 'Win the new line qualification without repricing the regular book.',
    status: 'executing',
    ownerId: 'demo-lan',
    ownerLabel: 'Lan Pham — Pharma Sales Manager',
    dueDate: '2026-08-30',
    reviewAfter: '2026-09-30',
    currency: 'VND',
    amountAtStake: 2_520 * M, // 15,000 units × 168K
    recommendation: 'Accept: with idle capacity the order clears its relevant costs by ~510M.',
    decidedAlternativeId: 'alt-ace-accept',
    decisionRationale:
      'Idle capacity means no displaced contribution; incremental price (168K) far exceeds variable cost ' +
      '(~132K). Fixed overhead allocation was excluded as irrelevant.',
    expectedOutcome: 'Qualification win and ~510M incremental contribution in Q3.',
    expectedMetrics: [{ metric: 'Incremental contribution', expected: '≈ 510M VND' }],
    actualOutcome: '',
    outcomeScore: null,
    lesson: '',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2026-07-28T04:00:00.000Z',
    rejectedReason: '',
    closedAt: null,
    createdBy: 'demo-lan',
    createdAt: '2026-07-21T02:00:00.000Z',
    updatedAt: '2026-08-02T02:00:00.000Z',
  },

  // ---- Closed history: the decision-memory seed ----
  {
    id: 'dec-flu-buildup',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-ops',
    decisionType: 'inventory_commitment',
    title: 'Q1 flu-season reagent build-up',
    context: 'Pre-season stock build for respiratory diagnostic reagents.',
    problem: 'How much seasonal stock to commit before firm orders.',
    objective: 'Capture flu-season demand without post-season write-offs.',
    status: 'closed',
    ownerId: DEMO_USER_ID,
    ownerLabel: 'You — Country Manager',
    dueDate: '2026-01-10',
    reviewAfter: '2026-04-01',
    currency: 'VND',
    amountAtStake: 900 * M,
    recommendation: 'Commit to the high forecast.',
    decidedAlternativeId: null,
    decisionRationale: 'Sales forecast projected 30% season-over-season growth.',
    expectedOutcome: 'Sell-through ≥ 90% by end of season.',
    expectedMetrics: [{ metric: 'Sell-through', expected: '≥ 90%', actual: '71%' }],
    actualOutcome: 'Sell-through reached 71%; 140M of stock carried into low season.',
    outcomeScore: 'worse',
    lesson: 'Demand forecast was optimistic — the 30% growth assumption had no order-book evidence behind it.',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2026-01-08T04:00:00.000Z',
    rejectedReason: '',
    closedAt: '2026-04-10T02:00:00.000Z',
    createdBy: DEMO_USER_ID,
    createdAt: '2025-12-20T02:00:00.000Z',
    updatedAt: '2026-04-10T02:00:00.000Z',
  },
  {
    id: 'dec-tet-premix',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-fnb',
    decisionType: 'inventory_commitment',
    title: 'Tet promotion premix stock commitment',
    context: 'Stock commitment for the Tet F&B promotion window.',
    problem: 'Committed volume vs promotion uptake uncertainty.',
    objective: 'Full availability during the four promotion weeks.',
    status: 'closed',
    ownerId: 'demo-lan',
    ownerLabel: 'Lan Pham — Pharma Sales Manager',
    dueDate: '2025-12-15',
    reviewAfter: '2026-03-01',
    currency: 'VND',
    amountAtStake: 650 * M,
    recommendation: 'Commit to the promotion forecast.',
    decidedAlternativeId: null,
    decisionRationale: 'Marketing uptake model projected sell-out.',
    expectedOutcome: 'No availability gaps; ≤ 5% residual stock.',
    expectedMetrics: [{ metric: 'Residual stock after Tet', expected: '≤ 5%', actual: '18%' }],
    actualOutcome: '18% residual stock; 60M discounted to clear before expiry.',
    outcomeScore: 'worse',
    lesson: 'Promotion demand estimate was optimistic; expiry risk of the residual was not priced into the commitment.',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2025-12-12T04:00:00.000Z',
    rejectedReason: '',
    closedAt: '2026-03-05T02:00:00.000Z',
    createdBy: 'demo-lan',
    createdAt: '2025-12-01T02:00:00.000Z',
    updatedAt: '2026-03-05T02:00:00.000Z',
  },
  {
    id: 'dec-spares',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-service',
    decisionType: 'inventory_commitment',
    title: 'Analyzer spare-parts stocking level',
    context: 'Critical spares for the installed analyzer base.',
    problem: 'Carrying cost vs contract SLA penalties.',
    objective: 'Meet 48h repair SLA at minimum carrying cost.',
    status: 'closed',
    ownerId: 'demo-minh',
    ownerLabel: 'Minh Tran — Technical Service Lead',
    dueDate: '2026-02-01',
    reviewAfter: '2026-05-01',
    currency: 'VND',
    amountAtStake: 240 * M,
    recommendation: 'Stock per failure-rate model.',
    decidedAlternativeId: null,
    decisionRationale: 'Failure-rate data from the installed base was solid.',
    expectedOutcome: 'SLA hit rate ≥ 95%.',
    expectedMetrics: [{ metric: 'SLA hit rate', expected: '≥ 95%', actual: '96%' }],
    actualOutcome: 'SLA hit 96% with carrying cost on plan.',
    outcomeScore: 'as_expected',
    lesson: 'Failure-rate-based sizing worked; keep using installed-base data over gut feel.',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2026-01-28T04:00:00.000Z',
    rejectedReason: '',
    closedAt: '2026-05-06T02:00:00.000Z',
    createdBy: 'demo-minh',
    createdAt: '2026-01-15T02:00:00.000Z',
    updatedAt: '2026-05-06T02:00:00.000Z',
  },
  {
    id: 'dec-legacydye-keep',
    orgId: DEMO_ORG_ID,
    orgUnitId: 'unit-fnb',
    decisionType: 'keep_or_drop',
    title: 'Keep LegacyDye D40 line through 2026',
    context: 'Aging colorant line with declining volume and thin margins.',
    problem: 'Drop now or ride out existing customer commitments.',
    objective: 'Exit without breaking supply commitments to two accounts.',
    status: 'closed',
    ownerId: DEMO_USER_ID,
    ownerLabel: 'You — Country Manager',
    dueDate: '2026-03-15',
    reviewAfter: '2026-07-01',
    currency: 'VND',
    amountAtStake: 350 * M,
    recommendation: 'Keep for 2026, no reorder after Q3.',
    decidedAlternativeId: null,
    decisionRationale: 'Segment margin was positive at decision time; contractual exposure decided it.',
    expectedOutcome: 'Segment margin stays non-negative through the run-off.',
    expectedMetrics: [{ metric: 'Segment margin', expected: '≥ 0', actual: 'negative since May' }],
    actualOutcome: 'Volume fell faster than planned; segment margin went negative in May.',
    outcomeScore: 'mixed',
    lesson: 'The volume demand estimate was too high; run-off decisions need a monthly volume trigger, not a yearly review.',
    signalId: null,
    memoireAccountId: null,
    memoireOpportunityId: null,
    contextSnapshot: null,
    approvedBy: DEMO_USER_ID,
    approvedAt: '2026-03-10T04:00:00.000Z',
    rejectedReason: '',
    closedAt: '2026-07-08T02:00:00.000Z',
    createdBy: DEMO_USER_ID,
    createdAt: '2026-02-25T02:00:00.000Z',
    updatedAt: '2026-07-08T02:00:00.000Z',
  },
];

export const demoAlternatives: DecisionAlternative[] = [
  // Bidiphar pricing decision.
  {
    id: 'alt-bid-full',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-bidiphar',
    name: 'Accept 12% discount',
    description: 'Concede the full discount to close immediately.',
    financialLines: [
      { label: 'Order revenue at −12%', kind: 'incremental_revenue', amount: 396 * M },
      { label: 'Reagent COGS + logistics', kind: 'relevant_cost', amount: 252 * M },
      { label: 'Price-ladder erosion risk (2 accounts likely to match)', kind: 'opportunity_cost', amount: 38 * M, note: 'Modeled as expected CM loss on reference accounts over 12 months.' },
      { label: 'Allocated corporate overhead', kind: 'allocated_ignored', amount: 30 * M, note: 'Does not change with this order.' },
    ],
    qualitative: 'Fastest close; procurement goodwill.',
    strategic: 'Signals that list price is negotiable at scale — dangerous with the KA program launching.',
    risks: 'Reference pricing spreads to DHG and Imexpharm.',
    isRecommended: false,
    sort: 0,
  },
  {
    id: 'alt-bid-counter',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-bidiphar',
    name: 'Counter: 6% + service credit',
    description: '6% discount plus a bundled calibration-service credit (9M cost).',
    financialLines: [
      { label: 'Order revenue at −6%', kind: 'incremental_revenue', amount: 423 * M },
      { label: 'Reagent COGS + logistics', kind: 'relevant_cost', amount: 252 * M },
      { label: 'Calibration service credit', kind: 'relevant_cost', amount: 9 * M },
      { label: 'Residual close risk (~10% chance of losing deal)', kind: 'opportunity_cost', amount: 16 * M, note: '10% × ~160M relevant margin of the deal.' },
      { label: 'Allocated corporate overhead', kind: 'allocated_ignored', amount: 30 * M },
    ],
    qualitative: 'Keeps the discount inside the approved band; service credit deepens lock-in.',
    strategic: 'Defends the price ladder while giving procurement a win to report.',
    risks: 'Bidiphar may still push; competitor could go lower.',
    isRecommended: true,
    sort: 1,
  },
  {
    id: 'alt-bid-decline',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-bidiphar',
    name: 'Hold list price',
    description: 'Decline any discount; rely on validated-supplier switching costs.',
    financialLines: [
      { label: 'Order revenue at list (70% close odds)', kind: 'incremental_revenue', amount: 315 * M, note: '450M × 70% expected close.' },
      { label: 'Expected COGS at 70% close', kind: 'relevant_cost', amount: 176 * M },
      { label: 'Relationship damage on future tenders', kind: 'opportunity_cost', amount: 45 * M },
    ],
    qualitative: 'Strongest price discipline.',
    strategic: 'High-risk with the new plant tender cycle opening in Q4.',
    risks: '30% chance the volume goes to the regional competitor and anchors them in the account.',
    isRecommended: false,
    sort: 2,
  },

  // Outsource decision.
  {
    id: 'alt-out-sub',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-outsource',
    name: 'Subcontract overflow (2 quarters)',
    description: 'Certified subcontractor at 9.5M per installation, ~8/month.',
    financialLines: [
      { label: 'Recovered installation revenue (backlog clears)', kind: 'incremental_revenue', amount: 640 * M },
      { label: 'Subcontractor fees (48 installs)', kind: 'relevant_cost', amount: 456 * M },
      { label: 'Certification & QA oversight', kind: 'relevant_cost', amount: 36 * M },
    ],
    qualitative: 'Flexible; stops the escalations within weeks.',
    strategic: 'Builds a partner bench for the northern region.',
    risks: 'Quality variance on first installs; margin leakage if demand persists.',
    isRecommended: true,
    sort: 0,
  },
  {
    id: 'alt-out-hire',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-outsource',
    name: 'Hire a technician',
    description: 'Permanent capacity, productive from month 4.',
    financialLines: [
      { label: 'Recovered installation revenue (slower ramp)', kind: 'incremental_revenue', amount: 480 * M },
      { label: 'Fully-loaded cost (6 months)', kind: 'relevant_cost', amount: 390 * M },
      { label: 'Certification program', kind: 'relevant_cost', amount: 45 * M },
      { label: 'Existing team training time', kind: 'relevant_cost', amount: 22 * M },
    ],
    qualitative: 'Keeps quality in-house; helps retention of the overloaded team.',
    strategic: 'Right call only if the demand step is permanent.',
    risks: 'Fixed cost stranded if demand normalizes; 3-month gap does not fix the current backlog.',
    isRecommended: false,
    sort: 1,
  },

  // VitaPlex stock decision (decided).
  {
    id: 'alt-vp-60',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-vitaplex-stock',
    name: 'Raise to 60 DOI',
    description: 'Double safety stock ahead of the season.',
    financialLines: [
      { label: 'Avoided stock-out margin loss', kind: 'incremental_revenue', amount: 170 * M },
      { label: 'Incremental carrying cost', kind: 'relevant_cost', amount: 48 * M },
      { label: 'Expected expiry write-off increase', kind: 'relevant_cost', amount: 35 * M },
    ],
    qualitative: 'Protects the September season.',
    strategic: 'Supports the Acecook qualification push.',
    risks: 'Expiry exposure if demand softens — flagged for monthly review.',
    isRecommended: true,
    sort: 0,
  },
  {
    id: 'alt-vp-45',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-vitaplex-stock',
    name: 'Raise to 45 DOI',
    description: 'Half-step with a mid-season reorder option.',
    financialLines: [
      { label: 'Avoided stock-out margin loss (partial)', kind: 'incremental_revenue', amount: 120 * M },
      { label: 'Incremental carrying cost', kind: 'relevant_cost', amount: 26 * M },
      { label: 'Expected expiry write-off increase', kind: 'relevant_cost', amount: 15 * M },
    ],
    qualitative: 'Lower risk, but the mid-season reorder depends on a 35-day lead time.',
    strategic: '',
    risks: 'Lead-time slip recreates the stock-out.',
    isRecommended: false,
    sort: 1,
  },

  // Acecook special order (decided).
  {
    id: 'alt-ace-accept',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-acecook',
    name: 'Accept at 168K/unit',
    description: 'Trial batch on idle August capacity.',
    financialLines: [
      { label: 'Special-order revenue (15,000 × 168K)', kind: 'incremental_revenue', amount: 2_520 * M },
      { label: 'Variable cost (15,000 × 132K)', kind: 'relevant_cost', amount: 1_980 * M },
      { label: 'Rush QC and changeover', kind: 'relevant_cost', amount: 30 * M },
      { label: 'Displaced regular sales', kind: 'opportunity_cost', amount: 0, note: 'Idle capacity — nothing displaced.' },
      { label: 'Blending line depreciation', kind: 'sunk_ignored', amount: 85 * M, note: 'Incurred either way.' },
      { label: 'Plant overhead allocation', kind: 'allocated_ignored', amount: 120 * M },
    ],
    qualitative: 'Qualification is the prize; price is quarantined as a trial SKU.',
    strategic: 'Opens the largest instant-noodle account in the market.',
    risks: 'Acecook anchors on 168K for the production contract.',
    isRecommended: true,
    sort: 0,
  },
  {
    id: 'alt-ace-decline',
    orgId: DEMO_ORG_ID,
    decisionId: 'dec-acecook',
    name: 'Decline below-list order',
    description: 'Protect the list price; offer standard volume tiers.',
    financialLines: [
      { label: 'No incremental order', kind: 'incremental_revenue', amount: 0 },
      { label: 'Lost qualification option', kind: 'opportunity_cost', amount: 540 * M, note: 'Expected value of the production contract option.' },
    ],
    qualitative: '',
    strategic: 'Cedes the qualification slot to the incumbent supplier.',
    risks: '',
    isRecommended: false,
    sort: 1,
  },
];

export const demoAssumptions: DecisionAssumption[] = [
  { id: 'as-bid-1', orgId: DEMO_ORG_ID, decisionId: 'dec-bidiphar', statement: 'Competing offer is real and ~10% below our list', basis: 'Procurement shared a redacted quote page; brand unverified.', sensitivity: 'high', validated: 'pending' },
  { id: 'as-bid-2', orgId: DEMO_ORG_ID, decisionId: 'dec-bidiphar', statement: 'Bidiphar validated-supplier switching cost ≈ 3 months of requalification', basis: 'Their QA lead, March audit visit.', sensitivity: 'medium', validated: 'pending' },
  { id: 'as-bid-3', orgId: DEMO_ORG_ID, decisionId: 'dec-bidiphar', statement: 'Inbound PMM batch (60 kits) lands before 20 Aug', basis: 'Supplier confirmation 4 Aug; customs variance ±5 days.', sensitivity: 'high', validated: 'pending' },
  { id: 'as-out-1', orgId: DEMO_ORG_ID, decisionId: 'dec-outsource', statement: 'Demand stays ≥ 20 installs/week through Q4', basis: 'Signed order backlog covers 9 weeks.', sensitivity: 'high', validated: 'pending' },
  { id: 'as-out-2', orgId: DEMO_ORG_ID, decisionId: 'dec-outsource', statement: 'Subcontractor reaches our QA pass rate within 5 installs', basis: 'Reference checks from two vendors.', sensitivity: 'medium', validated: 'pending' },
  { id: 'as-vp-1', orgId: DEMO_ORG_ID, decisionId: 'dec-vitaplex-stock', statement: 'September demand ≥ 45 units/day', basis: 'Last two seasons averaged 47/day.', sensitivity: 'high', validated: 'failed' },
  { id: 'as-vp-2', orgId: DEMO_ORG_ID, decisionId: 'dec-vitaplex-stock', statement: 'No shelf-life reduction from the new supplier batch', basis: 'CoA shows standard 270-day dating.', sensitivity: 'low', validated: 'held' },
  { id: 'as-ace-1', orgId: DEMO_ORG_ID, decisionId: 'dec-acecook', statement: 'August blending capacity has ≥ 20% slack', basis: 'Ops capacity report, July.', sensitivity: 'medium', validated: 'held' },
];

export const demoActions: DecisionAction[] = [
  { id: 'act-ace-1', orgId: DEMO_ORG_ID, decisionId: 'dec-acecook', title: 'Confirm trial-batch production slot with blending', ownerLabel: 'Operations', ownerId: null, dueDate: '2026-08-12', status: 'done', writeback: null },
  { id: 'act-ace-2', orgId: DEMO_ORG_ID, decisionId: 'dec-acecook', title: 'Issue trial-SKU price letter quarantining 168K to this batch', ownerLabel: 'Lan Pham', ownerId: 'demo-lan', dueDate: '2026-08-15', status: 'open', writeback: null },
  { id: 'act-vp-1', orgId: DEMO_ORG_ID, decisionId: 'dec-vitaplex-stock', title: 'Monthly expiry-exposure review for VitaPlex', ownerLabel: 'Thu Nguyen', ownerId: 'demo-thu', dueDate: '2026-08-31', status: 'open', writeback: null },
];

export const demoEvents: DecisionEvent[] = [
  { id: 'ev-1', orgId: DEMO_ORG_ID, decisionId: 'dec-bidiphar', eventType: 'created', actorId: DEMO_USER_ID, actorLabel: 'You', payload: { from: 'signal', template: 'pricing' }, createdAt: '2026-08-05T03:00:00.000Z' },
  { id: 'ev-2', orgId: DEMO_ORG_ID, decisionId: 'dec-bidiphar', eventType: 'status_changed', actorId: DEMO_USER_ID, actorLabel: 'You', payload: { from: 'draft', to: 'analyzing' }, createdAt: '2026-08-05T03:20:00.000Z' },
  { id: 'ev-3', orgId: DEMO_ORG_ID, decisionId: 'dec-outsource', eventType: 'created', actorId: 'demo-minh', actorLabel: 'Minh Tran', payload: {}, createdAt: '2026-08-01T02:00:00.000Z' },
  { id: 'ev-4', orgId: DEMO_ORG_ID, decisionId: 'dec-outsource', eventType: 'status_changed', actorId: 'demo-minh', actorLabel: 'Minh Tran', payload: { from: 'analyzing', to: 'pending_approval', reason: 'amount 780M ≥ 500M any-type threshold' }, createdAt: '2026-08-06T09:00:00.000Z' },
  { id: 'ev-5', orgId: DEMO_ORG_ID, decisionId: 'dec-vitaplex-stock', eventType: 'approved', actorId: DEMO_USER_ID, actorLabel: 'You', payload: { alternative: 'Raise to 60 DOI' }, createdAt: '2026-06-12T04:00:00.000Z' },
  { id: 'ev-6', orgId: DEMO_ORG_ID, decisionId: 'dec-acecook', eventType: 'approved', actorId: DEMO_USER_ID, actorLabel: 'You', payload: { alternative: 'Accept at 168K/unit' }, createdAt: '2026-07-28T04:00:00.000Z' },
  { id: 'ev-7', orgId: DEMO_ORG_ID, decisionId: 'dec-acecook', eventType: 'status_changed', actorId: 'demo-lan', actorLabel: 'Lan Pham', payload: { from: 'approved', to: 'executing' }, createdAt: '2026-08-02T02:00:00.000Z' },
];

/** Demo stand-ins for the Memoire "Analyze in HELM" flow. */
export const demoMemoireOpportunities = [
  { id: 'mem-opp-1', accountName: 'Bidiphar', title: 'PMM reagent supply — new QC plant', value: 450 * M, currency: 'VND', stage: 'negotiation' },
  { id: 'mem-opp-2', accountName: 'DHG Pharma', title: 'Stability-chamber consumables annual contract', value: 820 * M, currency: 'VND', stage: 'proposal' },
  { id: 'mem-opp-3', accountName: 'Acecook Vietnam', title: 'VitaPlex production contract 2027', value: 6_200 * M, currency: 'VND', stage: 'qualification' },
];
