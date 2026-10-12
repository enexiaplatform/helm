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
  readonly expectedClosePeriod: string | null;
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
};

const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

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
    if (e.state['entityTypeKey'] !== 'Opportunity') continue;
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
      expectedClosePeriod: s(attrs['expectedClosePeriod']),
      value: val ? s(val.state['value']) : null,
      currency: val ? s(val.state['currency']) : null,
      probability: prob ? s(prob.state['value']) : null,
      expectedRevenue: reading(id, 'ExpectedRevenue', 'MODELLED').map((r) => ({ period: s(r.state['period']), value: s(r.state['value']), currency: s(r.state['currency']) })),
    });
  }
  return out;
}

/** What the pipeline as read states about its own completeness — counts of facts, never a score. */
export function pipelineFacts(rows: readonly PipelinePosition[]): PipelineFacts {
  const withValue = rows.filter((r) => r.value !== null);
  return {
    opportunities: rows.length,
    withValue: withValue.length,
    zeroValue: withValue.filter((r) => Number(r.value) === 0).length,
    noValue: rows.length - withValue.length,
    noProbability: rows.filter((r) => r.probability === null).length,
    modelled: rows.filter((r) => r.value !== null && r.probability !== null).length,
    withoutCustomer: rows.filter((r) => r.customer === null).length,
  };
}

/**
 * Whether a close period as Memoire states it falls in a quarter ("2026-Q4"). Memoire's field is free text and its rows
 * say "2026-11", "Q4 2026", "2026-Q4" and a bare "Q4": a month or a quarter with a year is read; a quarter without a
 * year is AMBIGUOUS — kept, and said, never silently placed in a year. Anything else does not match.
 */
export function closesIn(stated: string | null, quarter: string): 'YES' | 'NO' | 'AMBIGUOUS' {
  const want = quarter.trim().toUpperCase().match(/^(\d{4})-Q([1-4])$/);
  if (!want || !stated) return 'NO';
  const [, y, q] = want;
  const t = stated.trim().toUpperCase();
  const month = t.match(/^(\d{4})-(\d{1,2})$/);
  if (month) return month[1] === y && Math.floor((Number(month[2]) - 1) / 3) + 1 === Number(q) ? 'YES' : 'NO';
  const withYear = t.match(/^(\d{4})[-\s]?Q([1-4])$/) ?? t.match(/^Q([1-4])[-\s/]?(\d{4})$/);
  if (withYear) {
    const [yy, qq] = withYear[1]!.length === 4 ? [withYear[1], withYear[2]] : [withYear[2], withYear[1]];
    return yy === y && qq === q ? 'YES' : 'NO';
  }
  const bare = t.match(/^Q([1-4])$/);
  if (bare) return bare[1] === q ? 'AMBIGUOUS' : 'NO';
  return 'NO';
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
