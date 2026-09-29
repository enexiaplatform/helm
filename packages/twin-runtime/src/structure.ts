/**
 * Enterprise structure under a two-time lens.
 *
 * Which entities existed at `effectiveAsOf`, AS HELM BELIEVED THEM at
 * `recordedThrough`, and how they were connected. Nothing here reads "the
 * graph as it is now":
 *
 *   entity         skipped if first recorded after the knowledge boundary; when
 *                  it was updated after it, the version believed at the boundary
 *                  is read from the record-time history (ADR-0014)
 *   relationship   skipped if recorded after the boundary; valid at the business
 *                  time; a closure HELM only learned after the boundary is not
 *                  applied (the relationship was still believed open)
 *
 * Scope placement reuses the authority layer's anchoring edges
 * (SCOPE_ANCHORS), so "what sits within Vietnam" means the same thing to the
 * twin as to the authority engine — but it walks the relationships READ HERE,
 * under this lens, not the live graph.
 */

import { fail, ok, type Result, type Scope } from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { Entity, Relationship } from '@helm/ontology';
import { DIMENSION_OF_ENTITY_TYPE, ORG_CHAIN, SCOPE_ANCHORS } from '@helm/authority-runtime';
import { TwinErrors, type TwinLens, type TwinScope } from './types.ts';

export type Membership = 'CORE' | 'ATTACHED';

export type StructureView = {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly relationships: readonly Relationship[];
  /** Dimension → entity ids each entity sits within (itself included). */
  readonly placement: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>;
  readonly inScope: ReadonlyMap<string, Membership>;
  readonly anchor: Entity | null;
};

const ms = (t: string | null | undefined): number => (t ? Date.parse(t) : NaN);

