/**
 * The management perspectives, and what makes one relevant.
 *
 * A perspective exists for an enterprise only where HELM HOLDS DATA for it — read
 * from the data coverage tool, not assumed. People has no data here (no HR source,
 * no HR-restricted reading), so it is not instantiated, and the council says so
 * rather than speaking for a function it knows nothing about.
 */

import type { EvidenceItem } from '@helm/intelligence-runtime';
import type { PerspectiveId } from './types.ts';

export type PerspectiveDef = {
  readonly id: PerspectiveId;
  readonly name: string;
  /** What it looks at, in a sentence — shown to the person, given to a provider. */
  readonly focus: string;
  /** Value dimensions and metrics that are this perspective's own. */
  readonly dimensions: readonly string[];
  readonly metricKeys: readonly string[];
  /** For evidence with no dimension (an attention condition, a decision, a claim): the words that make it relevant. */
  readonly words: RegExp;
  /** Whether HELM holds data for it, from the coverage evidence. */
  readonly supported: (coverage: Coverage) => { supported: boolean; reason: string };
};

export type Coverage = { readonly byDimension: ReadonlyMap<string, number>; readonly hrItems: number; readonly hasEnterpriseValue: boolean };

const dimsSupport = (dims: readonly string[], label: string) => (c: Coverage) => {
  const n = dims.reduce((a, d) => a + (c.byDimension.get(d) ?? 0), 0);
  return n > 0 ? { supported: true, reason: `${n} ${label} reading(s).` } : { supported: false, reason: `HELM holds no ${label} readings, so no perspective is taken on it.` };
};

/** Canonical order: fixed, never by importance. */
export const PERSPECTIVES: readonly PerspectiveDef[] = [
  {
    id: 'COMMERCIAL',
    name: 'Commercial',
    focus: 'Customers, opportunities, demand, price and service commitments.',
    dimensions: ['COMMERCIAL', 'CUSTOMER'],
    metricKeys: [],
    words: /customer|tender|opportunit|service level|revenue|demand|key account|rohto|strategic account|delivery date/i,
    supported: dimsSupport(['COMMERCIAL', 'CUSTOMER'], 'commercial or customer'),
  },
  {
    id: 'FINANCE',
    name: 'Finance',
    focus: 'Margin, cost, cash and capital.',
    dimensions: ['FINANCIAL', 'CAPITAL'],
    metricKeys: [],
    words: /margin|cash|cost|opex|price|profit|working capital|expense|budget/i,
    supported: dimsSupport(['FINANCIAL', 'CAPITAL'], 'financial or capital'),
  },
  {
    id: 'SUPPLY_CHAIN',
    name: 'Supply chain',
    focus: 'Inventory, allocation, lead time and fulfilment.',
    dimensions: ['OPERATIONAL'],
    metricKeys: ['AvailableInventory', 'InventoryRequirement', 'InventoryGap', 'LeadTime', 'OrderQuantity', 'AllocatedInventory', 'UnservedDemand', 'DemandQuantity', 'SourcingResilience'],
    words: /inventory|stock|supply|lead time|allocation|consignment|distributor|transfer|fulfil|delivery|ships from/i,
    supported: dimsSupport(['OPERATIONAL'], 'operational'),
  },
  {
    id: 'OPERATIONS',
    name: 'Operations',
    focus: 'Capacity, utilisation, constraints and the actions in flight.',
    dimensions: ['RESOURCE'],
    metricKeys: ['CapacityUtilization'],
    words: /capacity|utili[sz]ation|field service|constraint|action intent|throughput|in progress/i,
    supported: dimsSupport(['RESOURCE'], 'capacity or resource'),
  },
  {
    id: 'RISK',
    name: 'Risk',
    focus: 'Exposure, concentration, resilience and what is breached or blocked.',
    dimensions: ['RISK', 'RESILIENCE'],
    metricKeys: [],
    words: /risk|breach|blocked|concentration|resilien|exposure|challenge|contested|disproved|not evaluated|not authorized/i,
    supported: dimsSupport(['RISK', 'RESILIENCE'], 'risk or resilience'),
  },
  {
    id: 'STRATEGY',
    name: 'Strategy',
    focus: 'Objectives, strategic alignment and what management set out to protect.',
    dimensions: ['STRATEGIC'],
    metricKeys: [],
    words: /strategic|objective|protect|alignment|strategy|target of/i,
    supported: dimsSupport(['STRATEGIC'], 'strategic'),
  },
  {
    id: 'PEOPLE',
    name: 'People',
    focus: 'The organisation itself: capability, capacity of teams, succession.',
    dimensions: [],
    metricKeys: [],
    words: /headcount|hiring|attrition|capability|team capacity|succession/i,
    supported: (c) =>
      c.hrItems > 0
        ? { supported: true, reason: `${c.hrItems} HR-restricted item(s).` }
        : { supported: false, reason: 'HELM holds no people data: no HR source is connected and no reading is about people. Role occupancy is governance, not people data — and HELM never scores or ranks a person.' },
  },
  {
    id: 'ENTERPRISE_VALUE',
    name: 'Enterprise value',
    focus: 'The several dimensions of value at once — never one score.',
    dimensions: [],
    metricKeys: [],
    words: /enterprise value/i,
    supported: (c) => (c.hasEnterpriseValue ? { supported: true, reason: 'Enterprise value is modelled in several dimensions.' } : { supported: false, reason: 'No enterprise-value readings are held.' }),
  },
];

export const perspectiveOf = (id: PerspectiveId): PerspectiveDef => PERSPECTIVES.find((p) => p.id === id)!;

/** Reads coverage from the data-coverage evidence the tools returned. */
export function coverageOf(evidence: readonly EvidenceItem[]): Coverage {
  const byDimension = new Map<string, number>();
  let hr = 0;
  let ev = false;
  for (const e of evidence) {
    if (e.section === 'coverage') {
      const n = Number(/^(\d+)/.exec(e.values[0] ?? '')?.[1] ?? 0);
      if (e.status === 'HR_RESTRICTED') hr = n;
      else if (e.status === 'ENTERPRISE_VALUE') ev = n > 0;
      else if (e.status) byDimension.set(e.status, n);
    }
  }
  return { byDimension, hrItems: hr, hasEnterpriseValue: ev };
}

/** Is this evidence relevant to the perspective? Dimension and metric first; words only for evidence that has neither. */
export function relevantTo(p: PerspectiveDef, e: EvidenceItem): boolean {
  if (e.section === 'coverage') return false;
  if (e.metricKey && p.metricKeys.includes(e.metricKey)) return true;
  if (e.dimension) return p.dimensions.includes(e.dimension) && !(p.id === 'SUPPLY_CHAIN' && e.metricKey === 'CapacityUtilization');
  return p.words.test(`${e.label} ${e.values.join(' ')} ${e.status ?? ''}`);
}
