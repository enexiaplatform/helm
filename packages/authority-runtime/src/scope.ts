/**
 * Enterprise scope — where a commitment sits, and whether a rule reaches it
 * (ADR-0022 §4).
 *
 * A commitment's scope is DERIVED from the graph. HELM takes the entities
 * behind its computed consequences (and the chosen scenario's overrides, and
 * any subject the decision declares) and walks the anchoring edges upward to
 * find what each one sits within: SKU-X → Diagnostics Portfolio ← owned by
 * Pharma BU → Vietnam → Southeast Asia. Nobody types "Vietnam, Pharma" into a
 * form.
 *
 * Coverage is checked PER TOUCHED ENTITY and never flattened: a grant must
 * reach every entity the commitment touches, so authority over Vietnam Pharma
 * does not reach an Industrial BU entity, and authority over Vietnam does not
 * reach a regional pool that sits above Vietnam.
 */

import type { GraphStore } from '@helm/graph-store';
import type { Result, Scope } from '@helm/shared';
import { ok } from '@helm/shared';
import type {
  CommitmentScope,
  EntityRef,
  ScopeCheck,
  ScopeConstraint,
  ScopeDimension,
  TouchedEntity,
  TouchOrigin,
} from './types.ts';

/** Ontology entity type → the scope dimension it provides. */
export const DIMENSION_OF_ENTITY_TYPE: Readonly<Record<string, ScopeDimension>> = {
  Enterprise: 'ENTERPRISE',
  Region: 'REGION',
  Country: 'COUNTRY',
  BusinessUnit: 'BUSINESS_UNIT',
  Portfolio: 'PORTFOLIO',
  Product: 'PRODUCT',
  Function: 'FUNCTION',
  Segment: 'SEGMENT',
  Customer: 'CUSTOMER',
};

/**
 * The org chain, ordered from broadest to narrowest. An entity anchored at a
 * shallower level of the chain than a rule constrains sits ABOVE it — outside
 * the rule, not unknown to it.
 */
export const ORG_CHAIN: readonly ScopeDimension[] = [
  'ENTERPRISE',
  'REGION',
  'COUNTRY',
  'BUSINESS_UNIT',
  'PORTFOLIO',
  'PRODUCT',
];

/** Side axes: an entity without one is neutral to it, not outside it. */
export const SIDE_AXES: readonly ScopeDimension[] = ['FUNCTION', 'SEGMENT', 'CUSTOMER'];

/** How narrow a constraint on each dimension is, for precedence. */
export const DIMENSION_DEPTH: Readonly<Record<ScopeDimension, number>> = {
  ENTERPRISE: 0,
  REGION: 1,
  COUNTRY: 2,
  BUSINESS_UNIT: 3,
  FUNCTION: 3,
  PORTFOLIO: 4,
  SEGMENT: 4,
  PRODUCT: 5,
  CUSTOMER: 6,
};

/**
 * The anchoring edges: the relationships that say what an entity is PART OF.
 * Data, stated once, so the derivation is inspectable and nothing about a
 * particular company is hard-coded. Only upward edges: the walk never goes
 * from Vietnam down into its business units.
 */
export const SCOPE_ANCHORS: readonly { relationshipTypeKey: string; direction: 'out' | 'in'; reads: string }[] = [
  { relationshipTypeKey: 'BELONGS_TO', direction: 'out', reads: 'belongs to' },
  { relationshipTypeKey: 'HELD_BY', direction: 'out', reads: 'is held by' },
  { relationshipTypeKey: 'SELLS', direction: 'out', reads: 'sells' },
  { relationshipTypeKey: 'POSITIONS', direction: 'out', reads: 'positions' },
  { relationshipTypeKey: 'OWNS', direction: 'in', reads: 'is owned by' },
  { relationshipTypeKey: 'INCURS', direction: 'in', reads: 'is incurred by' },
];

const MAX_ANCHOR_DEPTH = 8;

export type TouchRequest = {
  readonly entityId: string;
  readonly origin: TouchOrigin;
  readonly via: string;
};

/**
 * Places each touched entity in the graph, as of `asOf`. An entity the graph
 * cannot place in ANY dimension is reported as unresolved; the evaluation
 * treats that as an unknown scope, never as an empty one.
 */
