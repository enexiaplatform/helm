/**
 * InMemoryAuthorityStore — held to the same contract as the Postgres adapter
 * (`runAuthorityStoreConformanceSuite`).
 *
 * The immutability rules live here as well as in the database triggers:
 * policies, rules, evaluations, requirements and acts are write-once and
 * deep-frozen; an occupancy is closed once; a delegation is revoked once; an
 * approval act must name a requirement of the same commitment fingerprint, and
 * cannot be given by the person the requirement must be independent of.
 */

import { canonicalNumeric } from '@helm/propagation-engine';
import { fail, ok, type Clock, type IdGen, type Result, type Scope } from '@helm/shared';
import {
  AuthorityErrors,
  SEEDED_DECISION_TYPES,
  type ApprovalAct,
  type AuthorityEvaluation,
  type AuthorityPolicy,
  type AuthorityRule,
  type DecisionGovernanceProfile,
  type DecisionVisibilityGrant,
  type Delegation,
  type RequiredApproval,
  type RoleOccupancy,
} from './types.ts';
import type { AuthorityStore } from './port.ts';

export type InMemoryAuthorityStoreOptions = { clock: Clock; idGen: IdGen };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const later = (a: string, b: string): boolean => new Date(a).getTime() > new Date(b).getTime();
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

/** Shared input checks, so both adapters refuse the same things with the same words. */
export function checkRule(input: Omit<AuthorityRule, 'id' | 'orgId'>): Result<true> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(input.key)) {
    return fail(AuthorityErrors.INVALID_INPUT, `Rule key "${input.key}" must be lower-case letters, digits and dashes.`);
  }
  if (input.decisionTypes.length === 0 || input.acts.length === 0) {
    return fail(AuthorityErrors.INVALID_INPUT, 'A rule must name at least one decision type and one act.');
  }
  if (input.rationale.trim().length < 8) {
    return fail(AuthorityErrors.INVALID_INPUT, 'A rule needs a rationale: why does this authority exist?');
  }
  for (const c of input.conditions) {
    if (!DECIMAL.test(canonicalNumeric(c.threshold))) {
      return fail(AuthorityErrors.INVALID_INPUT, `Threshold "${c.threshold}" is not an exact decimal.`);
    }
  }
  if (input.effect !== 'GRANT' && input.holder.kind !== 'ROLE') {
    return fail(AuthorityErrors.INVALID_INPUT, 'An exception or a requirement names a role, not a person.');
  }
  if (input.effect === 'RESTRICT' && !input.escalationRoleId) {
    return fail(AuthorityErrors.INVALID_INPUT, 'An exception must say whose authority the restricted commitment goes to.');
  }
  if (input.scope.some((s) => s.entities.length === 0)) {
    return fail(AuthorityErrors.INVALID_INPUT, 'A scope constraint with no entities would match nothing; leave the dimension out instead.');
  }
  return ok(true);
}

