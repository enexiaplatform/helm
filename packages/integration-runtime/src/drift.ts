/**
 * Schema drift: has the source stopped looking like what the adapter promised?
 *
 * Pure. A required field that vanished or changed type is BREAKING — HELM does
 * not guess at a changed source, it stops ingesting that object type and says
 * why. A new field the contract does not know is ADDITIVE: reported, never
 * ingested until an adapter version names it.
 */

import type { DriftFinding, DriftReport, FieldType, SchemaContract, SourceRecord } from './types.ts';

const typeOf = (v: unknown): FieldType | 'null' => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) ? 'date' : 'string';
  return 'json';
};

/** A numeric string ("45.0", as some drivers return numeric columns) satisfies a number field; a date string satisfies a string field. */
const satisfies = (want: FieldType, got: FieldType | 'null'): boolean =>
  want === got || (want === 'string' && got === 'date') || (want === 'date' && got === 'string') || (want === 'json' && got !== 'null');

export function detectDrift(contract: SchemaContract, records: readonly SourceRecord[]): DriftReport {
  const breaking = new Map<string, { finding: DriftFinding; n: number }>();
  const additive = new Map<string, { finding: DriftFinding; n: number }>();
  const bump = (m: typeof breaking, key: string, f: Omit<DriftFinding, 'records'>) => {
    const cur = m.get(key);
    if (cur) cur.n += 1;
    else m.set(key, { finding: { ...f, records: 0 }, n: 1 });
  };
  const known = new Set(contract.fields.map((f) => f.name));
  for (const r of records) {
    for (const spec of contract.fields) {
      const got = typeOf(r.fields[spec.name]);
      if (got === 'null') {
        if (spec.required) bump(breaking, `m:${spec.name}`, { kind: 'MISSING_REQUIRED_FIELD', field: spec.name, detail: `Required field "${spec.name}" is absent or empty in the source.` });
        else if (!(spec.name in r.fields)) bump(additive, `o:${spec.name}`, { kind: 'MISSING_OPTIONAL_FIELD', field: spec.name, detail: `Optional field "${spec.name}" is no longer offered by the source.` });
        continue;
      }
      if (!satisfies(spec.type, got)) {
        // A numeric string is a number in a driver's clothing.
        if (spec.type === 'number' && typeof r.fields[spec.name] === 'string' && Number.isFinite(Number(r.fields[spec.name]))) continue;
        bump(breaking, `t:${spec.name}`, { kind: 'TYPE_CHANGED', field: spec.name, detail: `Field "${spec.name}" is promised as ${spec.type} and arrived as ${got}.` });
      }
    }
    for (const name of Object.keys(r.fields)) {
      if (!known.has(name)) bump(additive, `u:${name}`, { kind: 'UNKNOWN_FIELD', field: name, detail: `The source offers "${name}", which the adapter's contract does not name. It is not ingested.` });
    }
  }
  const out = (m: typeof breaking): DriftFinding[] => [...m.values()].map((x) => ({ ...x.finding, records: x.n })).sort((a, b) => a.field.localeCompare(b.field));
  const b = out(breaking);
  const a = out(additive);
  return {
    objectType: contract.objectType,
    contractVersion: contract.version,
    sampled: records.length,
    breaking: b,
    additive: a,
    status: b.length > 0 ? 'BREAKING' : a.length > 0 ? 'ADDITIVE' : 'NONE',
  };
}
