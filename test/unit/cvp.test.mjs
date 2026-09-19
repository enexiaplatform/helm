import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCvp, unitsForTargetProfit, analyzeMultiProductCvp } from '../../src/domain/engines/cvp.ts';

describe('CVP engine', () => {
  test('computes contribution margin, break-even, and profit', () => {
    const r = analyzeCvp({ unitPrice: 100, variableCostPerUnit: 60, fixedCosts: 20000, units: 800 });
    assert.equal(r.contributionMarginPerUnit, 40);
    assert.equal(r.contributionMarginRatio, 0.4);
    assert.equal(r.breakEvenUnits, 500);
    assert.equal(r.breakEvenRevenue, 50000);
    assert.equal(r.revenue, 80000);
    assert.equal(r.totalContributionMargin, 32000);
    assert.equal(r.operatingProfit, 12000);
    assert.equal(r.marginOfSafetyUnits, 300);
    assert.ok(Math.abs(r.marginOfSafetyRatio - 0.375) < 1e-12);
  });

  test('operating leverage = CM / operating profit', () => {
    const r = analyzeCvp({ unitPrice: 100, variableCostPerUnit: 60, fixedCosts: 20000, units: 800 });
    assert.ok(Math.abs(r.operatingLeverage - 32000 / 12000) < 1e-12);
  });

  test('break-even is null when contribution margin is non-positive', () => {
    const r = analyzeCvp({ unitPrice: 50, variableCostPerUnit: 60, fixedCosts: 1000, units: 10 });
    assert.equal(r.breakEvenUnits, null);
    assert.equal(r.breakEvenRevenue, null);
    assert.equal(r.marginOfSafetyUnits, null);
  });

  test('target profit units', () => {
    assert.equal(
      unitsForTargetProfit({ unitPrice: 100, variableCostPerUnit: 60, fixedCosts: 20000 }, 8000),
      700,
    );
    assert.equal(
      unitsForTargetProfit({ unitPrice: 50, variableCostPerUnit: 60, fixedCosts: 1000 }, 100),
      null,
    );
  });

  test('multi-product weighted break-even', () => {
    const r = analyzeMultiProductCvp(
      [
        { name: 'A', unitPrice: 100, variableCostPerUnit: 60, mixShare: 0.75 },
        { name: 'B', unitPrice: 200, variableCostPerUnit: 120, mixShare: 0.25 },
      ],
      50000,
    );
    // weighted CM = 0.75*40 + 0.25*80 = 50
    assert.equal(r.weightedCmPerUnit, 50);
    assert.equal(r.breakEvenTotalUnits, 1000);
    assert.deepEqual(r.breakEvenByProduct, [
      { name: 'A', units: 750 },
      { name: 'B', units: 250 },
    ]);
  });

  test('multi-product rejects a mix that does not sum to 1', () => {
    const r = analyzeMultiProductCvp(
      [{ name: 'A', unitPrice: 100, variableCostPerUnit: 60, mixShare: 0.5 }],
      1000,
    );
    assert.equal(r.breakEvenTotalUnits, null);
  });
});