export async function resolveCommitmentScope(
  graph: GraphStore,
  scope: Scope,
  requests: readonly TouchRequest[],
  asOf: string,
): Promise<Result<CommitmentScope>> {
  const touched: TouchedEntity[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const request of requests) {
    if (seen.has(request.entityId)) continue;
    seen.add(request.entityId);
    const start = await graph.getEntity(scope, request.entityId as never);
    if (!start.ok) return start;
    if (!start.value) {
      unresolved.push(`${request.via}: entity ${request.entityId} is not in this organization's graph`);
      continue;
    }

    const coordinates: Partial<Record<ScopeDimension, EntityRef[]>> = {};
    const place = (entityTypeKey: string, ref: EntityRef) => {
      const dimension = DIMENSION_OF_ENTITY_TYPE[entityTypeKey];
      if (!dimension) return;
      const list = (coordinates[dimension] ??= []);
      if (!list.some((r) => r.entityId === ref.entityId)) list.push(ref);
    };
    place(start.value.entityTypeKey, { entityId: start.value.id, label: start.value.name });

    // Breadth-first up the anchoring edges, remembering how each entity was reached.
    const reachedBy = new Map<string, string>([[start.value.id, start.value.name]]);
    let frontier: string[] = [start.value.id];
    for (let depth = 0; depth < MAX_ANCHOR_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const anchor of SCOPE_ANCHORS) {
          const neighbors = await graph.getNeighbors(scope, {
            entityId: id as never,
            direction: anchor.direction,
            relationshipTypeKeys: [anchor.relationshipTypeKey],
            asOf,
          });
          if (!neighbors.ok) return neighbors;
          for (const n of neighbors.value) {
            if (reachedBy.has(n.entity.id)) continue;
            reachedBy.set(n.entity.id, `${reachedBy.get(id)} → ${anchor.reads} → ${n.entity.name}`);
            place(n.entity.entityTypeKey, { entityId: n.entity.id, label: n.entity.name });
            next.push(n.entity.id);
          }
        }
      }
      frontier = next;
    }

    const placed = Object.values(coordinates).some((list) => (list ?? []).length > 0);
    if (!placed) {
      unresolved.push(`${start.value.name} (${request.via}) sits in no dimension HELM can place`);
    }
    // Only the maximal routes: "tender → sells → SKU-X → … → Meridian", not every prefix of it.
    const routes = [...reachedBy.entries()].filter(([id]) => id !== start.value!.id).map(([, route]) => route);
    const path = routes.filter((route) => !routes.some((other) => other !== route && other.startsWith(`${route} → `)));

    touched.push({
      entityId: start.value.id,
      label: start.value.name,
      entityTypeKey: start.value.entityTypeKey,
      origin: request.origin,
      via: request.via,
      coordinates,
      path,
    });
  }

  return ok({ touched, summary: summarize(touched), unresolved });
}

/** The union of every touched entity's coordinates. For reading, never for coverage. */
export function summarize(touched: readonly TouchedEntity[]): CommitmentScope['summary'] {
  const out: Partial<Record<ScopeDimension, EntityRef[]>> = {};
  for (const t of touched) {
    for (const [dimension, refs] of Object.entries(t.coordinates) as [ScopeDimension, readonly EntityRef[]][]) {
      const list = (out[dimension] ??= []);
      for (const r of refs) if (!list.some((x) => x.entityId === r.entityId)) list.push(r);
    }
  }
  return out;
}

/** Builds a scope directly from placed entities — for tests and the pure engine. */
export function scopeOf(touched: readonly TouchedEntity[], unresolved: readonly string[] = []): CommitmentScope {
  return { touched, summary: summarize(touched), unresolved };
}

const labels = (refs: readonly EntityRef[]): string => refs.map((r) => r.label).join(', ');
const readableDimension = (d: ScopeDimension): string => d.replaceAll('_', ' ').toLowerCase();

/**
 * Does a GRANT reach every entity the commitment touches? For each dimension
 * the rule constrains, every touched entity must sit within an allowed entity.
 *
 *   org-chain dimension   an entity with a coordinate in it must be allowed;
 *                         one anchored only ABOVE it (a regional pool under a
 *                         country rule) is OUTSIDE; one not on the chain at
 *                         all is UNKNOWN.
 *   side axis             the commitment's coordinates on the axis must exist
 *                         and all be allowed; an entity without the axis is
 *                         neutral.
 */
