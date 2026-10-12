/**
 * The customer behind an opportunity, for labels.
 *
 * Audit 2026-10-12: "Canister / Tailin / Cons" appeared four times on one page and named no customer; a manager thinks
 * in customers. The stored labels stay as they are — they are part of fingerprints and history — and a page adds the
 * customer at display time, read from the entity graph (an opportunity HELD_BY its customer) as the reader may see it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Scope } from '@helm/shared';
import { useHelmStore } from './helmStore.ts';
import { cloudScope, demoScope, resolveGraphs } from './ontologyGraph.ts';

export type CustomerNames = {
  /** Opportunity entity id → the customer that holds it. */
  readonly bySubject: ReadonlyMap<string, string>;
  /** Value node id → the customer of the opportunity it is about. */
  readonly byNode: ReadonlyMap<string, string>;
};

const EMPTY: CustomerNames = { bySubject: new Map(), byNode: new Map() };
const cache = new Map<string, Promise<CustomerNames>>();

/** Read once per organization and reader in this window; a failed read labels nothing and is not cached. */
export function loadCustomerNames(mode: 'demo' | 'cloud', scope: Scope): Promise<CustomerNames> {
  const key = `${mode}|${String(scope.orgId)}|${String(scope.actorId)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<CustomerNames> => {
    const graphs = await resolveGraphs(mode);
    if (!graphs) return EMPTY;
    const [rels, customers, nodes] = await Promise.all([
      graphs.graphStore.findRelationships(scope, { relationshipTypeKeys: ['HELD_BY'] }),
      graphs.graphStore.findEntities(scope, { entityTypeKeys: ['Customer'], includeSubtypes: true }),
      graphs.valueGraph.findValueNodes(scope, { limit: 1000 }),
    ]);
    if (!rels.ok || !customers.ok) return EMPTY;
    const nameOf = new Map(customers.value.map((c) => [String(c.id), c.name]));
    const bySubject = new Map<string, string>();
    for (const r of rels.value) {
      const name = nameOf.get(String(r.targetEntityId));
      if (name) bySubject.set(String(r.sourceEntityId), name);
    }
    const byNode = new Map<string, string>();
    if (nodes.ok) for (const n of nodes.value) if (n.subjectEntityId && bySubject.has(String(n.subjectEntityId))) byNode.set(String(n.id), bySubject.get(String(n.subjectEntityId))!);
    return { bySubject, byNode };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

/** "Expected Revenue — Canister / Tailin / Cons · CÔNG TY …"; a label that already names the customer is left alone. */
export function withCustomer(label: string, customer: string | null | undefined): string {
  if (!customer || label.includes(customer)) return label;
  return `${label} · ${customer}`;
}

/** The current organization's customer names, and labelling helpers bound to them. Empty until read; never blocks a page. */
export function useCustomerNames() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [names, setNames] = useState<CustomerNames>(EMPTY);
  useEffect(() => {
    let live = true;
    if (!scope || !mode) return;
    void loadCustomerNames(mode, scope)
      .then((n) => live && setNames(n))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mode, scope]);
  return useMemo(
    () => ({
      names,
      forSubject: (label: string, subjectId: string | null | undefined) => withCustomer(label, subjectId ? names.bySubject.get(String(subjectId)) : null),
      forNode: (label: string, nodeId: string | null | undefined) => withCustomer(label, nodeId ? names.byNode.get(String(nodeId)) : null),
    }),
    [names],
  );
}
