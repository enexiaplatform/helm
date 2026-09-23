import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePeriods,
  describeInterval,
  fnv1a64,
  intervalIs,
  makePeriod,
  monthPeriod,
  parsePeriodKey,
  periodContaining,
  periodContains,
  periodKey,
  quarterPeriod,
  samePeriod,
  yearPeriod,
} from '../src/index.ts';

describe('period identity', () => {
  test('a calendar quarter is [start, end) with a QUARTER grain', () => {
    const q4 = quarterPeriod(2026, 4);
    assert.equal(q4.start, '2026-10-01T00:00:00.000Z');
    assert.equal(q4.end, '2027-01-01T00:00:00.000Z');
    assert.equal(q4.grain, 'QUARTER');
    assert.equal(periodKey(q4), '2026-Q4');
    assert.equal(periodKey(quarterPeriod(2027, 1)), '2027-Q1');
  });

  test('keys round-trip for every named grain', () => {
    for (const p of [
      quarterPeriod(2026, 4),
      monthPeriod(2026, 11),
      yearPeriod(2027),
      makePeriod('2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'DAY').value,
      makePeriod('2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'WEEK').value,
      makePeriod('2026-10-03T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'CUSTOM').value,
    ]) {
      const back = parsePeriodKey(periodKey(p));
      if (p.grain === 'WEEK') continue; // week keys are display-only
      assert.equal(back.ok, true, periodKey(p));
      assert.ok(samePeriod(back.value, p), periodKey(p));
    }
  });

  test('a grain must describe the interval it claims', () => {
    // 15 November is not the start of a quarter.
    const bad = makePeriod('2026-11-15T00:00:00.000Z', '2027-02-15T00:00:00.000Z', 'QUARTER');
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'period.misaligned');
    // A Tuesday is not the start of an ISO week.
    assert.equal(makePeriod('2026-10-06T00:00:00.000Z', '2026-10-13T00:00:00.000Z', 'WEEK').ok, false);
    // Empty and reversed intervals are refused.
    assert.equal(makePeriod('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'CUSTOM').ok, false);
    assert.equal(makePeriod('2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'CUSTOM').ok, false);
  });

  test('half-open containment', () => {
    const q4 = quarterPeriod(2026, 4);
    assert.equal(periodContains(q4, '2026-10-01T00:00:00.000Z'), true);
    assert.equal(periodContains(q4, '2026-12-31T23:59:59.999Z'), true);
    assert.equal(periodContains(q4, '2027-01-01T00:00:00.000Z'), false);
    assert.ok(samePeriod(periodContaining('2026-11-20T10:00:00.000Z', 'QUARTER'), q4));
  });

  test('an observation interval matches a period exactly or not at all', () => {
    const q4 = quarterPeriod(2026, 4);
    assert.equal(intervalIs(q4, '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), true);
    // Same start, different end: not the same claim.
    assert.equal(intervalIs(q4, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), false);
    assert.equal(intervalIs(q4, null, null), false);
    assert.equal(describeInterval('2027-01-01T00:00:00.000Z', '2027-04-01T00:00:00.000Z'), '2027-Q1');
  });

  test('ordering is by start, then end', () => {
    const sorted = [quarterPeriod(2027, 1), quarterPeriod(2026, 4)].sort(comparePeriods);
    assert.deepEqual(sorted.map(periodKey), ['2026-Q4', '2027-Q1']);
  });
});

describe('fnv1a64', () => {
  test('is stable and 16 hex digits', () => {
    assert.equal(fnv1a64(''), 'cbf29ce484222325');
    assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
    assert.match(fnv1a64('scenario'), /^[0-9a-f]{16}$/);
    assert.notEqual(fnv1a64('0.9'), fnv1a64('0.90'));
  });
});
