import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  inverseNormalCdf,
  analyzeInventoryItem,
  analyzeWorkingCapital,
} from '../../src/domain/engines/inventory.ts';

const baseItem = {
  id: 'i1',
  orgId: 'o1',
  costObjectId: null,
  sku: 'SKU-1',
  name: 'Test item',
  unitCost: 50,
  unitPrice: 90,
  avgDailyDemand: 10,
  demandStddev: 4,
  leadTimeDays: 9,
  stockOnHand: 300,
  stockInbound: 0,
  expiryDate: null,
  shelfLifeDays: null,
  serviceLevel: null,
  orderCost: null,
  holdingCostRate: null,
};

describe('inventory engine', () => {
  test('inverse normal CDF hits known quantiles', () => {
    assert.ok(Math.abs(inverseNormalCdf(0.95) - 1.6449) < 1e-3);
    assert.ok(Math.abs(inverseNormalCdf(0.5)) < 1e-9);
    assert.ok(Math.abs(inverseNormalCdf(0.975) - 1.9600) < 1e-3);
  });

  test('safety stock and reorder point follow z·σ·√LT + d·LT', () => {
    const a = analyzeInventoryItem(baseItem, 0.95);
    const expectedSS = 1.6449 * 4 * 3; // z * stddev * sqrt(9)
    assert.ok(Math.abs(a.safetyStock - expectedSS) < 0.01);
    assert.ok(Math.abs(a.reorderPoint - (90 + expectedSS)) < 0.01);
  });

  test('stock-out risk when projected stock is below reorder point', () => {
    const risky = analyzeInventoryItem({ ...baseItem, stockOnHand: 80, stockInbound: 0 });
    assert.equal(risky.stockoutRisk, true);
    const safe = analyzeInventoryItem({ ...baseItem, stockOnHand: 80, stockInbound: 100 });
    assert.equal(safe.stockoutRisk, false);
  });

  test('expiry exposure counts stock beyond sellable-before-expiry demand', () => {
    const today = new Date('2026-08-08T00:00:00Z');
    const a = analyzeInventoryItem(
      { ...baseItem, stockOnHand: 500, expiryDate: '2026-09-07' }, // 30 days out
      0.95,
      today,
    );
    // sellable = 30 days × 10/day = 300 → 200 units exposed → 10,000 value
    assert.equal(a.expiryExposureUnits, 200);
    assert.equal(a.expiryExposureValue, 10000);
  });

  test('EOQ formula', () => {
    const a = analyzeInventoryItem({
      ...baseItem,
      orderCost: 100,
      holdingCostRate: 0.2, // 20% of 50 = 10 per unit per year
    });
    const annual = 10 * 365;
    const expected = Math.sqrt((2 * annual * 100) / 10);
    assert.ok(Math.abs(a.eoq - expected) < 1e-9);
  });

  test('working capital: DOI + DSO − DPO = CCC', () => {
    const r = analyzeWorkingCapital({
      annualRevenue: 3650000,
      annualCogs: 1825000,
      inventoryValue: 150000,
      receivables: 300000,
      payables: 100000,
    });
    assert.equal(r.doi, 30);
    assert.equal(r.dso, 30);
    assert.equal(r.dpo, 20);
    assert.equal(r.cashConversionCycleDays, 40);
    assert.ok(Math.abs(r.inventoryTurnover - 1825000 / 150000) < 1e-9);
    assert.equal(r.workingCapital, 350000);
  });
});
