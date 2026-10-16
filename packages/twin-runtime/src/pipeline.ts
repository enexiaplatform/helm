/**
 * The commercial pipeline as a twin state holds it — a READING of items already composed, never a new fact.
 *
 * One row per opportunity the reader may see: the customer that holds it, its stage and expected close period as the
 * source states them, its value and probability (source facts) and its expected revenue (a model result), each as the
 * state carries it. Rows are in KERNEL order (the state's own item order); nothing is ranked, scored, weighted or
 * recommended, and a filter is a named condition, never a judgement of which deal matters most.
 *
 * Audit 2026-10-12: a manager asked "which opportunities are at risk of not closing this quarter?" and HELM had no way
 * to read its own hundred opportunities back; the same labels ("Canister / Tailin / Cons", four times) named no customer.
 */

import type { TwinItem } from './types.ts';

export type PipelinePosition = {
  readonly opportunityId: string;
  readonly opportunity: string;
  /** The customer that holds it (HELD_BY), or null when the state names none. */
  readonly customer: string | null;
  readonly customerClass: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  /** Read from stage and status: whether the deal is still open, won, lost or on hold. */
  readonly state: DealState;
  readonly expectedClosePeriod: string | null;
  /** The principal (brand) the source states for the deal, or null. */
  readonly brand: string | null;
  readonly channel: string | null;
  /** When the source last recorded a touch on the deal (ISO), or null. */
  readonly lastTouchAt: string | null;
  /** The next step the source states for the deal (a date), or null. */
  readonly nextActionDate: string | null;
  /** When the source last changed the deal (ISO), or null when the state does not carry it. */
  readonly sourceUpdatedAt: string | null;
  /** When the source records the deal as closed, or null. */
  readonly closedOn: string | null;
  /** The deal's id in its source system, for a link back to it; null when the state does not carry it. */
  readonly sourceId: string | null;
  /** Source fact: the opportunity's value, as a decimal string, or null when the source states none. */
  readonly value: string | null;
  readonly currency: string | null;
  /** Source fact: a ratio between 0 and 1, or null when the source states none. */
  readonly probability: string | null;
  /** Model result, per period the state holds it for. */
  readonly expectedRevenue: readonly { readonly period: string | null; readonly value: string | null; readonly currency: string | null }[];
};

export type PipelineFacts = {
  readonly opportunities: number;
  readonly withValue: number;
  readonly zeroValue: number;
  readonly noValue: number;
  readonly noProbability: number;
  /** Both a value and a probability: what the model computes expected revenue for. */
  readonly modelled: number;
  readonly withoutCustomer: number;
  readonly noClosePeriod: number;
  /** Opportunities whose value the reader may not read: withheld above their clearance, never counted as missing. */
  readonly valueWithheld: number;
  /** Opportunities whose probability the reader may not read. */
  readonly probabilityWithheld: number;
};

/** Which of the commercial readings the reader is cleared for. A reading above clearance is withheld, not absent. */
export type PipelineReadable = { readonly value: boolean; readonly probability: boolean };

/** Opportunity and its seeded subtype: a tender is an opportunity (packages/ontology seed). */
const OPPORTUNITY_TYPES: ReadonlySet<string> = new Set(['Opportunity', 'Tender']);

const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** "memoire:opportunity:<id>" → "<id>": the source id a canonical key carries. */
const sourceIdOf = (canonicalKey: string): string | null => {
  const m = canonicalKey.match(/^[a-z]+:opportunity:(.+)$/);
  return m ? m[1]! : null;
};

