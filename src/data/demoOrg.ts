import type {
  CostObject,
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

export const demoMemoireOpportunities = [
  { id: 'mem-opp-1', accountName: 'Bidiphar', title: 'PMM reagent supply — new QC plant', value: 450 * M, currency: 'VND', stage: 'negotiation' },
  { id: 'mem-opp-2', accountName: 'DHG Pharma', title: 'Stability-chamber consumables annual contract', value: 820 * M, currency: 'VND', stage: 'proposal' },
  { id: 'mem-opp-3', accountName: 'Acecook Vietnam', title: 'VitaPlex production contract 2027', value: 6_200 * M, currency: 'VND', stage: 'qualification' },
];
