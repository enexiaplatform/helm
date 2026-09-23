import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocationTrap } from '../../src/domain/engines/relevantCost.ts';

describe('the allocation trap', () => {
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
