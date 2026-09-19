/**
 * Temporal primitives — the two time dimensions HELM keeps separate.
 *
 * See ADR-0014. The distinction is load-bearing and easy to get wrong by one
 * character, so the two are branded: the compiler rejects passing a record time
 * where a valid time belongs.
 *
 *   VALID time  — when a fact is true in the world.
 *                 "She was BU Head from January to June."
 *   RECORD time — when HELM came to know it.
 *                 "We learned this in August."
 */

declare const timeBrand: unique symbol;

/** ISO-8601 instant, tagged with the dimension it belongs to. */
export type Instant<D extends string> = string & { readonly [timeBrand]: D };

export type ValidTime = Instant<'valid'>;
export type RecordTime = Instant<'record'>;

export const asValidTime = (iso: string): ValidTime => iso as ValidTime;
export const asRecordTime = (iso: string): RecordTime => iso as RecordTime;

/** A half-open valid-time window: [from, to). `to === null` means "still true". */
export type ValidityWindow = {
  validFrom: ValidTime;
  validTo: ValidTime | null;
};

/** A half-open record-time window: when HELM believed a given version. */
export type RecordWindow = {
  recordedFrom: RecordTime;
  recordedTo: RecordTime | null;
};

export type Horizon = 'current' | 'month' | 'quarter' | 'year';

/** 0..1. A derived value is never more confident than its weakest input. */
export type Confidence = number;

export const clampConfidence = (v: number): Confidence =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

/**
 * Confidence of a chain. The product, so a long path is never highly confident
 * — computed here rather than per-adapter so every caller agrees.
 */
export function chainConfidence(values: readonly (number | null | undefined)[]): Confidence {
  let acc = 1;
  for (const v of values) {
    acc *= clampConfidence(v ?? 1);
  }
  return clampConfidence(acc);
}

// ---------------------------------------------------------------- valid time

/** Is the window open at `at`? Half-open: `validTo` itself is excluded. */
export function isValidAt(w: ValidityWindow, at: Date | string): boolean {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return false;
  const from = new Date(w.validFrom).getTime();
  if (Number.isNaN(from) || t < from) return false;
  if (w.validTo === null) return true;
  const to = new Date(w.validTo).getTime();
  return Number.isNaN(to) ? true : t < to;
}

/** Currently true, i.e. open-ended. The common "give me the live graph" case. */
export const isCurrent = (w: ValidityWindow): boolean => w.validTo === null;

/** Do two validity windows overlap at all? Used to detect conflicting facts. */
export function overlaps(a: ValidityWindow, b: ValidityWindow): boolean {
  const aFrom = new Date(a.validFrom).getTime();
  const bFrom = new Date(b.validFrom).getTime();
  const aTo = a.validTo === null ? Infinity : new Date(a.validTo).getTime();
  const bTo = b.validTo === null ? Infinity : new Date(b.validTo).getTime();
  return aFrom < bTo && bFrom < aTo;
}

// --------------------------------------------------------------- record time

/** Which version was believed at `at`? Half-open, same convention. */
export function wasRecordedAt(w: RecordWindow, at: Date | string): boolean {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return false;
  const from = new Date(w.recordedFrom).getTime();
  if (Number.isNaN(from) || t < from) return false;
  if (w.recordedTo === null) return true;
  const to = new Date(w.recordedTo).getTime();
  return Number.isNaN(to) ? true : t < to;
}

/** The current belief, i.e. the open version in the chain. */
export const isCurrentRecord = (w: RecordWindow): boolean => w.recordedTo === null;

// -------------------------------------------------------------------- shared

export const toIso = (d: Date | string): string =>
  typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();

/**
 * Ports for time and identity. Kernel code never reads an ambient clock or
 * calls `crypto.randomUUID()` directly — both make tests non-deterministic and
 * are what `verify:architecture` forbids.
 */
export interface Clock {
  now(): Date;
}

export interface IdGen {
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const uuidIdGen: IdGen = { next: () => crypto.randomUUID() };

/** Deterministic test doubles. Exported so every package tests the same way. */
export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export function seqIdGen(prefix = 'id'): IdGen {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${String(n).padStart(6, '0')}`;
    },
  };
}
