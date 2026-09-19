import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAlternative,
  compareAlternatives,
  allocationTrap,
} from '../../src/domain/engines/relevantCost.ts';

describe('relevant-cost engine', () => {
  test('sunk and allocated lines are shown but excluded from the result', () => {
    const r = evaluateAlternative({
      id: 'a1',
      name: 'Accept special order',
      financialLines: [
        { label: 'Order revenue', kind: 'incremental_revenue', amount: 100000 },
        { label: 'Materials + direct labor', kind: 'relevant_cost', amount: 60000 },
        { label: 'Displaced regular sales CM', kind: 'opportunity_cost', amount: 15000 },
        { label: 'Existing machine depreciation', kind: 'sunk_ignored', amount: 20000 },
        { label: 'Corporate overhead allocation', kind: 'allocated_ignored', amount: 12000 },
      ],
    });
    assert.equal(r.incrementalRevenue, 100000);
    assert.equal(r.relevantCosts, 60000);
    assert.equal(r.opportunityCost, 15000);
    assert.equal(r.netRelevantBenefit, 25000);
    assert.equal(r.excludedLines.length, 2);
    assert.equal(r.includedLines.length, 3);
  });

  test('comparison picks the best alternative and quantifies the advantage', () => {
    const r = compareAlternatives([
      {
        id: 'make',
        name: 'Make in-house',
        financialLines: [{ label: 'Production cost', kind: 'relevant_cost', amount: 90000 }],
      },
      {
        id: 'buy',
        name: 'Buy from supplier',
        financialLines: [
          { label: 'Purchase cost', kind: 'relevant_cost', amount: 100000 },
          { label: 'Freed capacity CM', kind: 'incremental_revenue', amount: 25000 },
        ],
      },
    ]);
    // make: -90000; buy: 25000 - 100000 = -75000 → buy is better by 15000
    assert.equal(r.bestAlternativeId, 'buy');
    assert.equal(r.advantageOverNext, 15000);
  });

  test('tie produces no best alternative', () => {
    const r = compareAlternatives([
      { id: 'x', name: 'X', financialLines: [{ label: 'c', kind: 'relevant_cost', amount: 10 }] },
      { id: 'y', name: 'Y', financialLines: [{ label: 'c', kind: 'relevant_cost', amount: 10 }] },
    ]);
    assert.equal(r.bestAlternativeId, null);
  });

  test('allocation trap: negative reported net with positive segment margin', () => {
    const r = allocationTrap({
      revenue: 100000,
      variableCost: 55000,
      traceableFixedCost: 30000,
      allocatedFixedCost: 25000,
    });
    assert.equal(r.segmentMargin, 15000);
    assert.equal(r.reportedNet, -10000);
    assert.equal(r.trapped, true);
  });

  test('genuinely unprofitable segment is not a trap', () => {
    const r = allocationTrap({
      revenue: 100000,
      variableCost: 80000,
      traceableFixedCost: 30000,
      allocatedFixedCost: 5000,
    });
    assert.equal(r.segmentMargin, -10000);
    assert.equal(r.trapped, false);
  });
});
