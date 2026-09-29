/**
 * Delegation bounds (ADR-0022 §8).
 *
 *   delegated authority ≤ the delegator's own authority
 *
 * checked when a delegation is created — a Country GM cannot hand over
 * regional authority, a decision type they hold no rule for, an act they do not
 * hold, or a looser cash line than their own — and enforced again at every
 * evaluation, where the delegate's effective authority is the delegator's rule
 * INTERSECTED with the delegation, and only while the delegator still sits in
 * the role.
 */

import { conditionWithin, describeCondition } from './conditions.ts';
import { policiesInForce, rulesInForce, occupanciesAt } from './policy.ts';
import { constraintsWithin } from './scope.ts';
import type { AuthorityAct, AuthorityCondition, AuthorityPolicy, AuthorityRule, RoleOccupancy, ScopeConstraint } from './types.ts';

export type DelegationDraft = {
  readonly delegatorUserId: string;
  readonly delegatorRoleId: string;
  readonly delegateUserId: string;
  readonly decisionTypes: readonly string[];
  readonly acts: readonly AuthorityAct[];
  readonly scope: readonly ScopeConstraint[];
  readonly conditions: readonly AuthorityCondition[];
  readonly validFrom: string;
  readonly validTo: string;
  readonly reason: string;
};

export type DelegationValidation = {
  readonly valid: boolean;
  readonly problems: readonly string[];
};

const typeName = (key: string): string => key.replaceAll('_', ' ').toLowerCase();

export function validateDelegation(input: {
  draft: DelegationDraft;
  /** When the delegation is being recorded. */
  now: string;
  policies: readonly AuthorityPolicy[];
  rules: readonly AuthorityRule[];
  occupancies: readonly RoleOccupancy[];
  /** Every entity an entity sits within, from the graph. */
  ancestry: (entityId: string) => readonly string[];
}): DelegationValidation {
  const { draft } = input;
  const problems: string[] = [];

  if (draft.delegatorUserId === draft.delegateUserId) problems.push('a person cannot delegate to themselves');
  if (draft.reason.trim().length < 8) problems.push('a delegation needs a reason');
  if (draft.decisionTypes.length === 0) problems.push('a delegation must name the decision types it covers');
  if (draft.acts.length === 0) problems.push('a delegation must name the acts it covers');
  if (!(new Date(draft.validTo).getTime() > new Date(draft.validFrom).getTime())) {
    problems.push('a delegation needs an end after its start; one without an end is a change of role, not a delegation');
  }

  const holds = occupanciesAt(input.occupancies, draft.delegatorUserId, input.now).some((o) => o.roleId === draft.delegatorRoleId);
  if (!holds) problems.push('the delegator does not occupy the role whose authority they are delegating');

  // The delegator's authority as it will stand when the delegation starts, as known now.
  const at = new Date(draft.validFrom).getTime() > new Date(input.now).getTime() ? draft.validFrom : input.now;
  const inForce = rulesInForce(input.rules, policiesInForce(input.policies, at, input.now), input.now).filter(
    (r) => r.effect === 'GRANT' && r.holder.kind === 'ROLE' && r.holder.roleId === draft.delegatorRoleId,
  );

  for (const type of draft.decisionTypes) {
    for (const act of draft.acts) {
      const grants = inForce.filter((r) => r.decisionTypes.includes(type) && r.acts.includes(act));
      if (grants.length === 0) {
        problems.push(`the delegator holds no ${act} authority for ${typeName(type)}, so none can be delegated`);
        continue;
      }
      // Some one rule of the delegator must bound the whole delegation.
      const explanations: string[] = [];
      const bounded = grants.some((rule) => {
        const scope = constraintsWithin(draft.scope, rule.scope, input.ancestry);
        const lines = rule.conditions.map((outer) => {
          const narrowed = draft.conditions.filter((inner) => inner.metricKey === outer.metricKey);
          return narrowed.length > 0 && narrowed.every((inner) => conditionWithin(inner, outer))
            ? null
            : `the delegator's line ${describeCondition(outer)} is ${narrowed.length === 0 ? 'dropped' : 'loosened'} by the delegation`;
        });
        const lineProblems = lines.filter((x): x is string => x !== null);
        explanations.push(...scope.problems, ...lineProblems);
        return scope.within && lineProblems.length === 0;
      });
      if (!bounded) {
        problems.push(`${act} for ${typeName(type)} would exceed the delegator's own authority: ${[...new Set(explanations)].join('; ')}`);
      }
    }
  }
  return { valid: problems.length === 0, problems };
}
