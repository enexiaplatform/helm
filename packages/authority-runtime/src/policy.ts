/**
 * What authority was in force, and who held it, at an instant (ADR-0022 §7).
 *
 * Both lenses are the act time: a policy, an occupancy or a delegation
 * reaches an act only if it was VALID then and RECORDED by then. A DOA version
 * recorded tomorrow — even one back-dated to last month — does not reach a
 * commitment made today. That is what "no retroactive authority" means here.
 */

import type { UserId } from '@helm/shared';
import type { AuthorityPolicy, AuthorityRule, Delegation, RoleOccupancy } from './types.ts';

const t = (iso: string): number => new Date(iso).getTime();

/** Is [from, to) open at `at`? */
export const openAt = (from: string, to: string | null, at: string): boolean =>
  t(from) <= t(at) && (to === null || t(at) < t(to));

/**
 * The version of each policy key in force at `at`, as known at `knownAt`: the
 * latest validFrom at or before `at`. Versions are never edited, so a later
 * version supersedes an earlier one by existing, not by closing it.
 */
export function policiesInForce(
  policies: readonly AuthorityPolicy[],
  at: string,
  knownAt: string = at,
): AuthorityPolicy[] {
  const byKey = new Map<string, AuthorityPolicy>();
  for (const p of policies) {
    if (t(p.recordedAt) > t(knownAt)) continue;
    if (!openAt(p.validFrom, p.validTo, at)) continue;
    const current = byKey.get(p.key);
    if (
      !current ||
      t(p.validFrom) > t(current.validFrom) ||
      (t(p.validFrom) === t(current.validFrom) && p.version > current.version)
    ) {
      byKey.set(p.key, p);
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function rulesInForce(
  rules: readonly AuthorityRule[],
  inForce: readonly AuthorityPolicy[],
  knownAt: string,
): AuthorityRule[] {
  const ids = new Set(inForce.map((p) => p.id));
  return rules
    .filter((r) => ids.has(r.policyId) && t(r.recordedAt) <= t(knownAt))
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

/** The roles a person occupied at `at`, as recorded by `at`. */
export function occupanciesAt(
  occupancies: readonly RoleOccupancy[],
  userId: UserId | string,
  at: string,
): RoleOccupancy[] {
  return occupancies
    .filter((o) => o.userId === userId && t(o.recordedAt) <= t(at) && openAt(o.validFrom, o.validTo, at))
    .sort((a, b) => a.roleLabel.localeCompare(b.roleLabel) || a.id.localeCompare(b.id));
}

/** Who occupied a role at `at`. */
export function occupantsOf(occupancies: readonly RoleOccupancy[], roleId: string, at: string): RoleOccupancy[] {
  return occupancies
    .filter((o) => o.roleId === roleId && t(o.recordedAt) <= t(at) && openAt(o.validFrom, o.validTo, at))
    .sort((a, b) => a.personLabel.localeCompare(b.personLabel) || a.id.localeCompare(b.id));
}

/** Delegations naming this person as delegate — every one, valid or not, for the explanation. */
export function delegationsTo(delegations: readonly Delegation[], userId: UserId | string): Delegation[] {
  return delegations
    .filter((d) => d.delegateUserId === userId)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id));
}