export function checkCoverage(constraints: readonly ScopeConstraint[], scope: CommitmentScope): ScopeCheck[] {
  return constraints.map((constraint) => {
    const allowed = new Set(constraint.entities.map((e) => e.entityId));
    const outside: string[] = [];
    const unknown: string[] = [];
    const d = constraint.dimension;

    if (SIDE_AXES.includes(d)) {
      const onAxis = scope.touched.flatMap((t) => t.coordinates[d] ?? []);
      if (onAxis.length === 0) {
        return {
          dimension: d,
          allowed: constraint.entities,
          mode: 'COVERS_ALL' as const,
          outcome: 'OUTSIDE' as const,
          statement: `The rule is limited to ${readableDimension(d)} ${labels(constraint.entities)}; the commitment touches no ${readableDimension(d)} at all.`,
        };
      }
      for (const ref of onAxis) if (!allowed.has(ref.entityId)) outside.push(ref.label);
    } else {
      const level = ORG_CHAIN.indexOf(d);
      for (const t of scope.touched) {
        const here = t.coordinates[d] ?? [];
        if (here.length > 0) {
          const stray = here.filter((r) => !allowed.has(r.entityId));
          if (stray.length > 0) outside.push(`${t.label} (${labels(stray)})`);
          continue;
        }
        const above = ORG_CHAIN.slice(0, level).some((up) => (t.coordinates[up] ?? []).length > 0);
        if (above) outside.push(`${t.label} (sits above ${readableDimension(d)} level)`);
        else unknown.push(t.label);
      }
    }

    const outcome = outside.length > 0 ? ('OUTSIDE' as const) : unknown.length > 0 ? ('UNKNOWN' as const) : ('WITHIN' as const);
    const statement =
      outcome === 'WITHIN'
        ? `${readableDimension(d)} ${labels(constraint.entities)} ✓ — every touched entity sits within it.`
        : outcome === 'OUTSIDE'
          ? `${readableDimension(d)} ${labels(constraint.entities)} ✗ — outside it: ${outside.join('; ')}.`
          : `${readableDimension(d)} ${labels(constraint.entities)} — cannot be established: the graph does not place ${unknown.join(', ')} in any ${readableDimension(d)}.`;
    return { dimension: d, allowed: constraint.entities, mode: 'COVERS_ALL' as const, outcome, statement };
  });
}

/**
 * Does an exception or a requirement APPLY? It applies when, in every
 * dimension it constrains, the commitment reaches into the constrained scope.
 * "Rohto requires the Country GM" applies to any commitment that touches Rohto.
 */
export function checkTouches(constraints: readonly ScopeConstraint[], scope: CommitmentScope): ScopeCheck[] {
  return constraints.map((constraint) => {
    const allowed = new Set(constraint.entities.map((e) => e.entityId));
    const d = constraint.dimension;
    const hits = scope.touched.filter((t) => (t.coordinates[d] ?? []).some((r) => allowed.has(r.entityId)));
    return {
      dimension: d,
      allowed: constraint.entities,
      mode: 'TOUCHES' as const,
      outcome: hits.length > 0 ? ('WITHIN' as const) : ('OUTSIDE' as const),
      statement:
        hits.length > 0
          ? `touches ${readableDimension(d)} ${labels(constraint.entities)} through ${hits.map((h) => h.label).join(', ')}.`
          : `does not touch ${readableDimension(d)} ${labels(constraint.entities)}.`,
    };
  });
}

/** Overall outcome of a set of scope checks. */
export function scopeOutcome(checks: readonly ScopeCheck[]): 'WITHIN' | 'OUTSIDE' | 'UNKNOWN' {
  if (checks.some((c) => c.outcome === 'OUTSIDE')) return 'OUTSIDE';
  if (checks.some((c) => c.outcome === 'UNKNOWN')) return 'UNKNOWN';
  return 'WITHIN';
}

/**
 * Precedence of rules of the same kind: a person over a role, then the
 * narrowest constrained dimension, then how many dimensions are constrained.
 * Content only — never insertion order.
 */
export function specificityOf(rule: { holder: { kind: string }; scope: readonly ScopeConstraint[] }): readonly [number, number, number] {
  const holder = rule.holder.kind === 'PERSON' ? 1 : 0;
  const deepest = rule.scope.reduce((m, c) => Math.max(m, DIMENSION_DEPTH[c.dimension]), -1);
  return [holder, deepest, rule.scope.length];
}

export function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function describeSpecificity(rule: { holder: { kind: string }; scope: readonly ScopeConstraint[] }): string {
  const [, deepest, count] = specificityOf(rule);
  const narrowest = rule.scope.find((c) => DIMENSION_DEPTH[c.dimension] === deepest);
  return (
    `${rule.holder.kind === 'PERSON' ? 'person' : 'role'} holder; ` +
    (narrowest ? `narrowest dimension ${readableDimension(narrowest.dimension)}; ` : 'no scope constraint; ') +
    `${count} dimension${count === 1 ? '' : 's'} constrained`
  );
}

/** Is `inner` at least as narrow as `outer`? Used to bound a delegation. */
export function constraintsWithin(
  inner: readonly ScopeConstraint[],
  outer: readonly ScopeConstraint[],
  ancestry: (entityId: string) => readonly string[],
): { within: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const o of outer) {
    const allowed = new Set(o.entities.map((e) => e.entityId));
    // Every outer constraint must be matched by an inner constraint whose
    // entities all sit within the outer allowed set (directly or by ancestry).
    const candidates = inner.filter((i) => ORG_CHAIN.includes(o.dimension) || i.dimension === o.dimension);
    const satisfied = candidates.some((i) =>
      i.entities.every((e) => allowed.has(e.entityId) || ancestry(e.entityId).some((a) => allowed.has(a))),
    );
    if (!satisfied) {
      problems.push(
        `the delegator's authority is limited to ${readableDimension(o.dimension)} ${labels(o.entities)}, ` +
          'and the delegation does not stay inside it',
      );
    }
  }
  return { within: problems.length === 0, problems };
}