/** Every opportunity of the state, with what the state says about it, in the state's own order. */
export function readPipeline(items: readonly TwinItem[]): PipelinePosition[] {
  const entities = new Map<string, TwinItem>();
  for (const i of items) if (i.kind === 'ENTITY' && i.subjectEntityId) entities.set(i.subjectEntityId, i);
  const heldBy = new Map<string, string>();
  for (const i of items) {
    if (i.kind !== 'RELATIONSHIP' || i.state['type'] !== 'HELD_BY') continue;
    heldBy.set(String(i.state['sourceEntityId']), String(i.state['targetEntityId']));
  }
  const values = new Map<string, TwinItem[]>();
  for (const i of items) {
    if (i.kind !== 'VALUE' || !i.subjectEntityId) continue;
    values.set(i.subjectEntityId, [...(values.get(i.subjectEntityId) ?? []), i]);
  }
  const reading = (id: string, metricKey: string, layer: string) => values.get(id)?.filter((v) => v.state['metricKey'] === metricKey && v.layer === layer) ?? [];

  const out: PipelinePosition[] = [];
  for (const e of entities.values()) {
    if (!OPPORTUNITY_TYPES.has(String(e.state['entityTypeKey']))) continue;
    const id = e.subjectEntityId!;
    const attrs = (e.state['attributes'] ?? {}) as Record<string, unknown>;
    const cust = heldBy.has(id) ? entities.get(heldBy.get(id)!) ?? null : null;
    const val = reading(id, 'OpportunityValue', 'ACTUAL')[0] ?? null;
    const prob = reading(id, 'OpportunityProbability', 'ACTUAL')[0] ?? null;
    out.push({
      opportunityId: id,
      opportunity: String(e.state['name'] ?? e.label),
      customer: cust ? String(cust.state['name'] ?? cust.label) : null,
      customerClass: cust ? s(cust.state['classification']) : null,
      stage: s(attrs['stage']),
      status: s(attrs['status']),
      state: dealStateOf(s(attrs['stage']), s(attrs['status'])),
      expectedClosePeriod: s(attrs['expectedClosePeriod']),
      brand: s(attrs['brand']),
      channel: s(attrs['channel']),
      lastTouchAt: s(attrs['lastTouchAt']),
      nextActionDate: s(attrs['nextActionDate']),
      sourceUpdatedAt: s(attrs['sourceUpdatedAt']),
      closedOn: s(attrs['closedOn']),
      sourceId: s(attrs['sourceId']) ?? sourceIdOf(String(e.state['canonicalKey'] ?? '')),
      value: val ? s(val.state['value']) : null,
      currency: val ? s(val.state['currency']) : null,
      probability: prob ? s(prob.state['value']) : null,
      expectedRevenue: reading(id, 'ExpectedRevenue', 'MODELLED').map((r) => ({ period: s(r.state['period']), value: s(r.state['value']), currency: s(r.state['currency']) })),
    });
  }
  return out;
}

/**
 * What the pipeline as read states about its own completeness — counts of facts, never a score.
 *
 * A reader without clearance for a commercial reading sees no value item for it; that is a withheld reading, not a
 * missing one, and it is counted apart (audit 2026-10-13: an analyst was told "2 state no value at all" and asked to
 * correct Memoire, about values that were only above their clearance).
 */
export function pipelineFacts(rows: readonly PipelinePosition[], readable: PipelineReadable = { value: true, probability: true }): PipelineFacts {
  const withValue = rows.filter((r) => r.value !== null);
  const missingValue = rows.length - withValue.length;
  const missingProbability = rows.filter((r) => r.probability === null).length;
  return {
    opportunities: rows.length,
    withValue: withValue.length,
    zeroValue: withValue.filter((r) => Number(r.value) === 0).length,
    noValue: readable.value ? missingValue : 0,
    noProbability: readable.probability ? missingProbability : 0,
    modelled: rows.filter((r) => r.value !== null && r.probability !== null).length,
    withoutCustomer: rows.filter((r) => r.customer === null).length,
    noClosePeriod: rows.filter((r) => r.expectedClosePeriod === null).length,
    valueWithheld: readable.value ? 0 : missingValue,
    probabilityWithheld: readable.probability ? 0 : missingProbability,
  };
}

/**
 * Where a deal stands, read from what Memoire states (audit 2026-10-13: lost deals were counted in the pipeline and in
 * the quarter's expected revenue). Either field naming a close wins: a row whose stage says Lost is lost even when its
 * status still says Active. Anything else is open; "On hold" is said apart.
 */
export type DealState = 'OPEN' | 'WON' | 'LOST' | 'ON_HOLD';

