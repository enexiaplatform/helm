/**
 * Decision VISIBILITY — who may read a decision (ADR-0022 §12).
 *
 * This module never imports the authority engine, and the engine never imports
 * it. Seeing a decision and having authority over it are different questions:
 * a Finance Director may read a Commercial decision they have no authority to
 * commit, and a Commercial Director may hold authority over a decision type
 * without being able to read a decision nobody shared with their unit.
 *
 * The same rule is enforced server-side by `helm_can_see_decision()` in RLS;
 * this is its kernel twin, used in demo mode and to state the semantics once.
 *
 *   visible  ⇔  org admin
 *            ∨  the decision's creator
 *            ∨  a member of a granted unit, or of any unit above one
 *               (membership of Vietnam sees Vietnam's Pharma BU)
 *
 * No grant means creator and admins only. Deny is the default.
 */

export type OrgUnit = {
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly unitType: string;
};

export type VisibilityViewer = {
  readonly userId: string;
  readonly orgRole: 'admin' | 'manager' | 'member' | 'viewer';
  /** The units the viewer is a member of (org_unit_memberships). */
  readonly memberUnitIds: readonly string[];
};

export type VisibilityVerdict = {
  readonly visible: boolean;
  readonly reason: string;
};

/** Every unit a member of `memberUnitIds` may see: those units and everything below them. */
export function visibleUnits(units: readonly OrgUnit[], memberUnitIds: readonly string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const u of units) {
    if (u.parentId === null) continue;
    const list = children.get(u.parentId) ?? [];
    list.push(u.id);
    children.set(u.parentId, list);
  }
  const out = new Set<string>();
  const stack = [...memberUnitIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export function canSeeDecision(
  viewer: VisibilityViewer,
  decision: { readonly createdBy: string | null; readonly grantedUnitIds: readonly string[] },
  units: readonly OrgUnit[],
): VisibilityVerdict {
  if (viewer.orgRole === 'admin') return { visible: true, reason: 'organization admin' };
  if (decision.createdBy !== null && decision.createdBy === viewer.userId) {
    return { visible: true, reason: 'created the decision' };
  }
  const reach = visibleUnits(units, viewer.memberUnitIds);
  const via = decision.grantedUnitIds.find((id) => reach.has(id));
  if (via) {
    const label = units.find((u) => u.id === via)?.label ?? via;
    return { visible: true, reason: `the decision is shared with ${label}, within the viewer's units` };
  }
  return {
    visible: false,
    reason:
      decision.grantedUnitIds.length === 0
        ? 'the decision is shared with no unit, so only its creator and admins can read it'
        : 'the decision is shared only with units outside the viewer\'s own',
  };
}
