/**
 * The organization's revenue target per quarter (audit 2026-10-13, GM: "no target, so no 'where will the quarter land
 * against target, and how much is missing'"). A target is a TARGET observation on one organization-wide Revenue node,
 * one per quarter, recorded with who set it and when. A new target for the same quarter is a newer observation — the
 * earlier one stays on record; the latest recorded is the one in force. HELM never invents a target.
 */

import type { Scope, UserId } from '@helm/shared';
import type { ValueGraph, ValueNode } from '@helm/value-graph';

const PURPOSE = 'quarter-revenue-target';

export type QuarterTarget = { readonly quarter: string; readonly value: string; readonly currency: string | null; readonly recordedAt: string };

const bounds = (quarter: string): { start: string; end: string } => {
  const [y, q] = quarter.split('-Q').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(y, q * 3, 1) - 1);
  return { start: start.toISOString(), end: end.toISOString() };
};

const quarterOfStart = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

async function targetNode(vg: ValueGraph, scope: Scope): Promise<ValueNode | null> {
  const r = await vg.findValueNodes(scope, { metricKeys: ['Revenue'], scopeKind: 'enterprise', timeHorizon: 'quarter' });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.find((n) => n.metadata?.['purpose'] === PURPOSE) ?? null;
}

/** The target in force for a quarter, or null when none was set. */
export async function readQuarterTarget(vg: ValueGraph, scope: Scope, quarter: string): Promise<QuarterTarget | null> {
  const node = await targetNode(vg, scope);
  if (!node) return null;
  const obs = await vg.getObservations(scope, { nodeId: node.id, types: ['TARGET'], scenarioEntityId: null, limit: 500 });
  if (!obs.ok) throw new Error(obs.error.message);
  const mine = obs.value.filter((o) => o.periodStart && quarterOfStart(o.periodStart) === quarter && o.numericValue !== null);
  const latest = [...mine].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  return latest ? { quarter, value: String(latest.numericValue), currency: latest.currency, recordedAt: latest.recordedAt } : null;
}

export async function setQuarterTarget(vg: ValueGraph, scope: Scope, quarter: string, amount: number, currency: string): Promise<void> {
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error(`"${quarter}" is not a quarter.`);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('A target is a positive amount.');
  let node = await targetNode(vg, scope);
  if (!node) {
    const created = await vg.createValueNode(scope, {
      metricKey: 'Revenue',
      scopeKind: 'enterprise',
      timeHorizon: 'quarter',
      label: 'Revenue target — whole organization',
      metadata: { purpose: PURPOSE },
      createdBy: scope.actorId as UserId,
    });
    if (!created.ok) throw new Error(created.error.message);
    node = created.value;
  }
  const { start, end } = bounds(quarter);
  const r = await vg.recordObservation(scope, {
    nodeId: node.id,
    observationType: 'TARGET',
    numericValue: amount,
    unitType: 'currency',
    currency: currency.trim().toUpperCase(),
    periodStart: start as never,
    periodEnd: end as never,
    sourceSystem: 'manual',
    metadata: { quarter, purpose: PURPOSE },
    createdBy: scope.actorId as UserId,
  });
  if (!r.ok) throw new Error(r.error.message);
}
