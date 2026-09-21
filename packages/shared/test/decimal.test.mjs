import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decimal, add, subtract, multiply, divide, round, toString, toNumber,
  compare, equals, min, max, sumAll, negate, abs, isZero, isNegative,
  ZERO, ONE, DECIMAL_SCALE,
} from '../src/decimal.ts';

const s = (d) => toString(d);

describe('decimal — the float traps that motivated it', () => {
  test('expected demand: 12 units x 0.7 is 8.4, not 8.399999999999999', () => {
    // This is the canonical demand calculation, and the place float actually
    // fails in HELM's own model.
    assert.equal(s(multiply(decimal('12'), decimal('0.7'))), '8.4');
    assert.notEqual(12 * 0.7, 8.4, 'float really does get this one wrong');
  });

  test('large currency products stay exact too', () => {
    // Note: this one float also gets right. Exactness in float is unpredictable,
    // which is the argument — not that float is always wrong.
    assert.equal(s(multiply(decimal('4200000000'), decimal('0.7'))), '2940000000');
  });

  test('repeated addition does not drift', () => {
    let acc = ZERO;
    for (let i = 0; i < 10; i += 1) acc = add(acc, decimal('0.1'));
    assert.equal(s(acc), '1');
    let f = 0;
    for (let i = 0; i < 10; i += 1) f += 0.1;
    assert.notEqual(f, 1, 'float drifts over ten additions');
  });

  test('0.1 + 0.2 is 0.3', () => {
    assert.equal(s(add(decimal('0.1'), decimal('0.2'))), '0.3');
  });

  test('addition is associative, unlike floats', () => {
    const a = decimal('0.1'), b = decimal('0.2'), c = decimal('0.3');
    assert.equal(s(add(add(a, b), c)), s(add(a, add(b, c))));
  });

  test('the canonical chain divides exactly', () => {
    // 2.94B / 350M = 8.4 units
    assert.equal(s(divide(decimal('2940000000'), decimal('350000000'))), '8.4');
  });
});

describe('decimal construction', () => {
  test('parses strings, numbers, bigints', () => {
    assert.equal(s(decimal('12.345')), '12.345');
    assert.equal(s(decimal(12.5)), '12.5');
    assert.equal(s(decimal(42n)), '42');
    assert.equal(s(decimal('-0.75')), '-0.75');
    assert.equal(s(decimal('0')), '0');
  });

  test('handles exponential JS numbers', () => {
    assert.equal(s(decimal(4.2e9)), '4200000000');
    assert.equal(s(decimal(1e-6)), '0.000001');
  });

  test('rounds half-up at the precision limit rather than truncating', () => {
    // Derived from DECIMAL_SCALE rather than written out: a test that hard-codes
    // the scale stops testing the rule the moment the scale changes.
    const oneUlp = `0.${'0'.repeat(DECIMAL_SCALE - 1)}1`;
    const tooPrecise = `0.${'0'.repeat(DECIMAL_SCALE)}5`;
    assert.equal(s(decimal(tooPrecise)), oneUlp, 'half-up at the last digit');
    assert.equal(s(decimal(`0.${'0'.repeat(DECIMAL_SCALE)}4`)), '0', 'below half rounds away');
  });

  test('rejects nonsense', () => {
    assert.throws(() => decimal('abc'), SyntaxError);
    assert.throws(() => decimal(''), SyntaxError);
    assert.throws(() => decimal(Number.NaN), RangeError);
    assert.throws(() => decimal(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe('decimal arithmetic', () => {
  test('subtraction and negation', () => {
    assert.equal(s(subtract(decimal('10'), decimal('3.5'))), '6.5');
    assert.equal(s(negate(decimal('2.5'))), '-2.5');
    assert.equal(s(abs(decimal('-2.5'))), '2.5');
  });

  test('division rounds half-up in both signs', () => {
    const third = `0.${'3'.repeat(DECIMAL_SCALE)}`;
    // Two thirds ends in a 7 because the digit past the limit is a 6.
    const twoThirds = `0.${'6'.repeat(DECIMAL_SCALE - 1)}7`;
    assert.equal(s(divide(decimal('1'), decimal('3'))), third);
    assert.equal(s(divide(decimal('2'), decimal('3'))), twoThirds);
    assert.equal(s(divide(decimal('-2'), decimal('3'))), `-${twoThirds}`);
  });

  test('the internal scale carries a non-terminating division far enough that ' +
    'multiplying it back does not move the business answer', () => {
    // The Phase 3 defect, as a unit test. 1.395B / 350M is 279/70, which does
    // not terminate; multiplying the rounded quotient by a unit cost amplifies
    // whatever residue the scale left behind.
    const quotient = divide(decimal('1395000000'), decimal('350000000'));
    const scaled = multiply(add(decimal('8.4'), quotient), decimal('217000000'));
    // The exact answer is 867/70 x 217000000 = 2687700000, remainder zero.
    const drift = Math.abs(Number(s(scaled)) - 2687700000);
    assert.ok(
      drift < 1e-9,
      `residue amplified to ${drift}; at scale 12 this was 6.2e-5, which is why ` +
        'the internal scale is not the storage scale',
    );
  });

  test('division by zero throws rather than producing Infinity', () => {
    assert.throws(() => divide(decimal('1'), ZERO), RangeError);
  });

  test('rounding modes', () => {
    assert.equal(s(round(decimal('2.5'), 0, 'half-up')), '3');
    assert.equal(s(round(decimal('3.5'), 0, 'half-even')), '4');
    assert.equal(s(round(decimal('2.5'), 0, 'half-even')), '2');
    assert.equal(s(round(decimal('2.9'), 0, 'down')), '2');
    assert.equal(s(round(decimal('2.1'), 0, 'up')), '3');
    assert.equal(s(round(decimal('-2.5'), 0, 'half-up')), '-3');
    assert.equal(s(round(decimal('1.23456'), 2)), '1.23');
    assert.equal(s(round(decimal('1.23556'), 2)), '1.24');
  });

  test('comparison and aggregation', () => {
    assert.equal(compare(decimal('1'), decimal('2')), -1);
    assert.equal(compare(decimal('2'), decimal('2')), 0);
    assert.equal(compare(decimal('3'), decimal('2')), 1);
    assert.equal(equals(decimal('2.50'), decimal('2.5')), true);
    assert.equal(s(min(decimal('1'), decimal('2'))), '1');
    assert.equal(s(max(decimal('1'), decimal('2'))), '2');
    assert.equal(s(sumAll([decimal('1.1'), decimal('2.2'), decimal('3.3')])), '6.6');
    assert.equal(s(sumAll([])), '0');
    assert.equal(isZero(ZERO), true);
    assert.equal(isNegative(decimal('-0.01')), true);
    assert.equal(s(ONE), '1');
  });

  test('large VND magnitudes stay exact', () => {
    const big = decimal('18600000000');
    assert.equal(s(multiply(big, decimal('0.38'))), '7068000000');
    assert.equal(s(add(big, decimal('0.000000000001'))), '18600000000.000000000001');
  });
});

describe('decimal presentation', () => {
  test('toString is the canonical exact form', () => {
    assert.equal(s(decimal('1.500')), '1.5');
    assert.equal(s(decimal('-0.0')), '0');
  });

  test('toNumber is the lossy display exit', () => {
    assert.equal(toNumber(decimal('2940000000')), 2_940_000_000);
    assert.equal(toNumber(decimal('8.4')), 8.4);
  });
});
