/**
 * Unit-safe quantity algebra.
 *
 * The point of this module is that the WRONG operation is not available, so most
 * of these tests assert on refusals. Each refusal here corresponds to a mistake
 * that would otherwise produce a plausible-looking wrong number in front of a
 * manager: a hundredfold error from scaling by 70 instead of 0.7, a currency
 * addition across VND and USD, a percentage where a ratio belongs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuantityErrors,
  atLeastZero,
  decimal,
  difference,
  formatQuantity,
  maxOf,
  minOf,
  mustQuantity,
  percentageOf,
  quantity,
  ratioOf,
  scaleByCount,
  scaleByRatio,
  sum,
  toString as decToString,
  unitsPurchasable,
} from '../src/index.ts';

const vnd = (n) => mustQuantity(decimal(n), 'currency', 'VND');
const usd = (n) => mustQuantity(decimal(n), 'currency', 'USD');
const units = (n) => mustQuantity(decimal(n), 'units', null);
const ratio = (n) => mustQuantity(decimal(n), 'ratio', null);
const pct = (n) => mustQuantity(decimal(n), 'percentage', null);

const val = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code}`);
  return decToString(r.value.amount);
};
const errOf = (r) => {
  assert.equal(r.ok, false, 'expected a refusal');
  return r.error.code;
};

describe('quantity construction', () => {
  test('a currency amount must carry its currency', () => {
    assert.equal(errOf(quantity(decimal(100), 'currency', null)), QuantityErrors.MISSING_CURRENCY);
  });

  test('a non-currency amount must not carry one', () => {
    assert.equal(errOf(quantity(decimal(5), 'units', 'VND')), QuantityErrors.UNIT_MISMATCH);
  });

  test('mustQuantity throws rather than returning an unusable value', () => {
    assert.throws(() => mustQuantity(decimal(1), 'currency', null), /missing_currency/);
  });
});

describe('addition and subtraction', () => {
  test('same unit and currency adds exactly', () => {
    assert.equal(val(sum(vnd('4200000000'), vnd('3100000000')), 'sum'), '7300000000');
    assert.equal(val(difference(units('12'), units('4')), 'difference'), '8');
  });

  test('different units cannot be added — they measure different things', () => {
    assert.equal(errOf(sum(vnd(100), units(3))), QuantityErrors.UNIT_MISMATCH);
  });

  test('HELM does not invent an FX rate to add two currencies', () => {
    const r = sum(vnd(100), usd(100));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, QuantityErrors.FX_RATE_REQUIRED);
    assert.match(r.error.message, /does not invent FX rates/);
  });

  test('a difference may legitimately go negative', () => {
    assert.equal(val(difference(units('4'), units('12')), 'negative gap'), '-8');
  });
});

describe('scaling', () => {
  test('scaling by a ratio is exact', () => {
    // The canonical case: 4.2B × 0.70. In IEEE-754 the intermediate 0.7 is not
    // 0.7, which is the whole reason this module exists.
    assert.equal(val(scaleByRatio(vnd('4200000000'), ratio('0.7')), 'weighted'), '2940000000');
  });

  test('scaling by a PERCENTAGE is refused — 70 vs 0.7 is a hundredfold error', () => {
    const r = scaleByRatio(vnd('4200000000'), pct(70));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, QuantityErrors.UNIT_MISMATCH);
    assert.match(r.error.message, /hundredfold/);
  });

  test('scaling by a count multiplies a per-unit amount', () => {
    assert.equal(val(scaleByCount(vnd('217000000'), units('8.4')), 'cogs'), '1822800000');
  });

  test('scaling by a count refuses anything that is not a count', () => {
    assert.equal(errOf(scaleByCount(vnd(100), ratio('0.5'))), QuantityErrors.UNIT_MISMATCH);
  });
});

describe('division', () => {
  test('ratio and percentage are distinct results, not two spellings of one', () => {
    assert.equal(val(ratioOf(vnd('1117200000'), vnd('2940000000')), 'ratio'), '0.38');
    assert.equal(val(percentageOf(vnd('1117200000'), vnd('2940000000')), 'percentage'), '38');
  });

  test('dividing by zero is refused, not infinite', () => {
    assert.equal(errOf(ratioOf(vnd(100), vnd(0))), QuantityErrors.DIVIDE_BY_ZERO);
    assert.equal(errOf(unitsPurchasable(vnd(100), vnd(0))), QuantityErrors.DIVIDE_BY_ZERO);
  });

  test('money ÷ price-per-unit gives units, exactly', () => {
    assert.equal(
      val(unitsPurchasable(vnd('2940000000'), vnd('350000000')), 'units'),
      '8.4',
      'fractional on purpose: 8.4 is the expected value, not a shipment',
    );
  });

  test('money ÷ price refuses two different currencies', () => {
    assert.equal(
      errOf(unitsPurchasable(vnd('2940000000'), usd('15000'))),
      QuantityErrors.FX_RATE_REQUIRED,
    );
  });

  test('money ÷ price refuses non-currency operands', () => {
    assert.equal(errOf(unitsPurchasable(units(10), vnd(5))), QuantityErrors.UNIT_MISMATCH);
  });
});

describe('comparison and flooring', () => {
  test('atLeastZero floors where a negative has no business meaning', () => {
    assert.equal(decToString(atLeastZero(units('-3')).amount), '0');
    assert.equal(decToString(atLeastZero(units('3')).amount), '3');
  });

  test('max and min keep the unit', () => {
    const m = maxOf(units('8.4'), units('12'));
    assert.equal(val(m, 'max'), '12');
    assert.equal(m.value.unit, 'units');
    assert.equal(val(minOf(units('8.4'), units('12')), 'min'), '8.4');
  });

  test('comparison across currencies still needs a rate', () => {
    assert.equal(errOf(maxOf(vnd(1), usd(1))), QuantityErrors.FX_RATE_REQUIRED);
  });
});

describe('formatting', () => {
  test('a bare number never appears — every rendering carries its unit', () => {
    assert.equal(formatQuantity(vnd('2940000000')), '2940000000 VND');
    assert.equal(formatQuantity(pct('33.238095238095')), '33.238095238095%');
    assert.equal(formatQuantity(units('8.4')), '8.4 units');
    assert.equal(formatQuantity(ratio('0.7')), '0.7');
  });
});
