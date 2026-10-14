/**
 * Gross margin % per brand, as management ASSUMES it (audit 2026-10-13, GM: "margin, cash, working capital are empty —
 * a GM manages on profit"). HELM holds no cost of goods for this organization; until a cost source is connected, a
 * manager may state an assumed margin % per brand. Each is an ASSUMPTION observation on an organization-wide
 * Gross Margin % node for that brand, with who stated it and when — never presented as a measured margin.
 */

import type { Scope, UserId } from '@helm/shared';
import type { ValueGraph, ValueNode } from '@helm/value-graph';

const PURPOSE = 'brand-margin-assumption';

export type BrandMargin = { readonly brand: string; readonly pct: number; readonly recordedAt: string };

async function nodes(vg: ValueGraph, scope: Scope): Promise<ValueNode[]> {
  const r = await vg.findValueNodes(scope, { metricKeys: ['GrossMarginPct'], scopeKind: 'enterprise' });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.filter((n) => n.metadata?.['purpose'] === PURPOSE && typeof n.metadata?.['brand'] === 'string');
}

/** The margin % in force per brand (the latest stated), keyed by brand as the deals state it. */
export async function readBrandMargins(vg: ValueGraph, scope: Scope): Promise<Map<string, BrandMargin>> {
  const out = new Map<string, BrandMargin>();
  for (const n of await nodes(vg, scope)) {
    const obs = await vg.getObservations(scope, { nodeId: n.id, types: ['ASSUMPTION'], scenarioEntityId: null, limit: 50 });
    if (!obs.ok) throw new Error(obs.error.message);
    const latest = [...obs.value].filter((o) => o.numericValue !== null).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const brand = String(n.metadata['brand']);
    if (latest) out.set(brand, { brand, pct: Number(latest.numericValue), recordedAt: latest.recordedAt });
  }
  return out;
}

/** "Tailin, 32" per line (a pasted CSV works): each brand's assumed gross margin %. Returns what was read, or why not. */
export function parseBrandMargins(text: string): { rows: { brand: string; pct: number }[]; errors: string[] } {
  const rows: { brand: string; pct: number }[] = [];
  const errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || /^brand\b/i.test(line)) continue;
    const m = line.match(/^(.+?)[,;\t]\s*(-?\d+(?:[.,]\d+)?)\s*%?$/);
    if (!m) {
      errors.push(`Line ${i + 1}: "${line}" is not "brand, margin %".`);
      continue;
    }
    const pct = Number(m[2]!.replace(',', '.'));
    if (pct < -100 || pct > 100) errors.push(`Line ${i + 1}: ${pct}% is not a margin.`);
    else rows.push({ brand: m[1]!.trim(), pct });
  }
  return { rows, errors };
}

export async function setBrandMargins(vg: ValueGraph, scope: Scope, rows: readonly { brand: string; pct: number }[]): Promise<void> {
  const existing = await nodes(vg, scope);
  for (const { brand, pct } of rows) {
    let node = existing.find((n) => String(n.metadata['brand']).toLowerCase() === brand.toLowerCase()) ?? null;
    if (!node) {
      const created = await vg.createValueNode(scope, {
        metricKey: 'GrossMarginPct',
        scopeKind: 'enterprise',
        timeHorizon: 'current',
        label: `Gross margin % — ${brand} (assumed)`,
        metadata: { purpose: PURPOSE, brand },
        createdBy: scope.actorId as UserId,
      });
      if (!created.ok) throw new Error(created.error.message);
      node = created.value;
      existing.push(node);
    }
    const r = await vg.recordObservation(scope, {
      nodeId: node.id,
      observationType: 'ASSUMPTION',
      numericValue: pct,
      unitType: 'percentage',
      effectiveAt: new Date().toISOString() as never,
      sourceSystem: 'manual',
      metadata: { purpose: PURPOSE, brand },
      createdBy: scope.actorId as UserId,
    });
    if (!r.ok) throw new Error(r.error.message);
  }
}
