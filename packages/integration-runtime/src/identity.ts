/**
 * Identity mapping: source · external id · canonical HELM identity.
 *
 * A name is a label, never an identity — two customers can share one and one
 * customer has many. An alias is a source's durable identifier for an entity
 * (its id, code, tax id). Registering the same alias twice is one alias, and
 * one alias naming two entities is a CONFLICT that is reported, never merged:
 * over-merging silently corrupts every number downstream.
 */

import type { Entity } from '@helm/ontology';
import type { GraphStore } from '@helm/graph-store';
import { fail, ok, type EntityId, type Result, type Scope, type SourceSystem } from '@helm/shared';
import { IntegrationErrors, type AliasMutation } from './types.ts';

export type AliasKind = AliasMutation['aliasKind'];

export interface IdentityMapper {
  /** Idempotent. Refuses an alias another entity already holds. */
  register(scope: Scope, entityId: EntityId, system: SourceSystem, kind: AliasKind, value: string, provenance?: Record<string, unknown>): Promise<Result<{ created: boolean }>>;
  /** The entity a source's identifier resolves to, or null. Never resolves by name. */
  resolve(scope: Scope, system: SourceSystem, value: string): Promise<Result<Entity | null>>;
  /** Every identifier any system uses for this entity — its provenance of identity. */
  aliasesOf(scope: Scope, entityId: EntityId): Promise<Result<readonly { system: SourceSystem; kind: string; value: string; matchMethod: string }[]>>;
}

export function createIdentityMapper(graph: GraphStore): IdentityMapper {
  return {
    async register(scope, entityId, system, kind, value, evidence) {
      if ((kind as string) === 'name') return fail(IntegrationErrors.NAME_IS_NOT_IDENTITY, 'A name is a label, not an identity: register a source id, code, tax id, email or domain.');
      if (!value.trim()) return fail(IntegrationErrors.INVALID, 'An alias has a value.');
      const held = await graph.findByAlias(scope, system, value);
      if (!held.ok) return held;
      const others = held.value.filter((e) => e.id !== entityId);
      if (others.length > 0) {
        return fail(IntegrationErrors.IDENTITY_CONFLICT, `${system} identifier "${value}" already names ${others[0]!.name} (${others[0]!.canonicalKey}); it is reported as a conflict, not merged.`, { existing: others.map((e) => e.id) });
      }
      const existing = await graph.getAliases(scope, entityId);
      if (!existing.ok) return existing;
      const already = existing.value.some((a) => a.system === system && a.aliasKind === kind && a.normalizedValue === value.trim().toLowerCase() && a.validTo === null);
      if (already) return ok({ created: false });
      const added = await graph.addAlias(scope, { entityId, system, aliasKind: kind, aliasValue: value, matchMethod: 'exact', confidence: 1, evidence: evidence ?? null, createdBy: scope.actorId });
      if (!added.ok) return added;
      return ok({ created: true });
    },

    async resolve(scope, system, value) {
      const r = await graph.findByAlias(scope, system, value);
      if (!r.ok) return r;
      if (r.value.length > 1) return fail(IntegrationErrors.IDENTITY_CONFLICT, `${system} identifier "${value}" names ${r.value.length} entities; identity is ambiguous.`);
      return ok(r.value[0] ?? null);
    },

    async aliasesOf(scope, entityId) {
      const r = await graph.getAliases(scope, entityId);
      if (!r.ok) return r;
      return ok(r.value.filter((a) => a.validTo === null).map((a) => ({ system: a.system, kind: a.aliasKind, value: a.aliasValue, matchMethod: a.matchMethod })));
    },
  };
}
