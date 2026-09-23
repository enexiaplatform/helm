/**
 * Period identity — which stretch of business time a number is about.
 *
 * A forecast for 2026-Q4 and a forecast for 2027-Q1 are two different claims
 * about two different quarters. Before period identity existed, a read that
 * wanted "the forecast" would pick the one whose period started latest, so a
 * node carrying both answered every question with next year's number. A period
 * makes the question explicit: the caller says WHICH quarter, and only a claim
 * about that quarter answers it.
 *
 * Deliberately not a time-series engine. A Period is a half-open interval
 * [start, end) with a grain that says how it was cut. Nothing here rolls up,
 * splits or interpolates between periods — combining periods is a modelling
 * decision, and the absence of such helpers is what keeps it one.
 */

import { fail, ok, type Result } from './result.ts';

export const periodGrains = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM'] as const;
export type PeriodGrain = (typeof periodGrains)[number];

/** A half-open interval of business (valid) time: [start, end). */
export type Period = {
  /** ISO-8601 instant, inclusive. */
  readonly start: string;
  /** ISO-8601 instant, exclusive. */
  readonly end: string;
  readonly grain: PeriodGrain;
};

export const PeriodErrors = {
  INVALID_PERIOD: 'period.invalid',
  MISALIGNED_PERIOD: 'period.misaligned',
} as const;

const iso = (d: Date): string => d.toISOString();
const utc = (y: number, m: number, d = 1): Date => new Date(Date.UTC(y, m, d));

/**
 * Builds a period and checks that it is what its grain claims. A "QUARTER"
 * that starts on 15 November is not a quarter, and letting it through would
 * make two periods that mean the same thing compare unequal.
 */
export function makePeriod(start: string | Date, end: string | Date, grain: PeriodGrain): Result<Period> {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return fail(PeriodErrors.INVALID_PERIOD, 'A period needs a valid start and end instant.');
  }
  if (e.getTime() <= s.getTime()) {
    return fail(PeriodErrors.INVALID_PERIOD, 'A period must end after it starts.');
  }
  if (!(periodGrains as readonly string[]).includes(grain)) {
    return fail(PeriodErrors.INVALID_PERIOD, `Unknown period grain "${grain}".`);
  }
  if (grain !== 'CUSTOM') {
    const expected = calendarPeriodStarting(s, grain);
    if (!expected || expected.start !== iso(s) || expected.end !== iso(e)) {
      return fail(
        PeriodErrors.MISALIGNED_PERIOD,
        `${iso(s)} – ${iso(e)} is not a calendar ${grain.toLowerCase()} (UTC). ` +
          'Use CUSTOM for an arbitrary window.',
      );
    }
  }
  return ok({ start: iso(s), end: iso(e), grain });
}

