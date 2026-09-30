/**
 * The Memoire adapter — the first rich implementation of SourceAdapter.
 *
 * Memoire owns the commercial fact: the opportunity, its stage, its value and
 * its pipeline probability. HELM references the opportunity by Memoire's own id
 * (never its name), canonicalizes it into the ontology (Opportunity, held by a
 * Customer) and records value and probability as SOURCE observations naming
 * Memoire. HELM never copies the record and never writes into Memoire.
 *
 * Reading Memoire is a port (MemoireReader): in the app it is the signed-in
 * user's own RLS-scoped read of `opportunities`; in tests it is a fixture.
 */

import { fail, fnv1a64, ok, type Result, type Scope } from '@helm/shared';
import type { SourceAdapter } from './port.ts';
import { IntegrationErrors, type FieldSpec, type SchemaContract, type SourceFact, type SourceRecord, type Translation } from './types.ts';

/** The columns of Memoire's `opportunities` that HELM reads. Anything else Memoire adds is reported as drift, not ingested. */
export type MemoireOpportunityRow = {
  readonly id: string;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly opportunity_name: string | null;
  readonly title: string | null;
  readonly stage: string | null;
  readonly estimated_value: number | string | null;
  readonly currency: string | null;
  /** Percent, 0–100, as Memoire holds it. */
  readonly pipeline_probability: number | string | null;
  readonly status: string | null;
  readonly expected_close_period: string | null;
  readonly updated_at: string;
};

export type MemoireCursor = { readonly updatedAt: string; readonly id: string };

/** Everything the adapter needs from Memoire: rows strictly after a cursor, oldest first. Read-only. */
export interface MemoireReader {
  listOpportunities(scope: Scope, after: MemoireCursor | null, limit: number): Promise<Result<readonly MemoireOpportunityRow[]>>;
}

export const MEMOIRE_CONNECTOR = 'memoire-connector@0.2.0';

const OPPORTUNITY_FIELDS: readonly FieldSpec[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'account_id', type: 'string', required: false },
  { name: 'account_name', type: 'string', required: false },
  { name: 'opportunity_name', type: 'string', required: false },
  { name: 'title', type: 'string', required: false },
  { name: 'stage', type: 'string', required: true },
  { name: 'estimated_value', type: 'number', required: false },
  { name: 'currency', type: 'string', required: false },
  { name: 'pipeline_probability', type: 'number', required: false },
  { name: 'status', type: 'string', required: false },
  { name: 'expected_close_period', type: 'string', required: false },
  { name: 'updated_at', type: 'date', required: true },
];

export const MEMOIRE_OPPORTUNITY_CONTRACT: SchemaContract = { system: 'memoire', objectType: 'opportunity', version: 'opportunity@1', fields: OPPORTUNITY_FIELDS };

const encode = (c: MemoireCursor) => `${c.updatedAt}|${c.id}`;
const decode = (s: string | null): MemoireCursor | null => {
  if (!s) return null;
  const i = s.indexOf('|');
  return i < 0 ? null : { updatedAt: s.slice(0, i), id: s.slice(i + 1) };
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function createMemoireAdapter(reader: MemoireReader, options: { pageSize?: number } = {}): SourceAdapter {
  const pageSize = options.pageSize ?? 200;
  return {
    system: 'memoire',
    connector: MEMOIRE_CONNECTOR,
    contracts: [MEMOIRE_OPPORTUNITY_CONTRACT],

    async pull(scope, cursor, limit) {
      const rows = await reader.listOpportunities(scope, decode(cursor), limit ?? pageSize);
      if (!rows.ok) return rows;
      const records: SourceRecord[] = rows.value.map((row) => {
        const fields: Record<string, unknown> = { ...row };
        return { system: 'memoire', objectType: 'opportunity', externalId: row.id, updatedAt: row.updated_at, contentHash: fnv1a64(JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]))), fields };
      });
      const last = rows.value.at(-1);
      return ok({ records, nextCursor: last ? encode({ updatedAt: last.updated_at, id: last.id }) : cursor });
    },

    translate(record): Result<Translation> {
      if (record.objectType !== 'opportunity') return fail(IntegrationErrors.TRANSLATION, `The Memoire adapter does not translate "${record.objectType}".`);
      const f = record.fields as unknown as MemoireOpportunityRow;
      const oppRef = { entityTypeKey: 'Opportunity', canonicalKey: `memoire:opportunity:${f.id}` };
      const name = f.opportunity_name?.trim() || f.title?.trim() || `Memoire opportunity ${f.id.slice(0, 8)}`;
      const entities: Translation['entities'][number][] = [
        { ...oppRef, name, sourceEntityType: 'opportunity', sourceEntityId: f.id, observedAt: f.updated_at, attributes: { stage: f.stage, status: f.status ?? null, expectedClosePeriod: f.expected_close_period ?? null } },
      ];
      const aliases: Translation['aliases'][number][] = [{ entity: oppRef, aliasKind: 'source_id', aliasValue: f.id }];
      const relationships: Translation['relationships'][number][] = [];
      if (f.account_id) {
        const custRef = { entityTypeKey: 'Customer', canonicalKey: `memoire:account:${f.account_id}` };
        entities.push({ ...custRef, name: f.account_name?.trim() || `Memoire account ${f.account_id.slice(0, 8)}`, sourceEntityType: 'account', sourceEntityId: f.account_id, observedAt: f.updated_at, attributes: {} });
        aliases.push({ entity: custRef, aliasKind: 'source_id', aliasValue: f.account_id });
        relationships.push({ relationshipTypeKey: 'HELD_BY', source: oppRef, target: custRef, sourceObjectType: 'opportunity', sourceObjectId: f.id });
      }
      const facts: SourceFact[] = [];
      if (f.status !== 'archived') {
        const value = num(f.estimated_value);
        if (value !== null) {
          if (!f.currency?.trim()) return fail(IntegrationErrors.TRANSLATION, `Opportunity ${f.id} has a value and no currency; HELM will not guess one.`);
          facts.push({ subject: oppRef, metricKey: 'OpportunityValue', observationType: 'ACTUAL', value, unit: 'currency', currency: f.currency.trim().toUpperCase(), effectiveAt: f.updated_at, observedAt: f.updated_at, sourceField: 'estimated_value', confidence: null, label: `Opportunity Value — ${name}` });
        }
        const pct = num(f.pipeline_probability);
        if (pct !== null) {
          if (pct < 0 || pct > 100) return fail(IntegrationErrors.TRANSLATION, `Opportunity ${f.id} has a pipeline probability of ${pct}, outside 0–100.`);
          facts.push({ subject: oppRef, metricKey: 'OpportunityProbability', observationType: 'ACTUAL', value: pct / 100, unit: 'ratio', currency: null, effectiveAt: f.updated_at, observedAt: f.updated_at, sourceField: 'pipeline_probability', confidence: null, label: `Opportunity Probability — ${name}` });
        }
      }
      return ok({ entities, relationships, aliases, facts });
    },
  };
}

/** A reader over fixed rows — for tests and the reference demonstration. Honours the cursor exactly as the real one does. */
export function createFixtureMemoireReader(rows: readonly MemoireOpportunityRow[]): MemoireReader & { readonly rows: MemoireOpportunityRow[] } {
  const held: MemoireOpportunityRow[] = [...rows];
  return {
    rows: held,
    async listOpportunities(_scope, after, limit) {
      const sorted = [...held].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      const next = after ? sorted.filter((r) => r.updated_at > after.updatedAt || (r.updated_at === after.updatedAt && r.id > after.id)) : sorted;
      return ok(next.slice(0, limit));
    },
  };
}
