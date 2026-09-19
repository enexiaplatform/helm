import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenario, sensitivity } from '../../src/domain/engines/scenario.ts';

const baseline = {
  label: 'Baseline',
  currency: 'VND',
  unitPrice: 100,
  unitsPerPeriod: 1000,
  variableCostPerUnit: 60,
  fixedCostsPerPeriod: 30000,
};

describe('scenario engine', () => {
  test('baseline evaluation matches CVP arithmetic', () => {
    const r = evaluateScenario(baseline);
    assert.equal(r.revenue, 100000);
    assert.equal(r.contributionMargin, 40000);
    assert.equal(r.operatingProfit, 10000);
    assert.equal(r.breakEvenUnits, 750);
    assert.equal(r.profitVsBaseline, 0);
  });

  test('percentage deltas compound correctly', () => {
    const r = evaluateScenario(baseline, {
      id: 'v',
      name: 'Price +10%, volume −5%',
      deltas: { unitPricePct: 10, unitsPct: -5 },
    });
    // price 110, units 950, cm/unit 50 → CM 47500 − 30000 = 17500
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);
    close(r.unitPrice, 110);
    close(r.units, 950);
    close(r.operatingProfit, 17500);
    close(r.profitVsBaseline, 7500);
  });

  test('absolute deltas apply after percentage deltas', () => {
    const r = evaluateScenario(baseline, {
      id: 'v',
      name: 'abs',
      deltas: { fixedCostsAbs: 5000 },
    });
    assert.equal(r.fixedCosts, 35000);
    assert.equal(r.operatingProfit, 5000);
  });

  test('sensitivity orders drivers by profit swing', () => {
    const bars = sensitivity(baseline, 10);
    // ±10% price swings profit by ±10000 (units × 10) → swing 20000, the largest.
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);
    assert.equal(bars[0].variable, 'unitPrice');
    close(bars[0].swing, 20000);
    // Volume ±10% changes CM by ±4000 → swing 8000.
    const volume = bars.find((b) => b.variable === 'units');
    close(volume.swing, 8000);
    // Fixed ±10% → swing 6000.
    const fixed = bars.find((b) => b.variable === 'fixedCosts');
    close(fixed.swing, 6000);
    // Sorted descending by swing.
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i - 1].swing >= bars[i].swing);
    }
  });
});