/** Throwing variant for fixtures and constants whose correctness is static. */
export function mustPeriod(start: string | Date, end: string | Date, grain: PeriodGrain): Period {
  const r = makePeriod(start, end, grain);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The calendar period of `grain` that starts exactly at `start`, or null if none does. */
function calendarPeriodStarting(start: Date, grain: Exclude<PeriodGrain, 'CUSTOM'>): Period | null {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  const midnight =
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0;
  if (!midnight) return null;
  switch (grain) {
    case 'DAY':
      return { start: iso(start), end: iso(utc(y, m, d + 1)), grain };
    case 'WEEK':
      // ISO weeks start on Monday.
      if (start.getUTCDay() !== 1) return null;
      return { start: iso(start), end: iso(utc(y, m, d + 7)), grain };
    case 'MONTH':
      if (d !== 1) return null;
      return { start: iso(start), end: iso(utc(y, m + 1)), grain };
    case 'QUARTER':
      if (d !== 1 || m % 3 !== 0) return null;
      return { start: iso(start), end: iso(utc(y, m + 3)), grain };
    case 'YEAR':
      if (d !== 1 || m !== 0) return null;
      return { start: iso(start), end: iso(utc(y + 1, 0)), grain };
  }
}

/** Calendar quarter `q` (1–4) of `year`, UTC. */
export function quarterPeriod(year: number, q: 1 | 2 | 3 | 4): Period {
  return mustPeriod(utc(year, (q - 1) * 3), utc(year, q * 3), 'QUARTER');
}

/** Calendar month `month` (1–12) of `year`, UTC. */
export function monthPeriod(year: number, monthOfYear: number): Period {
  return mustPeriod(utc(year, monthOfYear - 1), utc(year, monthOfYear), 'MONTH');
}

/** Calendar year, UTC. */
export function yearPeriod(y: number): Period {
  return mustPeriod(utc(y, 0), utc(y + 1, 0), 'YEAR');
}

/**
 * A stable, human-readable identity: `2026-Q4`, `2026-10`, `2026`,
 * `2026-10-05`, `2026-W41`, or `2026-10-01T00:00:00.000Z..2026-10-31T00:00:00.000Z`
 * for a custom window. Two periods are the same period exactly when their keys
 * are equal.
 */
export function periodKey(p: Period): string {
  const s = new Date(p.start);
  const y = s.getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (p.grain) {
    case 'YEAR':
      return `${y}`;
    case 'QUARTER':
      return `${y}-Q${Math.floor(s.getUTCMonth() / 3) + 1}`;
    case 'MONTH':
      return `${y}-${pad(s.getUTCMonth() + 1)}`;
    case 'DAY':
      return `${y}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
    case 'WEEK':
      return `${isoWeekYear(s)}-W${pad(isoWeek(s))}`;
    case 'CUSTOM':
      return `${p.start}..${p.end}`;
  }
}

/** Parses a key produced by `periodKey`. */
export function parsePeriodKey(key: string): Result<Period> {
  let m: RegExpMatchArray | null;
  if ((m = key.match(/^(\d{4})-Q([1-4])$/))) {
    return ok(quarterPeriod(Number(m[1]), Number(m[2]) as 1 | 2 | 3 | 4));
  }
  if ((m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const s = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return makePeriod(s, utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1), 'DAY');
  }
  if ((m = key.match(/^(\d{4})-(\d{2})$/))) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return fail(PeriodErrors.INVALID_PERIOD, `Bad month in "${key}".`);
    return ok(monthPeriod(Number(m[1]), mo));
  }
  if ((m = key.match(/^(\d{4})$/))) return ok(yearPeriod(Number(m[1])));
  if ((m = key.match(/^(.+)\.\.(.+)$/))) return makePeriod(m[1], m[2], 'CUSTOM');
  return fail(PeriodErrors.INVALID_PERIOD, `"${key}" is not a period key.`);
}

/** Same interval, same grain. */
export function samePeriod(a: Period, b: Period): boolean {
  return (
    new Date(a.start).getTime() === new Date(b.start).getTime() &&
    new Date(a.end).getTime() === new Date(b.end).getTime() &&
    a.grain === b.grain
  );
}

/**
 * Does an observation's stored interval denote exactly this period? The grain
 * is not stored on an observation, so this compares the interval only — which
 * is the right question: a 2026-Q4 forecast is a claim about [Oct 1, Jan 1)
 * however the caller happens to name that interval.
 */
export function intervalIs(p: Period, start: string | null, end: string | null): boolean {
  if (start === null || end === null) return false;
  return (
    new Date(start).getTime() === new Date(p.start).getTime() &&
    new Date(end).getTime() === new Date(p.end).getTime()
  );
}

/** Is `at` inside [start, end)? */
export function periodContains(p: Period, at: string | Date): boolean {
  const t = new Date(at).getTime();
  return t >= new Date(p.start).getTime() && t < new Date(p.end).getTime();
}

/** Deterministic ordering: by start, then end. */
export function comparePeriods(a: Period, b: Period): number {
  return (
    new Date(a.start).getTime() - new Date(b.start).getTime() ||
    new Date(a.end).getTime() - new Date(b.end).getTime()
  );
}

/** The calendar period of `grain` that contains `at` (UTC). */
export function periodContaining(at: string | Date, grain: Exclude<PeriodGrain, 'CUSTOM' | 'WEEK' | 'DAY'>): Period {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  if (grain === 'YEAR') return yearPeriod(y);
  if (grain === 'MONTH') return monthPeriod(y, d.getUTCMonth() + 1);
  return quarterPeriod(y, (Math.floor(d.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4);
}

/** A readable label for an interval that may not be a named period. */
export function describeInterval(start: string | null, end: string | null): string {
  if (!start || !end) return 'a point in time';
  for (const grain of ['QUARTER', 'MONTH', 'YEAR', 'DAY'] as const) {
    const r = makePeriod(start, end, grain);
    if (r.ok) return periodKey(r.value);
  }
  return `${start}..${end}`;
}

function isoWeek(d: Date): number {
  const t = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = utc(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function isoWeekYear(d: Date): number {
  const t = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return t.getUTCFullYear();
}
