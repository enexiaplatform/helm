import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignals } from '../../src/domain/engines/signals.ts';
import { detectPatterns } from '../../src/domain/engines/decisionMemory.ts';

const co = (id, name, kind = 'product') => ({
  id,
  orgId: 'o1',
  parentId: null,
  orgUnitId: null,
  kind,
  name,
  memoireAccountId: null,
  active: true,
});

const econ = (costObjectId, period, kind, revenue, variableCost, traceable, allocated) => ({
  id: `${costObjectId}:${period}:${kind}`,
  orgId: 'o1',
  costObjectId,
  period,
  kind,
  revenue,
  variableCost,
  traceableFixedCost: traceable,
  allocatedFixedCost: allocated,
  units: null,
});

const emptyInput = {
  currency: 'VND',
  costObjects: [],
  economics: [],
  inventory: [],
  processes: [],
  processActivities: [],
  decisions: [],
};

describe('signal rule engine', () => {
  test('flags the allocation trap with full evidence', () => {
    const signals = detectSignals({
      ...emptyInput,
      costObjects: [co('p1', 'VitaPlex')],
      economics: [econ('p1', '2026-07', 'actual', 100000, 55000, 30000, 25000)],
    });
    const trap = signals.find((s) => s.ruleCode === 'ECON-TRAP');
    assert.ok(trap);
    assert.equal(trap.severity, 'warning');
    assert.equal(trap.suggestedDecisionType, 'keep_or_drop');
    assert.ok(trap.evidence.length >= 4);
    assert.ok(trap.reason.includes('segment margin is positive'));
  });

  test('distinguishes a genuinely negative segment from the trap', () => {
    const signals = detectSignals({
      ...emptyInput,
      costObjects: [co('p2', 'LossMaker')],
      economics: [econ('p2', '2026-07', 'actual', 100000, 90000, 30000, 0)],
    });
    assert.ok(signals.some((s) => s.ruleCode === 'ECON-NEG'));
    assert.ok(!signals.some((s) => s.ruleCode === 'ECON-TRAP'));
  });

  test('budget variance fires only beyond the threshold and only for the latest period', () => {
    const signals = detectSignals({
      ...emptyInput,
      costObjects: [co('t1', 'Pharma team', 'business_unit')],
      economics: [
        econ('t1', '2026-06', 'actual', 50000, 0, 0, 0),
        econ('t1', '2026-06', 'budget', 100000, 0, 0, 0),
        econ('t1', '2026-07', 'actual', 95000, 0, 0, 0),
        econ('t1', '2026-07', 'budget', 100000, 0, 0, 0),
      ],
    });
    // July variance is −5%, below the 10% default → no signal despite June −50%.
    assert.ok(!signals.some((s) => s.ruleCode === 'BUD-VAR'));
  });

  test('stock-out risk fires below reorder point with critical severity', () => {
    const signals = detectSignals({
      ...emptyInput,
      inventory: [
        {
          id: 'i1', orgId: 'o1', costObjectId: null, sku: 'S', name: 'PMM Reagent',
          unitCost: 100, unitPrice: 150, avgDailyDemand: 10, demandStddev: 3,
          leadTimeDays: 14, stockOnHand: 60, stockInbound: 0, expiryDate: null,
          shelfLifeDays: null, serviceLevel: null, orderCost: null, holdingCostRate: null,
        },
      ],
    });
    const s = signals.find((x) => x.ruleCode === 'INV-STOCKOUT');
    assert.ok(s);
    assert.equal(s.severity, 'critical');
    assert.equal(s.suggestedDecisionType, 'inventory_commitment');
  });

  test('capacity signal escalates to critical at ≥100% utilization', () => {
    const signals = detectSignals({
      ...emptyInput,
      processes: [{ id: 'p1', orgId: 'o1', name: 'Service', description: '', demandPerWeek: 20 }],
      processActivities: [
        {
          id: 'a1', orgId: 'o1', processId: 'p1', name: 'Install', ownerLabel: 'Tech team',
          processingMinutes: 150, resourcesCount: 1, availableMinutesPerWeek: 2400,
          waitMinutes: 0, sort: 0,
        },
      ],
    });
    const s = signals.find((x) => x.ruleCode === 'CAP-BOTTLENECK');
    assert.ok(s);
    assert.equal(s.severity, 'critical');
    assert.ok(s.evidence.some((e) => e.label === 'Bottleneck' && e.value === 'Install'));
  });

  test('signals sort by severity', () => {
    const signals = detectSignals({
      ...emptyInput,
      costObjects: [co('p1', 'VitaPlex')],
      economics: [econ('p1', '2026-07', 'actual', 100000, 55000, 30000, 25000)],
      inventory: [
        {
          id: 'i1', orgId: 'o1', costObjectId: null, sku: 'S', name: 'PMM Reagent',
          unitCost: 100, unitPrice: 150, avgDailyDemand: 10, demandStddev: 3,
          leadTimeDays: 14, stockOnHand: 60, stockInbound: 0, expiryDate: null,
          shelfLifeDays: null, serviceLevel: null, orderCost: null, holdingCostRate: null,
        },
      ],
    });
    assert.equal(signals[0].severity, 'critical');
  });
});

describe('decision memory patterns', () => {
  const closedDecision = (id, decisionType, outcomeScore, lesson = '') => ({
    id, orgId: 'o1', orgUnitId: null, decisionType, title: id, context: '', problem: '',
    objective: '', status: 'closed', ownerId: null, dueDate: null, reviewAfter: null,
    currency: null, amountAtStake: null, recommendation: '', decidedAlternativeId: null,
    decisionRationale: '', expectedOutcome: '', expectedMetrics: [], actualOutcome: '',
    outcomeScore, lesson, signalId: null, memoireAccountId: null, memoireOpportunityId: null,
    contextSnapshot: null, approvedBy: null, approvedAt: null, rejectedReason: '',
    closedAt: '2026-08-01T00:00:00Z', createdBy: 'u1', createdAt: '', updatedAt: '',
  });

  test('systematic under-delivery needs ≥3 closed decisions with ≥2/3 worse', () => {
    const patterns = detectPatterns([
      closedDecision('d1', 'inventory_commitment', 'worse'),
      closedDecision('d2', 'inventory_commitment', 'worse'),
      closedDecision('d3', 'inventory_commitment', 'as_expected'),
    ]);
    assert.ok(patterns.some((p) => p.code === 'MEM-OPTIMISM'));
  });

  test('small samples produce no pattern', () => {
    const patterns = detectPatterns([
      closedDecision('d1', 'pricing', 'worse'),
      closedDecision('d2', 'pricing', 'worse'),
    ]);
    assert.equal(patterns.length, 0);
  });

  test('recurring forecast lessons are surfaced', () => {
    const patterns = detectPatterns([
      closedDecision('d1', 'pricing', 'worse', 'Demand forecast was optimistic'),
      closedDecision('d2', 'investment', 'mixed', 'Forecast overshot again'),
      closedDecision('d3', 'keep_or_drop', 'as_expected', 'forecast assumptions too rosy'),
    ]);
    assert.ok(patterns.some((p) => p.code === 'MEM-FORECAST'));
  });
});