export function dealStateOf(stage: string | null, status: string | null): DealState {
  const said = `${stage ?? ''} ${status ?? ''}`.toLowerCase();
  if (/\blost\b|closed[\s-]?lost|cancel/.test(said)) return 'LOST';
  if (/\bwon\b|closed[\s-]?won/.test(said)) return 'WON';
  if (/on[\s-]?hold|paused/.test(said)) return 'ON_HOLD';
  return 'OPEN';
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * The quarter a close period as Memoire states it names. Memoire's field is free text: "2026-11", "2026-10-30",
 * "Jul 2026", "Q4 2026", "Q4/2026", "2026-Q4" and a bare "Q4". A month, a date or a quarter with a year is read; a
 * quarter without a year keeps its quarter and says the year is missing — it is never silently placed in a year.
 */
export function quarterOf(stated: string | null): { readonly year: string | null; readonly quarter: number } | null {
  if (!stated) return null;
  const t = stated.trim().toUpperCase();
  const q = (m: number) => Math.floor((m - 1) / 3) + 1;
  const date = t.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (date && Number(date[2]) >= 1 && Number(date[2]) <= 12) return { year: date[1]!, quarter: q(Number(date[2])) };
  const named = t.match(/^([A-Z]{3})[A-Z]*\.?[\s/-]+(\d{4})$/);
  if (named && MONTHS[named[1]!]) return { year: named[2]!, quarter: q(MONTHS[named[1]!]!) };
  const yq = t.match(/^(\d{4})[-\s/]?Q([1-4])$/);
  if (yq) return { year: yq[1]!, quarter: Number(yq[2]) };
  const qy = t.match(/^Q([1-4])[-\s/]?(\d{4})$/);
  if (qy) return { year: qy[2]!, quarter: Number(qy[1]) };
  const bare = t.match(/^Q([1-4])$/);
  if (bare) return { year: null, quarter: Number(bare[1]) };
  return null;
}

/** "2026-Q4" for an instant. */
export function quarterKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/**
 * Whether a close period as Memoire states it falls in a quarter ("2026-Q4"). A quarter stated without a year is
 * AMBIGUOUS — kept, and said, never silently placed in a year. Anything unreadable does not match.
 */
export function closesIn(stated: string | null, quarter: string): 'YES' | 'NO' | 'AMBIGUOUS' {
  const want = quarter.trim().toUpperCase().match(/^(\d{4})-Q([1-4])$/);
  const at = quarterOf(stated);
  if (!want || !at) return 'NO';
  if (at.quarter !== Number(want[2])) return 'NO';
  if (at.year === null) return 'AMBIGUOUS';
  return at.year === want[1] ? 'YES' : 'NO';
}

/** A sum in one currency, or the currencies that stopped it: HELM never converts. */
export type Money = { readonly value: string | null; readonly currency: string | null; readonly mixed: readonly string[] };

const money = (rows: readonly PipelinePosition[], amount: (r: PipelinePosition) => number | null): Money => {
  const counted = rows.map((r) => ({ r, a: amount(r) })).filter((x): x is { r: PipelinePosition; a: number } => x.a !== null && Number.isFinite(x.a));
  const currencies = [...new Set(counted.map((x) => x.r.currency ?? '—'))];
  if (currencies.length > 1) return { value: null, currency: null, mixed: currencies };
  // Cents, so a sum of decimal strings does not drift.
  const cents = counted.reduce((t, x) => t + Math.round(x.a * 100), 0);
  return { value: counted.length === 0 ? null : (cents / 100).toFixed(2).replace(/\.00$/, ''), currency: currencies[0] ?? null, mixed: [] };
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * The quarter as a sales manager reads it — every figure arithmetic on source facts, by deal state (audit 2026-10-13):
 *
 *   open pipeline   the value of every OPEN deal, whenever it closes
 *   in the quarter  OPEN deals whose close period falls in the quarter: their value, and value × probability
 *   won             WON deals that closed in the quarter: what Memoire records as won, not a forecast
 *   lost            LOST deals: counted, never forecast
 *
 * Nothing is ranked. A deal with no probability adds its value to "in the quarter" but nothing to the weighted figure,
 * and is counted so the reader sees the gap. A quarter stated without a year is counted in the quarter and said.
 */
export type QuarterReading = {
  readonly quarter: string;
  readonly open: { readonly count: number; readonly value: Money };
  readonly inQuarter: { readonly count: number; readonly value: Money; readonly weighted: Money; readonly noProbability: number; readonly yearNotStated: number };
  readonly won: { readonly count: number; readonly value: Money; readonly inQuarter: number; readonly inQuarterValue: Money };
  readonly lost: { readonly count: number; readonly value: Money };
  readonly onHold: { readonly count: number; readonly value: Money };
  /** OPEN deals whose close period lies in a quarter before this one: still open, but past when they were due. */
  readonly overdue: { readonly count: number; readonly value: Money };
  /** OPEN deals with no close period at all. */
  readonly noClosePeriod: number;
};

const quarterIndex = (year: string, quarter: number): number => Number(year) * 4 + quarter;

export function readQuarter(rows: readonly PipelinePosition[], quarter: string): QuarterReading {
  const [y, q] = quarter.split('-Q') as [string, string];
  const now = quarterIndex(y, Number(q));
  const open = rows.filter((r) => r.state === 'OPEN');
  const placed = open.map((r) => ({ r, c: closesIn(r.expectedClosePeriod, quarter), at: quarterOf(r.expectedClosePeriod) }));
  const inQ = placed.filter((x) => x.c !== 'NO').map((x) => x.r);
  const won = rows.filter((r) => r.state === 'WON');
  // Won in the quarter: by the date Memoire records it closed, else by its stated close period.
  const wonInQ = won.filter((r) => closesIn(r.closedOn ?? r.expectedClosePeriod, quarter) === 'YES');
  const lost = rows.filter((r) => r.state === 'LOST');
  const onHold = rows.filter((r) => r.state === 'ON_HOLD');
  const overdue = placed.filter((x) => x.at !== null && x.at.year !== null && quarterIndex(x.at.year, x.at.quarter) < now).map((x) => x.r);
  return {
    quarter,
    open: { count: open.length, value: money(open, (r) => num(r.value)) },
    inQuarter: {
      count: inQ.length,
      value: money(inQ, (r) => num(r.value)),
      weighted: money(inQ, (r) => (r.value === null || r.probability === null ? null : Number(r.value) * Number(r.probability))),
      noProbability: inQ.filter((r) => r.probability === null).length,
      yearNotStated: placed.filter((x) => x.c === 'AMBIGUOUS').length,
    },
    won: { count: won.length, value: money(won, (r) => num(r.value)), inQuarter: wonInQ.length, inQuarterValue: money(wonInQ, (r) => num(r.value)) },
    lost: { count: lost.length, value: money(lost, (r) => num(r.value)) },
    onHold: { count: onHold.length, value: money(onHold, (r) => num(r.value)) },
    overdue: { count: overdue.length, value: money(overdue, (r) => num(r.value)) },
    noClosePeriod: open.filter((r) => r.expectedClosePeriod === null).length,
  };
}


/**
 * OPEN deals nobody has touched for `days` (by the source's last touch, else never touched): a fact about time, not a
 * verdict on the deal. Deals the source records no touch for are counted apart — HELM cannot say how long they sat.
 */
export function staleDeals(rows: readonly PipelinePosition[], nowIso: string, days = 30): { readonly stale: readonly PipelinePosition[]; readonly neverTouched: readonly PipelinePosition[] } {
  const cutoff = Date.parse(nowIso) - days * 86_400_000;
  const open = rows.filter((r) => r.state === 'OPEN');
  return {
    stale: open.filter((r) => r.lastTouchAt !== null && Date.parse(r.lastTouchAt) < cutoff),
    neverTouched: open.filter((r) => r.lastTouchAt === null),
  };
}

/**
 * The last day of a close period as Memoire states it ("2026-10-30", "2026-11", "Nov 2026", "Q4 2026", "2026-Q4"), as
 * YYYY-MM-DD — or null for a bare quarter or anything unreadable: a close date HELM cannot place has not passed.
 */
export function closeEndOf(stated: string | null): string | null {
  if (!stated) return null;
  const t = stated.trim().toUpperCase();
  const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const day = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (day) {
    const d = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(day[2]) - 1 ? null : d.toISOString().slice(0, 10);
  }
  const month = t.match(/^(\d{4})-(\d{1,2})$/);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) return lastOfMonth(Number(month[1]), Number(month[2]));
  const named = t.match(/^([A-Z]{3})[A-Z]*\.?[\s/-]+(\d{4})$/);
  if (named && MONTHS[named[1]!]) return lastOfMonth(Number(named[2]), MONTHS[named[1]!]!);
  const at = quarterOf(stated);
  return at && at.year !== null ? lastOfMonth(Number(at.year), at.quarter * 3) : null;
}

/** Why a deal is on "This week": each a date the source states, said back — never a judgement of the deal. */
export type WeekReason =
  | { readonly kind: 'NEXT_STEP_OVERDUE'; readonly date: string }
  | { readonly kind: 'NEXT_STEP_DUE'; readonly date: string }
  | { readonly kind: 'CLOSE_PASSED'; readonly date: string };
export type WeekLine = { readonly deal: PipelinePosition; readonly reasons: readonly WeekReason[]; readonly since: string };
export type WeekReading = { readonly lines: readonly WeekLine[]; readonly counts: Readonly<Record<WeekReason['kind'], number>>; readonly today: string };

const dayOf = (iso: string | null): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The OPEN deals that need a step from their owner this week, by named conditions on dates the source states: a next
 * step that is overdue or due within `days`, or a close date that has passed. A deal is listed once with every reason
 * it has. The list is in the order its earliest date came, oldest first — an order by date, never a ranking of which
 * deal matters most. A deal nobody changed for a month is data to fix, not a step this week: see `quietDeals`
 * (live 2026-10-16: 35 such deals, most at a value of 0, pushed the 20 late next steps off the first screen).
 */
export function thisWeek(rows: readonly PipelinePosition[], nowIso: string, options: { days?: number } = {}): WeekReading {
  const today = nowIso.slice(0, 10);
  const horizon = plusDays(today, options.days ?? 7);
  const counts = { NEXT_STEP_OVERDUE: 0, NEXT_STEP_DUE: 0, CLOSE_PASSED: 0 };
  const lines: WeekLine[] = [];
  for (const deal of rows) {
    if (deal.state !== 'OPEN') continue;
    const reasons: WeekReason[] = [];
    const next = dayOf(deal.nextActionDate);
    if (next !== null && next < today) reasons.push({ kind: 'NEXT_STEP_OVERDUE', date: next });
    else if (next !== null && next <= horizon) reasons.push({ kind: 'NEXT_STEP_DUE', date: next });
    const closeEnd = closeEndOf(deal.expectedClosePeriod);
    if (closeEnd !== null && closeEnd < today) reasons.push({ kind: 'CLOSE_PASSED', date: closeEnd });
    if (reasons.length === 0) continue;
    for (const r of reasons) counts[r.kind] += 1;
    lines.push({ deal, reasons, since: reasons.map((r) => r.date).sort()[0]! });
  }
  lines.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.deal.opportunity.localeCompare(b.deal.opportunity)));
  return { lines, counts, today };
}

