import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProcess } from '../../src/domain/engines/capacity.ts';

const process = {
  id: 'p1',
  orgId: 'o1',
  name: 'Instrument installation',
  description: '',
  demandPerWeek: 20,
};

const activity = (id, name, processingMinutes, resourcesCount, available = 2400, wait = 0, sort = 0) => ({
  id,
  orgId: 'o1',
  processId: 'p1',
  name,
  ownerLabel: '',
  processingMinutes,
  resourcesCount,
  availableMinutesPerWeek: available,
  waitMinutes: wait,
  sort,
});

describe('capacity engine', () => {
  test('bottleneck is the activity with the lowest weekly capacity', () => {
    const r = analyzeProcess(process, [
      activity('a', 'Site survey', 60, 1, 2400, 0, 0), // 40/wk
      activity('b', 'Install', 150, 1, 2400, 0, 1), // 16/wk ← bottleneck
      activity('c', 'Calibration', 80, 1, 2400, 0, 2), // 30/wk
    ]);
    assert.equal(r.bottleneckActivityId, 'b');
    assert.equal(r.processCapacityPerWeek, 16);
    // Demand 20 > capacity 16 → utilization 1.25, flow limited to 16.
    assert.ok(Math.abs(r.utilization - 1.25) < 1e-12);
    assert.equal(r.flowRatePerWeek, 16);
  });

  test('extra resources raise activity capacity', () => {
    const r = analyzeProcess(process, [
      activity('a', 'Site survey', 60, 1, 2400, 0, 0),
      activity('b', 'Install', 150, 2, 2400, 0, 1), // 32/wk with 2 techs
    ]);
    assert.equal(r.processCapacityPerWeek, 32);
    assert.equal(r.bottleneckActivityId, 'b');
    assert.equal(r.flowRatePerWeek, 20); // demand-limited now
  });

  test("Little's Law WIP uses consistent week units", () => {
    const r = analyzeProcess(process, [
      activity('a', 'Step', 100, 1, 2400, 900, 0), // flow time 1000 min
    ]);
    // capacity 24/wk > demand 20 → flow 20/wk; WIP = 20 × 1000/10080
    assert.ok(Math.abs(r.avgWorkInProcess - (20 * 1000) / 10080) < 1e-9);
  });

  test('empty process yields nulls', () => {
    const r = analyzeProcess(process, []);
    assert.equal(r.processCapacityPerWeek, null);
    assert.equal(r.bottleneckActivityId, null);
  });
});