/** Account classifications, carried as Segment entities a Customer BELONGS_TO (ADR-0025 §6). */
export const ACCOUNT_CLASSES = ['STRATEGIC_ACCOUNT', 'KEY_ACCOUNT', 'STANDARD_CUSTOMER'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export async function readStructure(
  graph: GraphStore,
  scope: Scope,
  lens: TwinLens,
  twinScope: TwinScope,
): Promise<Result<StructureView>> {
  const E = ms(lens.effectiveAsOf);
  const T = ms(lens.recordedThrough);

  const all = await graph.findEntities(scope, { includeInactive: true, limit: 100000 });
  if (!all.ok) return all;
  const entities = new Map<string, Entity>();
  for (const current of all.value) {
    if (ms(current.ingestedAt) > T) continue;
    let believed: Entity | null = current;
    if (ms(current.updatedAt) > T) {
      const then = await graph.getEntityAsRecordedAt(scope, current.id, lens.recordedThrough);
      if (!then.ok) return then;
      believed = then.value;
    }
    if (!believed || believed.status === 'merged') continue;
    if (ms(believed.validFrom) > E) continue;
    if (believed.validTo !== null && ms(believed.validTo) <= E) continue;
    entities.set(believed.id, believed);
  }

  const rels = await graph.findRelationships(scope, { includeClosed: true, limit: 100000 });
  if (!rels.ok) return rels;
  const relationships = rels.value
    .filter((r) => ms(r.ingestedAt) <= T)
    .filter((r) => ms(r.validFrom) <= E)
    // A closure is applied only if HELM knew of it by the boundary.
    .filter((r) => r.validTo === null || E < ms(r.validTo) || ms(r.updatedAt) > T)
    .filter((r) => entities.has(r.sourceEntityId) && entities.has(r.targetEntityId))
    .sort((a, b) => a.id.localeCompare(b.id));

  // --- placement: walk the anchoring edges upward from every entity ---
  const outgoing = new Map<string, Relationship[]>();
  const incoming = new Map<string, Relationship[]>();
  for (const r of relationships) {
    (outgoing.get(r.sourceEntityId) ?? outgoing.set(r.sourceEntityId, []).get(r.sourceEntityId)!).push(r);
    (incoming.get(r.targetEntityId) ?? incoming.set(r.targetEntityId, []).get(r.targetEntityId)!).push(r);
  }
  const placement = new Map<string, Record<string, string[]>>();
  for (const e of entities.values()) {
    const coords: Record<string, string[]> = {};
    const place = (x: Entity) => {
      const d = DIMENSION_OF_ENTITY_TYPE[x.entityTypeKey];
      if (!d) return;
      const list = (coords[d] ??= []);
      if (!list.includes(x.id)) list.push(x.id);
    };
    place(e);
    const seen = new Set<string>([e.id]);
    let frontier: string[] = [e.id];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const anchor of SCOPE_ANCHORS) {
          const edges = anchor.direction === 'out' ? outgoing.get(id) ?? [] : incoming.get(id) ?? [];
          for (const r of edges) {
            if (r.relationshipTypeKey !== anchor.relationshipTypeKey) continue;
            const other = anchor.direction === 'out' ? r.targetEntityId : r.sourceEntityId;
            if (seen.has(other)) continue;
            seen.add(other);
            place(entities.get(other)!);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    for (const list of Object.values(coords)) list.sort();
    placement.set(e.id, coords);
  }

  // --- scope membership ---
  const inScope = new Map<string, Membership>();
  let anchor: Entity | null = null;
  if (twinScope.kind === 'ENTERPRISE') {
    for (const id of entities.keys()) inScope.set(id, 'CORE');
  } else {
    anchor = entities.get(twinScope.entityId) ?? null;
    if (!anchor) {
      return fail(
        TwinErrors.SCOPE_UNRESOLVED,
        `${twinScope.label} did not exist at ${lens.effectiveAsOf} as HELM knew it on ${lens.recordedThrough}; ` +
          'a snapshot cannot be anchored on it.',
      );
    }
    for (const [id, coords] of placement) {
      if (id === anchor.id || Object.values(coords).some((list) => list.includes(anchor!.id))) inScope.set(id, 'CORE');
    }
    // ATTACHED: one hop from the core, and placed nowhere in the org chain — shared
    // context (a supplier, a warehouse, a role, a risk) rather than another unit's entity.
    const orgPlaced = (id: string) => ORG_CHAIN.some((d) => (placement.get(id)?.[d] ?? []).length > 0);
    for (const r of relationships) {
      const pairs: [string, string][] = [
        [r.sourceEntityId, r.targetEntityId],
        [r.targetEntityId, r.sourceEntityId],
      ];
      for (const [from, to] of pairs) {
        if (inScope.get(from) === 'CORE' && !inScope.has(to) && !orgPlaced(to)) inScope.set(to, 'ATTACHED');
      }
    }
  }
  // An in-scope customer's account classification is part of its structure.
  for (const r of relationships) {
    if (r.relationshipTypeKey !== 'BELONGS_TO' || !inScope.has(r.sourceEntityId) || inScope.has(r.targetEntityId)) continue;
    const target = entities.get(r.targetEntityId)!;
    const code = target.entityTypeKey === 'Segment' ? target.attributes.segmentCode : undefined;
    if (typeof code === 'string' && (ACCOUNT_CLASSES as readonly string[]).includes(code)) inScope.set(target.id, 'ATTACHED');
  }
  return ok({ entities, relationships, placement, inScope, anchor });
}

/** Where an entity sits in the org chain — the placement a snapshot records (side axes excluded). */
export function orgPlacement(view: StructureView, id: string): Record<string, readonly string[]> {
  const coords = view.placement.get(id) ?? {};
  return Object.fromEntries(ORG_CHAIN.filter((d) => (coords[d] ?? []).length > 0).map((d) => [d, coords[d]]));
}

/** The account classification a customer carries at this lens, if any. */
export function classificationOf(view: StructureView, customerId: string): { classification: AccountClass; segmentId: string; relationshipId: string } | null {
  for (const r of view.relationships) {
    if (r.sourceEntityId !== customerId || r.relationshipTypeKey !== 'BELONGS_TO') continue;
    const segment = view.entities.get(r.targetEntityId);
    const code = segment?.entityTypeKey === 'Segment' ? segment.attributes.segmentCode : undefined;
    if (typeof code === 'string' && (ACCOUNT_CLASSES as readonly string[]).includes(code)) {
      return { classification: code as AccountClass, segmentId: segment!.id, relationshipId: r.id };
    }
  }
  return null;
}
