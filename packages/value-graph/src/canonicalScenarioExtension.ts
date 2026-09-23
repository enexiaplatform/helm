/**
 * The Phase 4 extension of the canonical value chain.
 *
 * Adds the value positions Meridian model v1.1 computes — order quantity,
 * demand coverage, unserved quantity and revenue at risk — and the one it
 * never computes: allocated inventory, which only a person (or a scenario) can
 * state, because allocating stock between two opportunities is a management
 * choice.
 *
 * Kept separate from `buildCanonicalValueChain` on purpose: the Phase 2 chain
 * is a fixture other phases assert exact counts against, and extending it in
 * place would rewrite their expectations for a reason that has nothing to do
 * with them. Build the chain first, then this.
 *
 * NOTHING HERE IS AN OBSERVATION. In particular no allocation is stated: the
 * baseline has not decided how to split four units between two deals, and a
 * fixture that decided it would be HELM inventing a management decision.
 */

import type { Result, Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { ValueGraph } from './port.ts';
import type { TimeHorizon, ValueLinkType } from './types.ts';

type ExtensionNode = {
  handle: string;
  metric: string;
  subject: string;
  horizon: TimeHorizon;
  label: string;
};

export const canonicalScenarioExtensionNodes: readonly ExtensionNode[] = [
  { handle: 'orderQty', metric: 'OrderQuantity', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Order Quantity — Rohto Q4 tender' },
  { handle: 'orderQtyNext', metric: 'OrderQuantity', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Order Quantity — provincial tender' },
  { handle: 'coverage', metric: 'DemandCoverage', subject: 'helm:product:sku-x',
    horizon: 'quarter', label: 'Demand Coverage — SKU-X' },
  { handle: 'allocated', metric: 'AllocatedInventory', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Allocated Inventory — Rohto Q4 tender' },
  { handle: 'allocatedNext', metric: 'AllocatedInventory', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Allocated Inventory — provincial tender' },
  { handle: 'unserved', metric: 'UnservedDemand', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Unserved Order Quantity — Rohto Q4 tender' },
  { handle: 'unservedNext', metric: 'UnservedDemand', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Unserved Order Quantity — provincial tender' },
  { handle: 'revenueAtRisk', metric: 'RevenueAtRisk', subject: 'memoire:opportunity:opp-8821',
    horizon: 'quarter', label: 'Revenue at Risk — Rohto Q4 tender' },
  { handle: 'revenueAtRiskNext', metric: 'RevenueAtRisk', subject: 'memoire:tender:opp-8940',
    horizon: 'quarter', label: 'Revenue at Risk — provincial tender' },
];

/** Semantic dependencies, in the Phase 2 vocabulary. Structure only. */
const LINKS: readonly { type: ValueLinkType; from: string; to: string; confidence: number; note?: string }[] = [
  { type: 'DRIVES', from: 'invRequirement', to: 'coverage', confidence: 0.9 },
  { type: 'ENABLES', from: 'availOwn', to: 'coverage', confidence: 0.9 },
  { type: 'ENABLES', from: 'coverage', to: 'serviceLevel', confidence: 0.6,
    note: 'coverage is a proxy for the ability to serve, not the service level itself' },
  { type: 'CONSUMES', from: 'allocated', to: 'availOwn', confidence: 1,
    note: 'an allocation draws on the shared own stock' },
  { type: 'CONSUMES', from: 'allocatedNext', to: 'availOwn', confidence: 1,
    note: 'the competing allocation draws on the SAME stock' },
  { type: 'DRIVES', from: 'orderQty', to: 'unserved', confidence: 0.9 },
  { type: 'REDUCES', from: 'allocated', to: 'unserved', confidence: 1 },
  { type: 'DRIVES', from: 'orderQtyNext', to: 'unservedNext', confidence: 0.9 },
  { type: 'REDUCES', from: 'allocatedNext', to: 'unservedNext', confidence: 1 },
  { type: 'EXPOSES', from: 'unserved', to: 'revenueAtRisk', confidence: 0.6 },
  { type: 'EXPOSES', from: 'unservedNext', to: 'revenueAtRiskNext', confidence: 0.6 },
  { type: 'CONTRIBUTES_TO', from: 'revenueAtRiskNext', to: 'futureOppRisk', confidence: 0.5,
    note: 'the tender revenue a stock choice exposes is its future-opportunity risk' },
];

export type CanonicalScenarioExtension = {
  nodeIds: Record<string, string>;
  nodeCount: number;
  linkCount: number;
};

/**
 * Builds the extension onto an existing canonical chain. `chainNodeIds` are the
 * handles `buildCanonicalValueChain` returned. Idempotent.
 */
export async function buildCanonicalScenarioExtension(
  valueGraph: ValueGraph,
  graphStore: GraphStore,
  scope: Scope,
  chainNodeIds: Readonly<Record<string, string>>,
): Promise<Result<CanonicalScenarioExtension>> {
  const nodeIds: Record<string, string> = {};
  for (const spec of canonicalScenarioExtensionNodes) {
    const found = await graphStore.findEntities(scope, { canonicalKeys: [spec.subject], limit: 1 });
    if (!found.ok) return found;
    if (found.value.length === 0) {
      throw new Error(
        `scenario extension: no ontology entity "${spec.subject}". Build the canonical graph first.`,
      );
    }
    const r = await valueGraph.upsertValueNode(scope, {
      metricKey: spec.metric,
      subjectEntityId: found.value[0].id,
      timeHorizon: spec.horizon,
      label: spec.label,
    });
    if (!r.ok) return r;
    nodeIds[spec.handle] = r.value.id;
  }

  const all = { ...chainNodeIds, ...nodeIds };
  const existing = await valueGraph.findValueLinks(scope, { limit: 2000 });
  if (!existing.ok) return existing;
  const seen = new Set(existing.value.map((l) => `${l.linkType}|${l.sourceNodeId}|${l.targetNodeId}`));
  let linkCount = 0;
  for (const spec of LINKS) {
    const from = all[spec.from];
    const to = all[spec.to];
    if (!from || !to) throw new Error(`scenario extension: unknown handle ${spec.from} -> ${spec.to}`);
    const key = `${spec.type}|${from}|${to}`;
    linkCount += 1;
    if (seen.has(key)) continue;
    const r = await valueGraph.createValueLink(scope, {
      linkType: spec.type,
      sourceNodeId: from,
      targetNodeId: to,
      confidence: spec.confidence,
      sourceSystem: 'helm',
      metadata: spec.note ? { note: spec.note } : {},
    });
    if (!r.ok) return r;
    seen.add(key);
  }

  return {
    ok: true,
    value: { nodeIds, nodeCount: canonicalScenarioExtensionNodes.length, linkCount },
  };
}
