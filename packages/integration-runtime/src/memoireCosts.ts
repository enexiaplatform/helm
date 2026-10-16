/**
 * Memoire's order costs — the landed cost of what was ordered (step 3, 2026-10-17).
 *
 * Memoire records, per order, what the goods cost and what it took to land them: the purchase amount, duty, freight and
 * other costs, against the opportunity the order fulfils. Memoire owns that record and its own cost analysis; HELM reads
 * it as source truth so a decision can be judged on margin and a commitment read back against what it cost — it never
 * shows a margin report of its own.
 *
 * Each record becomes one ACTUAL `Cogs` observation on the opportunity it names: purchase + duty + freight + other, in
 * one currency, for the calendar quarter Memoire recorded the cost in (Cogs is a period metric; Memoire states no order
 * date, so the quarter is the one the record was made in, and the observation says so). Extras in another currency stop
 * the record (HELM never converts); a sample record and a record with no purchase amount say nothing; an order for an
 * opportunity HELM has not read is quarantined until it has.
 */

import { fail, fnv1a64, ok, periodContaining, type Result, type Scope } from '@helm/shared';
import type { SourceAdapter } from './port.ts';
import { IntegrationErrors, type FieldSpec, type SchemaContract, type SourceFact, type SourceRecord, type Translation } from './types.ts';

/** What HELM reads of one `order_costs` row: Memoire keeps it as a payload, and the bridge flattens the fields named here. */
export type MemoireOrderCostRow = {
  readonly id: string;
  readonly opportunity_id: string;
  readonly amount: number | string | null;
  readonly currency: string | null;
  readonly duty_amount: number | string | null;
  readonly freight_amount: number | string | null;
  readonly other_amount: number | string | null;
  /** The currency of duty, freight and other, when Memoire states one apart from the purchase's. */
  readonly extras_currency: string | null;
  /** Memoire's own sample data, never a real order. */
  readonly is_sample: boolean | null;
  /** When Memoire recorded the cost: it places the cost in a quarter. */
  readonly created_at: string;
  readonly updated_at: string;
};

export type MemoireCostCursor = { readonly updatedAt: string; readonly id: string };

export interface MemoireOrderCostReader {
  listOrderCosts(scope: Scope, after: MemoireCostCursor | null, limit: number): Promise<Result<readonly MemoireOrderCostRow[]>>;
}

export const MEMOIRE_COST_CONNECTOR = 'memoire-order-costs@0.1.0';

const COST_FIELDS: readonly FieldSpec[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'opportunity_id', type: 'string', required: true },
  { name: 'amount', type: 'number', required: false },
  { name: 'currency', type: 'string', required: false },
  { name: 'duty_amount', type: 'number', required: false },
  { name: 'freight_amount', type: 'number', required: false },
  { name: 'other_amount', type: 'number', required: false },
  { name: 'extras_currency', type: 'string', required: false },
  { name: 'is_sample', type: 'boolean', required: false },
  { name: 'created_at', type: 'date', required: true },
  { name: 'updated_at', type: 'date', required: true },
];

export const MEMOIRE_ORDER_COST_CONTRACT: SchemaContract = { system: 'memoire', objectType: 'order_cost', version: 'order_cost@1', fields: COST_FIELDS };

const encode = (c: MemoireCostCursor) => `${c.updatedAt}|${c.id}`;
const decode = (s: string | null): MemoireCostCursor | null => {
  if (!s) return null;
  const i = s.indexOf('|');
  return i < 0 ? null : { updatedAt: s.slice(0, i), id: s.slice(i + 1) };
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (n: number) => Math.round(n * 100);

export function createMemoireOrderCostAdapter(reader: MemoireOrderCostReader, options: { pageSize?: number } = {}): SourceAdapter {
  const pageSize = options.pageSize ?? 200;
  return {
    system: 'memoire',
    connector: MEMOIRE_COST_CONNECTOR,
    contracts: [MEMOIRE_ORDER_COST_CONTRACT],

    async pull(scope, cursor, limit) {
      const rows = await reader.listOrderCosts(scope, decode(cursor), limit ?? pageSize);
      if (!rows.ok) return rows;
      const records: SourceRecord[] = rows.value.map((row) => {
        const fields: Record<string, unknown> = { ...row };
        return { system: 'memoire', objectType: 'order_cost', externalId: row.id, updatedAt: row.updated_at, contentHash: fnv1a64(JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]))), fields };
      });
      const last = rows.value.at(-1);
      return ok({ records, nextCursor: last ? encode({ updatedAt: last.updated_at, id: last.id }) : cursor });
    },

    translate(record): Result<Translation> {
      if (record.objectType !== 'order_cost') return fail(IntegrationErrors.TRANSLATION, `The Memoire order-cost adapter does not translate "${record.objectType}".`);
      const f = record.fields as unknown as MemoireOrderCostRow;
      const none: Translation = { entities: [], relationships: [], aliases: [], facts: [] };
      const amount = num(f.amount);
      if (f.is_sample === true || amount === null) return ok(none);
      const currency = f.currency?.trim().toUpperCase();
      if (!currency) return fail(IntegrationErrors.TRANSLATION, `Order cost ${f.id} has an amount and no currency; HELM will not guess one.`);
      const extras = [num(f.duty_amount), num(f.freight_amount), num(f.other_amount)].map((x) => x ?? 0);
      const extrasCurrency = f.extras_currency?.trim().toUpperCase() || currency;
      if (extrasCurrency !== currency && extras.some((x) => x !== 0)) {
        return fail(IntegrationErrors.TRANSLATION, `Order cost ${f.id} states duty, freight or other cost in ${extrasCurrency} and the purchase in ${currency}; HELM never converts, so the landed cost is not recorded.`);
      }
      if ([amount, ...extras].some((x) => x < 0)) return fail(IntegrationErrors.TRANSLATION, `Order cost ${f.id} states a negative cost.`);
      // Cents, so a sum of decimal strings does not drift.
      const landed = [amount, ...extras].reduce((t, x) => t + cents(x), 0) / 100;
      const subject = { entityTypeKey: 'Opportunity', canonicalKey: `memoire:opportunity:${f.opportunity_id}` };
      const period = periodContaining(f.created_at, 'QUARTER');
      const fact: SourceFact = {
        subject,
        metricKey: 'Cogs',
        observationType: 'ACTUAL',
        value: landed,
        unit: 'currency',
        currency,
        effectiveAt: f.updated_at,
        periodStart: period.start,
        periodEnd: period.end,
        observedAt: f.updated_at,
        sourceField: 'order_costs.amount+duty_amount+freight_amount+other_amount; period = the quarter of created_at',
        confidence: null,
        label: `Landed cost — Memoire order ${f.id.length > 12 ? f.id.slice(0, 8) : f.id}`,
      };
      return ok({ ...none, facts: [fact] });
    },
  };
}

/** A reader over fixed rows — for tests and the demonstration. Honours the cursor exactly as the real one does. */
export function createFixtureOrderCostReader(rows: readonly MemoireOrderCostRow[]): MemoireOrderCostReader & { readonly rows: MemoireOrderCostRow[] } {
  const held: MemoireOrderCostRow[] = [...rows];
  return {
    rows: held,
    async listOrderCosts(_scope, after, limit) {
      const sorted = [...held].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      const next = after ? sorted.filter((r) => r.updated_at > after.updatedAt || (r.updated_at === after.updatedAt && r.id > after.id)) : sorted;
      return ok(next.slice(0, limit));
    },
  };
}
