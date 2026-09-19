import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asValidTime,
  asRecordTime,
  chainConfidence,
  clampConfidence,
  fixedClock,
  isCurrent,
  isValidAt,
  overlaps,
  seqIdGen,
  wasRecordedAt,
  isCurrentRecord,
} from '../src/temporal.ts';
import { all, fail, flatMap, isErr, isOk, map, ok, unwrap, unwrapOr } from '../src/result.ts';

const w = (from, to) => ({
  validFrom: asValidTime(from),
  validTo: to === null ? null : asValidTime(to),
});

describe('valid time', () => {
  test('a half-open window includes its start and excludes its end', () => {
    const jan_jun = w('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    assert.equal(isValidAt(jan_jun, '2026-01-01T00:00:00.000Z'), true, 'start is inside');
    assert.equal(isValidAt(jan_jun, '2026-03-15T00:00:00.000Z'), true);
    assert.equal(isValidAt(jan_jun, '2026-07-01T00:00:00.000Z'), false, 'end is outside');
    assert.equal(isValidAt(jan_jun, '2025-12-31T23:59:59.000Z'), false);
  });

  test('an open-ended window is currently true', () => {
    const open = w('2026-01-01T00:00:00.000Z', null);
    assert.equal(isCurrent(open), true);
    assert.equal(isValidAt(open, '2099-01-01T00:00:00.000Z'), true);
    assert.equal(isCurrent(w('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')), false);
  });

  test('an invalid date is never valid rather than throwing', () => {
    assert.equal(isValidAt(w('2026-01-01T00:00:00.000Z', null), 'not-a-date'), false);
  });

  test('overlap detection treats open windows as unbounded', () => {
    const a = w('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    const b = w('2026-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    const c = w('2026-06-01T00:00:00.000Z', null);
    assert.equal(overlaps(a, b), true, 'May is in both');
    assert.equal(overlaps(a, c), false, 'a ends exactly where c starts — half-open');
    assert.equal(overlaps(b, c), true);
  });
});

describe('record time', () => {
  test('distinguishes what we believed then from what we believe now', () => {
    // Believed v1 from Aug 1 to Aug 20, then v2 from Aug 20 onwards.
    const v1 = { recordedFrom: asRecordTime('2026-08-01T00:00:00.000Z'), recordedTo: asRecordTime('2026-08-20T00:00:00.000Z') };
    const v2 = { recordedFrom: asRecordTime('2026-08-20T00:00:00.000Z'), recordedTo: null };

    assert.equal(wasRecordedAt(v1, '2026-08-10T00:00:00.000Z'), true);
    assert.equal(wasRecordedAt(v2, '2026-08-10T00:00:00.000Z'), false);
    assert.equal(wasRecordedAt(v2, '2026-09-01T00:00:00.000Z'), true);
    assert.equal(isCurrentRecord(v2), true);
    assert.equal(isCurrentRecord(v1), false);
  });
});

describe('confidence', () => {
  test('clamps to 0..1 and treats non-finite as zero', () => {
    assert.equal(clampConfidence(0.5), 0.5);
    assert.equal(clampConfidence(-1), 0);
    assert.equal(clampConfidence(3), 1);
    assert.equal(clampConfidence(Number.NaN), 0);
  });

  test('a chain is never more confident than its weakest link', () => {
    assert.equal(chainConfidence([1, 1, 1]), 1);
    assert.equal(Math.round(chainConfidence([0.9, 0.7]) * 100) / 100, 0.63);
    // The management point: a long chain degrades, it never recovers.
    const long = chainConfidence([0.9, 0.9, 0.9, 0.9, 0.9]);
    assert.ok(long < 0.6, `five 0.9 links should fall below 0.6, got ${long}`);
    assert.equal(chainConfidence([]), 1, 'no links = no degradation');
  });

  test('a missing confidence is treated as certain, not as zero', () => {
    assert.equal(chainConfidence([0.5, null, undefined]), 0.5);
  });
});

describe('deterministic ports', () => {
  test('fixedClock and seqIdGen make tests reproducible', () => {
    const clock = fixedClock('2026-09-19T08:00:00.000Z');
    assert.equal(clock.now().toISOString(), '2026-09-19T08:00:00.000Z');
    assert.equal(clock.now().toISOString(), '2026-09-19T08:00:00.000Z', 'does not advance');

    const ids = seqIdGen('e');
    assert.equal(ids.next(), 'e-000001');
    assert.equal(ids.next(), 'e-000002');
  });
});

describe('Result', () => {
  test('ok and err are distinguishable without throwing', () => {
    const good = ok(42);
    const bad = fail('test.code', 'a message', { x: 1 });
    assert.equal(isOk(good), true);
    assert.equal(isErr(bad), true);
    assert.equal(unwrap(good), 42);
    assert.equal(unwrapOr(bad, 7), 7);
    if (!bad.ok) {
      assert.equal(bad.error.code, 'test.code');
      assert.deepEqual(bad.error.details, { x: 1 });
    }
  });

  test('map and flatMap short-circuit on error', () => {
    const bad = fail('x', 'y');
    assert.equal(isErr(map(bad, (v) => v)), true);
    assert.equal(unwrap(map(ok(2), (v) => v * 3)), 6);
    assert.equal(unwrap(flatMap(ok(2), (v) => ok(v + 1))), 3);
    assert.equal(isErr(flatMap(ok(2), () => fail('a', 'b'))), true);
  });

  test('all collects values and fails on the first error', () => {
    assert.deepEqual(unwrap(all([ok(1), ok(2)])), [1, 2]);
    const r = all([ok(1), fail('bad', 'nope'), ok(3)]);
    assert.equal(isErr(r), true);
    if (!r.ok) assert.equal(r.error.code, 'bad');
  });

  test('unwrap on an error throws — it is for tests, not for control flow', () => {
    assert.throws(() => unwrap(fail('boom', 'no')), /unwrap\(\) on an error Result/);
  });
});
