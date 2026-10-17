/**
 * Memoire's receivables — the cash that came back for an order (step 3, 2026-10-17).
 *
 * Memoire follows each order to cash: the receipts banked against it, and its own view of what is still owed, derived
 * from the quote's payment terms and the order's schedule. HELM reads the receipts only, as source truth: one ACTUAL
 * `CashReceived` observation per order — the sum of its receipts to date, for the interval from the first receipt to
 * the last. What is still owed is Memoire's to say; HELM does not compute it again.
 *
 * Receipts in more than one currency stop the record (HELM never converts); a sample record and an order with no
 * receipt say nothing; a negative receipt stops the record; an order for an opportunity HELM has not read is
 * quarantined until it has.
 */

import { fail, fnv1a64, ok, type Result, type Scope } from '@helm/shared';
import type { SourceAdapter } from './port.ts';
import { IntegrationErrors, type FieldSpec, type SchemaContract, type SourceFact, type SourceRecord, type Translation } from './types.ts';

export type MemoireReceipt = { readonly amount: number | string | null; readonly currency: string | null; readonly received_on: string | null };

/** What HELM reads of one `order_receivables` row: Memoire keeps it as a payload, and the bridge flattens these fields. */
export type MemoireReceivableRow = {
  readonly id: string;
  readonly opportunity_id: string;
  readonly receipts: readonly MemoireReceipt[];
  readonly is_sample: boolean | null;
  readonly updated_at: string;
};

export type MemoireReceivableCursor = { readonly updatedAt: string; readonly id: string };

export interface MemoireReceivableReader {
  listReceivables(scope: Scope, after: MemoireReceivableCursor | null, limit: number): Promise<Result<readonly MemoireReceivableRow[]>>;
}

export const MEMOIRE_RECEIVABLE_CONNECTOR = 'memoire-order-receipts@0.1.0';

const RECEIVABLE_FIELDS: readonly FieldSpec[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'opportunity_id', type: 'string', required: true },
  { name: 'receipts', type: 'json', required: true },
  { name: 'is_sample', type: 'boolean', required: false },
  { name: 'updated_at', type: 'date', required: true },
];

export const MEMOIRE_RECEIVABLE_CONTRACT: SchemaContract = { system: 'memoire', objectType: 'order_receivable', version: 'order_receivable@1', fields: RECEIVABLE_FIELDS };

const encode = (c: MemoireReceivableCursor) => `${c.updatedAt}|${c.id}`;
const decode = (s: string | null): MemoireReceivableCursor | null => {
  if (!s) return null;
  const i = s.indexOf('|');
  return i < 0 ? null : { updatedAt: s.slice(0, i), id: s.slice(i + 1) };
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (s: string | null): string | null => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00.000Z`) + 86_400_000).toISOString();

export function createMemoireReceivableAdapter(reader: MemoireReceivableReader, options: { pageSize?: number } = {}): SourceAdapter {
  const pageSize = options.pageSize ?? 200;
  return {
    system: 'memoire',
    connector: MEMOIRE_RECEIVABLE_CONNECTOR,
    contracts: [MEMOIRE_RECEIVABLE_CONTRACT],

    async pull(scope, cursor, limit) {
      const rows = await reader.listReceivables(scope, decode(cursor), limit ?? pageSize);
      if (!rows.ok) return rows;
      const records: SourceRecord[] = rows.value.map((row) => {
        const fields: Record<string, unknown> = { ...row };
        return { system: 'memoire', objectType: 'order_receivable', externalId: row.id, updatedAt: row.updated_at, contentHash: fnv1a64(JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]))), fields };
      });
      const last = rows.value.at(-1);
      return ok({ records, nextCursor: last ? encode({ updatedAt: last.updated_at, id: last.id }) : cursor });
    },

    translate(record): Result<Translation> {
      if (record.objectType !== 'order_receivable') return fail(IntegrationErrors.TRANSLATION, `The Memoire receipts adapter does not translate "${record.objectType}".`);
      const f = record.fields as unknown as MemoireReceivableRow;
      const none: Translation = { entities: [], relationships: [], aliases: [], facts: [] };
      if (f.is_sample === true) return ok(none);
      const receipts = (f.receipts ?? []).map((r) => ({ amount: num(r.amount), currency: r.currency?.trim().toUpperCase() || null, on: day(r.received_on) })).filter((r) => r.amount !== null);
      if (receipts.length === 0) return ok(none);
      if (receipts.some((r) => r.amount! < 0)) return fail(IntegrationErrors.TRANSLATION, `Order ${f.id} records a negative receipt; HELM does not net it.`);
      if (receipts.some((r) => r.on === null)) return fail(IntegrationErrors.TRANSLATION, `Order ${f.id} records a receipt with no date; HELM will not place it in time.`);
      const currencies = [...new Set(receipts.map((r) => r.currency))];
      if (currencies.length !== 1 || currencies[0] === null) {
        return fail(IntegrationErrors.TRANSLATION, `Order ${f.id} records receipts in ${currencies.map((c) => c ?? 'no currency').join(' and ')}; HELM never converts, so the cash received is not recorded.`);
      }
      // Cents, so a sum of decimal strings does not drift.
      const total = receipts.reduce((t, r) => t + Math.round(r.amount! * 100), 0) / 100;
      const days = receipts.map((r) => r.on!).sort();
      const fact: SourceFact = {
        subject: { entityTypeKey: 'Opportunity', canonicalKey: `memoire:opportunity:${f.opportunity_id}` },
        metricKey: 'CashReceived',
        observationType: 'ACTUAL',
        value: total,
        unit: 'currency',
        currency: currencies[0]!,
        effectiveAt: `${days.at(-1)}T00:00:00.000Z`,
        periodStart: `${days[0]}T00:00:00.000Z`,
        periodEnd: nextDay(days.at(-1)!),
        observedAt: f.updated_at,
        sourceField: `order_receivables.receipts[].amount (${receipts.length} ${receipts.length === 1 ? 'receipt' : 'receipts'})`,
        confidence: null,
        label: `Cash received — Memoire order ${f.id.length > 12 ? f.id.slice(0, 8) : f.id}`,
      };
      return ok({ ...none, facts: [fact] });
    },
  };
}

/** A reader over fixed rows — for tests and the demonstration. Honours the cursor exactly as the real one does. */
export function createFixtureReceivableReader(rows: readonly MemoireReceivableRow[]): MemoireReceivableReader & { readonly rows: MemoireReceivableRow[] } {
  const held: MemoireReceivableRow[] = [...rows];
  return {
    rows: held,
    async listReceivables(_scope, after, limit) {
      const sorted = [...held].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      const next = after ? sorted.filter((r) => r.updated_at > after.updatedAt || (r.updated_at === after.updatedAt && r.id > after.id)) : sorted;
      return ok(next.slice(0, limit));
    },
  };
}