export function createInMemoryAuthorityStore(opts: InMemoryAuthorityStoreOptions): AuthorityStore {
  const { idGen } = opts;
  const policies = new Map<string, AuthorityPolicy>();
  const rules = new Map<string, AuthorityRule>();
  const occupancies = new Map<string, RoleOccupancy>();
  const delegations = new Map<string, Delegation>();
  const profiles = new Map<string, DecisionGovernanceProfile>();
  const grants = new Map<string, DecisionVisibilityGrant>();
  const evaluations = new Map<string, AuthorityEvaluation>();
  const requirements = new Map<string, RequiredApproval>();
  const acts = new Map<string, ApprovalAct>();

  const mine = <T extends { orgId: string }>(scope: Scope, row: T | undefined): T | null =>
    row && row.orgId === scope.orgId ? row : null;
  const all = <T extends { orgId: string }>(scope: Scope, map: Map<string, T>): T[] =>
    [...map.values()].filter((x) => x.orgId === scope.orgId);
  const put = <T extends { id: string }>(map: Map<string, T>, row: T): Result<T> => {
    map.set(row.id, deepFreeze(row));
    return ok(row);
  };

  return {
    async listDecisionTypes() {
      return ok(SEEDED_DECISION_TYPES);
    },

    // ------------------------------------------------------------- policies
    async recordPolicy(scope, input) {
      if (!Number.isInteger(input.version) || input.version < 1) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A policy version is a positive whole number.');
      }
      if (input.validTo !== null && !later(input.validTo, input.validFrom)) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A policy must end after it starts.');
      }
      if (all(scope, policies).some((p) => p.key === input.key && p.version === input.version)) {
        return fail(
          AuthorityErrors.IMMUTABLE,
          `${input.key} v${input.version} is already recorded. A changed policy is a new version, not an edit.`,
        );
      }
      if (input.supersedesPolicyId && !mine(scope, policies.get(input.supersedesPolicyId))) {
        return fail(AuthorityErrors.NOT_FOUND, 'The superseded policy is not in this organization.');
      }
      return put(policies, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async getPolicy(scope, id) {
      return ok(mine(scope, policies.get(id)));
    },
    async listPolicies(scope) {
      return ok(all(scope, policies).sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version));
    },

    // ---------------------------------------------------------------- rules
    async recordRule(scope, input) {
      const policy = mine(scope, policies.get(input.policyId));
      if (!policy) return fail(AuthorityErrors.NOT_FOUND, 'A rule must belong to a policy of this organization.');
      const checked = checkRule(input);
      if (!checked.ok) return checked;
      if (all(scope, rules).some((r) => r.policyId === input.policyId && r.key === input.key)) {
        return fail(AuthorityErrors.IMMUTABLE, `Rule "${input.key}" already exists in ${policy.reference} v${policy.version}.`);
      }
      return put(rules, {
        ...input,
        conditions: input.conditions.map((c) => ({ ...c, threshold: canonicalNumeric(c.threshold) })),
        id: idGen.next(),
        orgId: scope.orgId,
      });
    },
    async getRule(scope, id) {
      return ok(mine(scope, rules.get(id)));
    },
    async listRules(scope) {
      return ok(all(scope, rules).sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id)));
    },

    // ------------------------------------------------------------ occupancy
    async recordOccupancy(scope, input) {
      if (input.validTo !== null && !later(input.validTo, input.validFrom)) {
        return fail(AuthorityErrors.INVALID_INPUT, 'An occupancy must end after it starts.');
      }
      if (input.basis.trim().length < 4) return fail(AuthorityErrors.INVALID_INPUT, 'An occupancy needs a basis.');
      return put(occupancies, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async endOccupancy(scope, id, validTo) {
      const o = mine(scope, occupancies.get(id));
      if (!o) return fail(AuthorityErrors.NOT_FOUND, `Occupancy ${id} not found.`);
      if (o.validTo !== null) {
        return fail(AuthorityErrors.IMMUTABLE, 'That occupancy has already ended; its history is not rewritten.');
      }
      if (!later(validTo, o.validFrom)) return fail(AuthorityErrors.INVALID_INPUT, 'An occupancy must end after it starts.');
      return put(occupancies, { ...o, validTo });
    },
    async listOccupancies(scope) {
      return ok(all(scope, occupancies).sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id)));
    },

    // ----------------------------------------------------------- delegation
    async recordDelegation(scope, input) {
      if (!later(input.validTo, input.validFrom)) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A delegation must end after it starts.');
      }
      if (input.delegatorUserId === input.delegateUserId) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A person cannot delegate to themselves.');
      }
      if (input.revokedAt !== null) return fail(AuthorityErrors.INVALID_INPUT, 'A delegation is recorded unrevoked.');
      const seated = all(scope, occupancies).some(
        (o) =>
          o.userId === input.delegatorUserId &&
          o.roleId === input.delegatorRoleId &&
          !later(o.validFrom, input.recordedAt) &&
          (o.validTo === null || later(o.validTo, input.recordedAt)),
      );
      if (!seated) {
        return fail(AuthorityErrors.DELEGATION_EXCEEDS_AUTHORITY, 'The delegator does not occupy the role whose authority they delegate.');
      }
      return put(delegations, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async revokeDelegation(scope, id, revokedAt, reason) {
      const d = mine(scope, delegations.get(id));
      if (!d) return fail(AuthorityErrors.NOT_FOUND, `Delegation ${id} not found.`);
      if (d.revokedAt !== null) return fail(AuthorityErrors.IMMUTABLE, 'That delegation is already revoked.');
      if (reason.trim().length < 4) return fail(AuthorityErrors.INVALID_INPUT, 'Revoking a delegation needs a reason.');
      return put(delegations, { ...d, revokedAt, revokedReason: reason });
    },
    async getDelegation(scope, id) {
      return ok(mine(scope, delegations.get(id)));
    },
    async listDelegations(scope) {
      return ok(all(scope, delegations).sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id)));
    },

    // ------------------------------------------------ decision governance data
    async recordProfile(scope, input) {
      return put(profiles, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async listProfiles(scope, decisionId) {
      return ok(
        all(scope, profiles)
          .filter((p) => p.decisionId === decisionId)
          .sort((a, b) => a.declaredAt.localeCompare(b.declaredAt) || a.id.localeCompare(b.id)),
      );
    },
    async grantVisibility(scope, input) {
      if (all(scope, grants).some((g) => g.decisionId === input.decisionId && g.orgUnitId === input.orgUnitId)) {
        return fail(AuthorityErrors.IMMUTABLE, 'The decision is already shared with that unit.');
      }
      return put(grants, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async listVisibility(scope, decisionId) {
      return ok(all(scope, grants).filter((g) => g.decisionId === decisionId));
    },

    // ----------------------------------------------------------- evaluations
    async recordEvaluation(scope, input) {
      if (input.result === 'AUTHORIZED' && input.basisRuleId === null) {
        return fail(AuthorityErrors.INVALID_INPUT, 'An AUTHORIZED verdict must name the rule it rests on.');
      }
      if (input.result === 'INDETERMINATE' && input.gaps.length === 0) {
        return fail(AuthorityErrors.INVALID_INPUT, 'An INDETERMINATE verdict must name what is missing.');
      }
      if ((input.result === 'INDETERMINATE') !== (input.governability === 'NOT_GOVERNABLE')) {
        return fail(AuthorityErrors.INVALID_INPUT, 'Only an INDETERMINATE verdict is NOT_GOVERNABLE.');
      }
      if (input.explanation.length === 0) {
        return fail(AuthorityErrors.INVALID_INPUT, 'An evaluation always explains itself.');
      }
      if (input.supersedesEvaluationId && !mine(scope, evaluations.get(input.supersedesEvaluationId))) {
        return fail(AuthorityErrors.NOT_FOUND, 'The superseded evaluation is not in this organization.');
      }
      return put(evaluations, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async getEvaluation(scope, id) {
      return ok(mine(scope, evaluations.get(id)));
    },
    async listEvaluations(scope, filter) {
      return ok(
        all(scope, evaluations)
          .filter((e) => (!filter.commitmentId || e.commitmentId === filter.commitmentId) && (!filter.decisionId || e.decisionId === filter.decisionId))
          .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.id.localeCompare(b.id)),
      );
    },

    // ---------------------------------------------------------- requirements
    async recordRequiredApproval(scope, input) {
      const e = mine(scope, evaluations.get(input.evaluationId));
      if (!e) return fail(AuthorityErrors.NOT_FOUND, 'A required approval must come from an evaluation in this organization.');
      if (e.commitmentId !== input.commitmentId || e.commitmentFingerprint !== input.commitmentFingerprint) {
        return fail(AuthorityErrors.FINGERPRINT_MISMATCH, 'A required approval belongs to the commitment fingerprint its evaluation judged.');
      }
      if (e.result !== 'REQUIRES_APPROVAL' && e.result !== 'ESCALATED') {
        return fail(AuthorityErrors.INVALID_INPUT, `An evaluation that is ${e.result} requires no approval.`);
      }
      return put(requirements, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async getRequiredApproval(scope, id) {
      return ok(mine(scope, requirements.get(id)));
    },
    async listRequiredApprovals(scope, filter) {
      return ok(
        all(scope, requirements)
          .filter((r) => (!filter.evaluationId || r.evaluationId === filter.evaluationId) && (!filter.commitmentId || r.commitmentId === filter.commitmentId))
          .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      );
    },

    // ------------------------------------------------------------------ acts
    async recordApprovalAct(scope, input) {
      const r = mine(scope, requirements.get(input.requiredApprovalId));
      if (!r) return fail(AuthorityErrors.NOT_FOUND, 'An approval act must answer a required approval in this organization.');
      if (
        r.commitmentFingerprint !== input.commitmentFingerprint ||
        r.commitmentId !== input.commitmentId ||
        r.evaluationId !== input.evaluationId
      ) {
        return fail(AuthorityErrors.FINGERPRINT_MISMATCH, 'An approval act answers exactly the commitment fingerprint its requirement was raised for.');
      }
      if (all(scope, acts).some((a) => a.requiredApprovalId === input.requiredApprovalId)) {
        return fail(AuthorityErrors.ALREADY_ACTED, 'That requirement already has a recorded response; an act is never replaced.');
      }
      if (r.independentOfUserId !== null && r.independentOfUserId === input.approverUserId) {
        return fail(
          AuthorityErrors.SEPARATION_OF_DUTIES,
          'This approval must be independent of the person who committed, and they are the same person.',
        );
      }
      if (input.approverRoleId !== r.roleId) {
        return fail(AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY, `The requirement is for ${r.roleLabel}.`);
      }
      if (input.decision !== 'APPROVE' && input.comments.trim().length < 4) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A rejection or a return says why.');
      }
      const openAt = (from: string, to: string | null) =>
        !later(from, input.actedAt) && (to === null || later(to, input.actedAt));
      // The role is resolved from a seat or a delegation actually held at the act — never taken as text.
      if (input.basis.kind === 'ROLE_OCCUPANCY') {
        const o = input.basis.occupancyId ? mine(scope, occupancies.get(input.basis.occupancyId)) : null;
        if (!o || o.userId !== input.approverUserId || o.roleId !== r.roleId || later(o.recordedAt, input.actedAt) || !openAt(o.validFrom, o.validTo)) {
          return fail(AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY, 'The approver did not occupy the required role when acting.');
        }
      } else {
        const d = input.basis.delegationId ? mine(scope, delegations.get(input.basis.delegationId)) : null;
        if (
          !d ||
          d.delegateUserId !== input.approverUserId ||
          d.delegatorRoleId !== r.roleId ||
          !d.acts.includes('APPROVE') ||
          later(d.recordedAt, input.actedAt) ||
          !openAt(d.validFrom, d.validTo) ||
          (d.revokedAt !== null && !later(d.revokedAt, input.actedAt))
        ) {
          return fail(AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY, 'The approver held no delegation of the required role when acting.');
        }
      }
      return put(acts, { ...input, id: idGen.next(), orgId: scope.orgId });
    },
    async getApprovalAct(scope, id) {
      return ok(mine(scope, acts.get(id)));
    },
    async listApprovalActs(scope, filter) {
      return ok(
        all(scope, acts)
          .filter(
            (a) =>
              (!filter.requiredApprovalId || a.requiredApprovalId === filter.requiredApprovalId) &&
              (!filter.commitmentId || a.commitmentId === filter.commitmentId) &&
              (!filter.evaluationId || a.evaluationId === filter.evaluationId),
          )
          .sort((a, b) => a.actedAt.localeCompare(b.actedAt) || a.id.localeCompare(b.id)),
      );
    },
  };
}