/** OPEN deals the source has not changed for `days` (by its own update time): a fact about the record, not the deal. */
export function quietDeals(rows: readonly PipelinePosition[], nowIso: string, days = 30): PipelinePosition[] {
  const cutoff = plusDays(nowIso.slice(0, 10), -days);
  return rows.filter((r) => r.state === 'OPEN' && dayOf(r.sourceUpdatedAt) !== null && dayOf(r.sourceUpdatedAt)! < cutoff);
}

/** One line per brand the deals state (and one for none): counts and sums, in the order brands first appear. Never ranked. */
export type BrandLine = { readonly brand: string | null; readonly open: number; readonly openValue: Money; readonly inQuarter: number; readonly inQuarterValue: Money; readonly weighted: Money; readonly won: number; readonly lost: number };

export function byBrand(rows: readonly PipelinePosition[], quarter: string): BrandLine[] {
  const groups = new Map<string | null, PipelinePosition[]>();
  for (const r of rows) groups.set(r.brand, [...(groups.get(r.brand) ?? []), r]);
  return [...groups.entries()].map(([brand, rs]) => {
    const q = readQuarter(rs, quarter);
    return { brand, open: q.open.count, openValue: q.open.value, inQuarter: q.inQuarter.count, inQuarterValue: q.inQuarter.value, weighted: q.inQuarter.weighted, won: q.won.count, lost: q.lost.count };
  });
}

/** "Canister / Tailin / Cons · CÔNG TY …": an opportunity read with the customer that holds it. */
export function opportunityLabel(p: Pick<PipelinePosition, 'opportunity' | 'customer'>): string {
  return p.customer ? `${p.opportunity} · ${p.customer}` : p.opportunity;
}

/** The customer of every opportunity entity the items name: for labels that otherwise repeat one product four times. */
export function customerOfSubject(items: readonly TwinItem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of readPipeline(items)) if (p.customer) m.set(p.opportunityId, p.customer);
  return m;
}
