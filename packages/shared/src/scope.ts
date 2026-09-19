/**
 * Scope — who is asking, and what they may see.
 *
 * There is no ambient tenant in HELM. Every kernel read and write takes a
 * Scope, resolved once per session and passed down. This is what makes the
 * tenant wall checkable in code as well as in RLS: an adapter that ignores
 * `scope.orgId` fails the conformance suite.
 *
 * Visibility is not authority. This type answers "what data may this actor
 * see?" — never "what may this actor approve?". That is the Authority Engine's
 * job in Phase 6, and conflating the two is the mistake this comment exists to
 * prevent.
 */

import type { OrgId, OrgUnitId, UserId } from './ids.ts';

export const orgRoles = ['admin', 'manager', 'member', 'viewer'] as const;
export type OrgRole = (typeof orgRoles)[number];

/** Ranked, so a new role slots in without rewriting every comparison. */
export const orgRoleRank: Record<OrgRole, number> = {
  admin: 4,
  manager: 3,
  member: 2,
  viewer: 1,
};

export type Scope = {
  /** The hard tenant wall. Also enforced by Postgres RLS. */
  orgId: OrgId;
  actorId: UserId;
  role: OrgRole;
  /**
   * Units this actor may see, subtree-inclusive.
   * Phase 1 populates it but does not filter on it — see security-model.md §3.
   */
  orgUnitIds: readonly OrgUnitId[];
  /** Functional visibility (commercial, supply_chain, finance…). Phase 6. */
  functions: readonly string[];
};

export const hasRole = (scope: Scope, min: OrgRole): boolean =>
  orgRoleRank[scope.role] >= orgRoleRank[min];

export const canRead = (scope: Scope): boolean => hasRole(scope, 'viewer');
export const canWrite = (scope: Scope): boolean => hasRole(scope, 'member');
export const canGovern = (scope: Scope): boolean => hasRole(scope, 'manager');
export const canAdminister = (scope: Scope): boolean => hasRole(scope, 'admin');
