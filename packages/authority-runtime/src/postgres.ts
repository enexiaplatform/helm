/**
 * PostgresAuthorityStore — the AuthorityStore over Supabase.
 *
 * The I/O boundary of @helm/authority-runtime, held to the same conformance
 * suite as the in-memory store. Two layers enforce the contract: this adapter
 * checks what it can before writing (so a caller gets a typed error), and the
 * database's guard triggers and RLS refuse the rest — identity, fingerprint
 * coherence, separation of duties, write-once history — so a client that
 * bypasses this adapter gets nowhere either. Every query is also filtered by
 * org_id, so a policy mistake could never widen a read by itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalNumeric } from '@helm/propagation-engine';
import { fail, ok, type Clock, type OrgId, type Result, type Scope, type UserId } from '@helm/shared';
import { checkRule } from './inMemoryStore.ts';
import {
  AuthorityErrors,
  type ApprovalAct,
  type AuthorityEvaluation,
  type AuthorityPolicy,
  type AuthorityRule,
  type DecisionGovernanceProfile,
  type DecisionTypeDefinition,
  type DecisionVisibilityGrant,
  type Delegation,
  type RequiredApproval,
  type RoleOccupancy,
} from './types.ts';
import type { AuthorityStore } from './port.ts';

export type PostgresAuthorityStoreOptions = {
  client: SupabaseClient;
  clock: Clock;
};

type Row = Record<string, unknown>;

const iso = (t: unknown): string | null => (t === null || t === undefined ? null : new Date(t as string).toISOString());
const isoReq = (t: unknown): string => new Date(t as string).toISOString();
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = <T>(v: unknown, fallback: T): T => (v && typeof v === 'object' ? (v as T) : fallback);
const uid = (v: unknown): UserId | null => (v === null || v === undefined ? null : (v as UserId));

const POLICY_COLS =
  'id, org_id, key, version, title, reference, source, demo, rationale, valid_from, valid_to, recorded_at, recorded_by, supersedes_policy_id';
const RULE_COLS =
  'id, org_id, policy_id, key, holder_kind, holder_role_id, holder_user_id, holder_label, effect, decision_types, acts, scope, ' +
  'conditions, escalation_role_id, escalation_role_label, approval_independence, approval_sequence, rationale, recorded_at';
const OCCUPANCY_COLS =
  'id, org_id, role_id, role_label, user_id, person_entity_id, person_label, kind, valid_from, valid_to, basis, recorded_at, recorded_by, ended_at';
const DELEGATION_COLS =
  'id, org_id, delegator_user_id, delegator_label, delegator_role_id, delegator_role_label, delegate_user_id, delegate_label, ' +
  'decision_types, acts, scope, conditions, valid_from, valid_to, reason, recorded_at, revoked_at, revoked_reason';
const PROFILE_COLS = 'id, org_id, decision_id, decision_type_key, declared_subjects, note, declared_by, declared_at';
const GRANT_COLS = 'id, org_id, decision_id, org_unit_id, org_unit_label, reason, granted_by, granted_at';
const EVALUATION_COLS =
  'id, org_id, decision_id, commitment_id, commitment_fingerprint, act, actor_user_id, actor_label, actor_roles, act_at, ' +
  'evaluated_at, evaluated_by, decision_type_key, profile_id, policies, scope, consequences, rules, delegations, basis_rule_id, ' +
  'basis_delegation_id, result, required_authorities, escalation_chain, authorities_in_scope, gaps, governability, explanation, ' +
  'fingerprint, supersedes_evaluation_id, evaluator';
const REQUIRED_COLS =
  'id, org_id, evaluation_id, decision_id, commitment_id, commitment_fingerprint, role_id, role_label, basis_rule_id, kind, ' +
  'reason, sequence, independent_of_user_id, created_at';
const ACT_COLS =
  'id, org_id, required_approval_id, evaluation_id, decision_id, commitment_id, commitment_fingerprint, approver_user_id, ' +
  'approver_label, approver_role_id, approver_role_label, basis_kind, basis_occupancy_id, basis_delegation_id, basis_rule_id, ' +
  'decision, comments, conditions, valid_until, acted_at';

// ------------------------------------------------------------------ mappers

const toPolicy = (r: Row): AuthorityPolicy => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  key: String(r.key),
  version: Number(r.version),
  title: String(r.title),
  reference: String(r.reference),
  source: r.source as AuthorityPolicy['source'],
  demo: Boolean(r.demo),
  rationale: String(r.rationale),
  validFrom: isoReq(r.valid_from),
  validTo: iso(r.valid_to),
  recordedAt: isoReq(r.recorded_at),
  recordedBy: uid(r.recorded_by),
  supersedesPolicyId: (r.supersedes_policy_id as string | null) ?? null,
});

const toRule = (r: Row): AuthorityRule => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  policyId: String(r.policy_id),
  key: String(r.key),
  holder:
    r.holder_kind === 'PERSON'
      ? { kind: 'PERSON', userId: String(r.holder_user_id), label: String(r.holder_label) }
      : { kind: 'ROLE', roleId: String(r.holder_role_id), label: String(r.holder_label) },
  effect: r.effect as AuthorityRule['effect'],
  decisionTypes: arr<string>(r.decision_types),
  acts: arr<AuthorityRule['acts'][number]>(r.acts),
  scope: arr(r.scope),
  conditions: arr<AuthorityRule['conditions'][number]>(r.conditions).map((c) => ({ ...c, threshold: canonicalNumeric(String(c.threshold)) })),
  escalationRoleId: (r.escalation_role_id as string | null) ?? null,
  escalationRoleLabel: (r.escalation_role_label as string | null) ?? null,
  approvalIndependence: r.approval_independence as AuthorityRule['approvalIndependence'],
  approvalSequence: Number(r.approval_sequence),
  rationale: String(r.rationale),
  recordedAt: isoReq(r.recorded_at),
});

const toOccupancy = (r: Row): RoleOccupancy => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  roleId: String(r.role_id),
  roleLabel: String(r.role_label),
  userId: r.user_id as UserId,
  personEntityId: (r.person_entity_id as string | null) ?? null,
  personLabel: String(r.person_label),
  kind: r.kind as RoleOccupancy['kind'],
  validFrom: isoReq(r.valid_from),
  validTo: iso(r.valid_to),
  basis: String(r.basis),
  recordedAt: isoReq(r.recorded_at),
  recordedBy: uid(r.recorded_by),
  endedAt: iso(r.ended_at),
});

const toDelegation = (r: Row): Delegation => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  delegatorUserId: r.delegator_user_id as UserId,
  delegatorLabel: String(r.delegator_label),
  delegatorRoleId: String(r.delegator_role_id),
  delegatorRoleLabel: String(r.delegator_role_label),
  delegateUserId: r.delegate_user_id as UserId,
  delegateLabel: String(r.delegate_label),
  decisionTypes: arr<string>(r.decision_types),
  acts: arr<Delegation['acts'][number]>(r.acts),
  scope: arr(r.scope),
  conditions: arr(r.conditions),
  validFrom: isoReq(r.valid_from),
  validTo: isoReq(r.valid_to),
  reason: String(r.reason),
  recordedAt: isoReq(r.recorded_at),
  revokedAt: iso(r.revoked_at),
  revokedReason: (r.revoked_reason as string | null) ?? null,
});

const toProfile = (r: Row): DecisionGovernanceProfile => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  decisionId: String(r.decision_id),
  decisionTypeKey: (r.decision_type_key as string | null) ?? null,
  declaredSubjects: arr(r.declared_subjects),
  note: String(r.note ?? ''),
  declaredBy: uid(r.declared_by),
  declaredAt: isoReq(r.declared_at),
});

const toGrant = (r: Row): DecisionVisibilityGrant => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  decisionId: String(r.decision_id),
  orgUnitId: String(r.org_unit_id),
  orgUnitLabel: String(r.org_unit_label),
  reason: String(r.reason),
  grantedBy: uid(r.granted_by),
  grantedAt: isoReq(r.granted_at),
});

const toEvaluation = (r: Row): AuthorityEvaluation => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  decisionId: String(r.decision_id),
  commitmentId: String(r.commitment_id),
  commitmentFingerprint: String(r.commitment_fingerprint),
  act: r.act as AuthorityEvaluation['act'],
  actorUserId: uid(r.actor_user_id),
  actorLabel: String(r.actor_label),
  actorRoles: arr(r.actor_roles),
  actAt: isoReq(r.act_at),
  evaluatedAt: isoReq(r.evaluated_at),
  evaluatedBy: uid(r.evaluated_by),
  decisionTypeKey: (r.decision_type_key as string | null) ?? null,
  profileId: (r.profile_id as string | null) ?? null,
  policies: arr(r.policies),
  scope: obj(r.scope, { touched: [], summary: {}, unresolved: [] }),
  consequences: arr(r.consequences),
  rules: arr(r.rules),
  delegations: arr(r.delegations),
  basisRuleId: (r.basis_rule_id as string | null) ?? null,
  basisDelegationId: (r.basis_delegation_id as string | null) ?? null,
  result: r.result as AuthorityEvaluation['result'],
  requiredAuthorities: arr(r.required_authorities),
  escalationChain: arr(r.escalation_chain),
  authoritiesInScope: arr(r.authorities_in_scope),
  gaps: arr(r.gaps),
  governability: r.governability as AuthorityEvaluation['governability'],
  explanation: arr<string>(r.explanation),
  fingerprint: String(r.fingerprint),
  supersedesEvaluationId: (r.supersedes_evaluation_id as string | null) ?? null,
  evaluator: obj(r.evaluator, { kind: 'CLIENT_RUNTIME', host: 'unknown', consequenceCheck: { status: 'NOT_CHECKED', runIds: [], checkedSteps: 0, checkedInputs: 0 } }),
});

const toRequired = (r: Row): RequiredApproval => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  evaluationId: String(r.evaluation_id),
  decisionId: String(r.decision_id),
  commitmentId: String(r.commitment_id),
  commitmentFingerprint: String(r.commitment_fingerprint),
  roleId: String(r.role_id),
  roleLabel: String(r.role_label),
  basisRuleId: String(r.basis_rule_id),
  kind: r.kind as RequiredApproval['kind'],
  reason: String(r.reason),
  sequence: Number(r.sequence),
  independentOfUserId: uid(r.independent_of_user_id),
  createdAt: isoReq(r.created_at),
});

const toAct = (r: Row): ApprovalAct => ({
  id: String(r.id),
  orgId: r.org_id as OrgId,
  requiredApprovalId: String(r.required_approval_id),
  evaluationId: String(r.evaluation_id),
  decisionId: String(r.decision_id),
  commitmentId: String(r.commitment_id),
  commitmentFingerprint: String(r.commitment_fingerprint),
  approverUserId: r.approver_user_id as UserId,
  approverLabel: String(r.approver_label),
  approverRoleId: String(r.approver_role_id),
  approverRoleLabel: String(r.approver_role_label),
  basis: {
    kind: r.basis_kind as ApprovalAct['basis']['kind'],
    occupancyId: (r.basis_occupancy_id as string | null) ?? null,
    delegationId: (r.basis_delegation_id as string | null) ?? null,
    ruleId: (r.basis_rule_id as string | null) ?? null,
  },
  decision: r.decision as ApprovalAct['decision'],
  comments: String(r.comments ?? ''),
  conditions: String(r.conditions ?? ''),
  validUntil: iso(r.valid_until),
  actedAt: isoReq(r.acted_at),
});

// ------------------------------------------------------------------- store

export function createPostgresAuthorityStore(opts: PostgresAuthorityStoreOptions): AuthorityStore {
  const { client } = opts;

  const written = <T>(data: unknown, error: { message: string } | null, map: (r: Row) => T): Result<T> =>
    error || !data ? fail(AuthorityErrors.WRITE_FAILED, error?.message ?? 'nothing was written') : ok(map(data as Row));
  const read = <T>(data: unknown, error: { message: string } | null, map: (r: Row) => T): Result<T[]> =>
    error ? fail(AuthorityErrors.READ_FAILED, error.message) : ok(((data as Row[] | null) ?? []).map(map));
  const readOne = <T>(data: unknown, error: { message: string } | null, map: (r: Row) => T): Result<T | null> =>
    error ? fail(AuthorityErrors.READ_FAILED, error.message) : ok(data ? map(data as Row) : null);

  const insert = async <T>(scope: Scope, table: string, row: Row, cols: string, map: (r: Row) => T): Promise<Result<T>> => {
    const { data, error } = await client.from(table).insert({ ...row, org_id: scope.orgId }).select(cols).single();
    return written(data, error, map);
  };
  const byId = async <T>(scope: Scope, table: string, id: string, cols: string, map: (r: Row) => T): Promise<Result<T | null>> => {
    const { data, error } = await client.from(table).select(cols).eq('org_id', scope.orgId).eq('id', id).maybeSingle();
    return readOne(data, error, map);
  };

  return {
    async listDecisionTypes(scope) {
      const { data, error } = await client
        .from('helm_decision_types')
        .select('key, name, description, org_id')
        .or(`org_id.is.null,org_id.eq.${scope.orgId}`)
        .order('key');
      if (error) return fail(AuthorityErrors.READ_FAILED, error.message);
      return ok(
        ((data as Row[] | null) ?? []).map((r): DecisionTypeDefinition => ({
          key: String(r.key),
          name: String(r.name),
          description: String(r.description ?? ''),
          orgId: (r.org_id as string | null) ?? null,
        })),
      );
    },
    async registerDecisionType(scope, input) {
      // The registry guard refuses a system key and the unique index a repeat.
      const { data, error } = await client
        .from('helm_decision_types')
        .insert({ key: input.key, name: input.name, description: input.description, org_id: scope.orgId })
        .select('key, name, description, org_id')
        .single();
      if (error) return fail(AuthorityErrors.WRITE_FAILED, error.message);
      const r = data as Row;
      return ok({ key: String(r.key), name: String(r.name), description: String(r.description ?? ''), orgId: String(r.org_id) });
    },

    async recordPolicy(scope, input) {
      return insert(
        scope,
        'helm_authority_policies',
        {
          key: input.key,
          version: input.version,
          title: input.title,
          reference: input.reference,
          source: input.source,
          demo: input.demo,
          rationale: input.rationale,
          valid_from: input.validFrom,
          valid_to: input.validTo,
          recorded_at: input.recordedAt,
          recorded_by: input.recordedBy,
          supersedes_policy_id: input.supersedesPolicyId,
        },
        POLICY_COLS,
        toPolicy,
      );
    },
    async getPolicy(scope, id) {
      return byId(scope, 'helm_authority_policies', id, POLICY_COLS, toPolicy);
    },
    async listPolicies(scope) {
      const { data, error } = await client.from('helm_authority_policies').select(POLICY_COLS).eq('org_id', scope.orgId).order('key').order('version');
      return read(data, error, toPolicy);
    },

    async recordRule(scope, input) {
      const checked = checkRule(input);
      if (!checked.ok) return checked;
      return insert(
        scope,
        'helm_authority_rules',
        {
          policy_id: input.policyId,
          key: input.key,
          holder_kind: input.holder.kind,
          holder_role_id: input.holder.kind === 'ROLE' ? input.holder.roleId : null,
          holder_user_id: input.holder.kind === 'PERSON' ? input.holder.userId : null,
          holder_label: input.holder.label,
          effect: input.effect,
          decision_types: input.decisionTypes,
          acts: input.acts,
          scope: input.scope,
          conditions: input.conditions.map((c) => ({ ...c, threshold: canonicalNumeric(c.threshold) })),
          escalation_role_id: input.escalationRoleId,
          escalation_role_label: input.escalationRoleLabel,
          approval_independence: input.approvalIndependence,
          approval_sequence: input.approvalSequence,
          rationale: input.rationale,
          recorded_at: input.recordedAt,
        },
        RULE_COLS,
        toRule,
      );
    },
    async getRule(scope, id) {
      return byId(scope, 'helm_authority_rules', id, RULE_COLS, toRule);
    },
    async listRules(scope) {
      const { data, error } = await client.from('helm_authority_rules').select(RULE_COLS).eq('org_id', scope.orgId).order('key').order('id');
      return read(data, error, toRule);
    },

    async recordOccupancy(scope, input) {
      return insert(
        scope,
        'helm_role_occupancies',
        {
          role_id: input.roleId,
          role_label: input.roleLabel,
          user_id: input.userId,
          person_entity_id: input.personEntityId,
          person_label: input.personLabel,
          kind: input.kind,
          valid_from: input.validFrom,
          valid_to: input.validTo,
          basis: input.basis,
          recorded_at: input.recordedAt,
          recorded_by: input.recordedBy,
        },
        OCCUPANCY_COLS,
        toOccupancy,
      );
    },
    async endOccupancy(scope, id, validTo) {
      const { data, error } = await client
        .from('helm_role_occupancies')
        // ended_at is stamped by the database (the record time of the ending).
        .update({ valid_to: validTo })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(OCCUPANCY_COLS)
        .single();
      return written(data, error, toOccupancy);
    },
    async listOccupancies(scope) {
      const { data, error } = await client.from('helm_role_occupancies').select(OCCUPANCY_COLS).eq('org_id', scope.orgId).order('valid_from').order('id');
      return read(data, error, toOccupancy);
    },

    async recordDelegation(scope, input) {
      return insert(
        scope,
        'helm_delegations',
        {
          delegator_user_id: input.delegatorUserId,
          delegator_label: input.delegatorLabel,
          delegator_role_id: input.delegatorRoleId,
          delegator_role_label: input.delegatorRoleLabel,
          delegate_user_id: input.delegateUserId,
          delegate_label: input.delegateLabel,
          decision_types: input.decisionTypes,
          acts: input.acts,
          scope: input.scope,
          conditions: input.conditions,
          valid_from: input.validFrom,
          valid_to: input.validTo,
          reason: input.reason,
          recorded_at: input.recordedAt,
        },
        DELEGATION_COLS,
        toDelegation,
      );
    },
    async revokeDelegation(scope, id, revokedAt, reason) {
      const { data, error } = await client
        .from('helm_delegations')
        .update({ revoked_at: revokedAt, revoked_reason: reason })
        .eq('org_id', scope.orgId)
        .eq('id', id)
        .select(DELEGATION_COLS)
        .single();
      return written(data, error, toDelegation);
    },
    async getDelegation(scope, id) {
      return byId(scope, 'helm_delegations', id, DELEGATION_COLS, toDelegation);
    },
    async listDelegations(scope) {
      const { data, error } = await client.from('helm_delegations').select(DELEGATION_COLS).eq('org_id', scope.orgId).order('valid_from').order('id');
      return read(data, error, toDelegation);
    },

    async recordProfile(scope, input) {
      return insert(
        scope,
        'helm_decision_governance_profiles',
        {
          decision_id: input.decisionId,
          decision_type_key: input.decisionTypeKey,
          declared_subjects: input.declaredSubjects,
          note: input.note,
          declared_by: input.declaredBy,
          declared_at: input.declaredAt,
        },
        PROFILE_COLS,
        toProfile,
      );
    },
    async listProfiles(scope, decisionId) {
      const { data, error } = await client
        .from('helm_decision_governance_profiles')
        .select(PROFILE_COLS)
        .eq('org_id', scope.orgId)
        .eq('decision_id', decisionId)
        .order('declared_at')
        .order('id');
      return read(data, error, toProfile);
    },

    async grantVisibility(scope, input) {
      return insert(
        scope,
        'helm_decision_visibility',
        {
          decision_id: input.decisionId,
          org_unit_id: input.orgUnitId,
          org_unit_label: input.orgUnitLabel,
          reason: input.reason,
          granted_by: input.grantedBy,
          granted_at: input.grantedAt,
        },
        GRANT_COLS,
        toGrant,
      );
    },
    async listVisibility(scope, decisionId) {
      const { data, error } = await client.from('helm_decision_visibility').select(GRANT_COLS).eq('org_id', scope.orgId).eq('decision_id', decisionId);
      return read(data, error, toGrant);
    },

    async recordEvaluation(scope, input) {
      return insert(
        scope,
        'helm_authority_evaluations',
        {
          decision_id: input.decisionId,
          commitment_id: input.commitmentId,
          commitment_fingerprint: input.commitmentFingerprint,
          act: input.act,
          actor_user_id: input.actorUserId,
          actor_label: input.actorLabel,
          actor_roles: input.actorRoles,
          act_at: input.actAt,
          evaluated_at: input.evaluatedAt,
          evaluated_by: input.evaluatedBy,
          decision_type_key: input.decisionTypeKey,
          profile_id: input.profileId,
          policies: input.policies,
          scope: input.scope,
          consequences: input.consequences,
          rules: input.rules,
          delegations: input.delegations,
          basis_rule_id: input.basisRuleId,
          basis_delegation_id: input.basisDelegationId,
          result: input.result,
          required_authorities: input.requiredAuthorities,
          escalation_chain: input.escalationChain,
          authorities_in_scope: input.authoritiesInScope,
          gaps: input.gaps,
          governability: input.governability,
          explanation: input.explanation,
          fingerprint: input.fingerprint,
          supersedes_evaluation_id: input.supersedesEvaluationId,
          evaluator: input.evaluator,
        },
        EVALUATION_COLS,
        toEvaluation,
      );
    },
    async getEvaluation(scope, id) {
      return byId(scope, 'helm_authority_evaluations', id, EVALUATION_COLS, toEvaluation);
    },
    async listEvaluations(scope, filter) {
      let q = client.from('helm_authority_evaluations').select(EVALUATION_COLS).eq('org_id', scope.orgId);
      if (filter.commitmentId) q = q.eq('commitment_id', filter.commitmentId);
      if (filter.decisionId) q = q.eq('decision_id', filter.decisionId);
      const { data, error } = await q.order('evaluated_at').order('id');
      return read(data, error, toEvaluation);
    },

    async recordRequiredApproval(scope, input) {
      return insert(
        scope,
        'helm_required_approvals',
        {
          evaluation_id: input.evaluationId,
          decision_id: input.decisionId,
          commitment_id: input.commitmentId,
          commitment_fingerprint: input.commitmentFingerprint,
          role_id: input.roleId,
          role_label: input.roleLabel,
          basis_rule_id: input.basisRuleId,
          kind: input.kind,
          reason: input.reason,
          sequence: input.sequence,
          independent_of_user_id: input.independentOfUserId,
          created_at: input.createdAt,
        },
        REQUIRED_COLS,
        toRequired,
      );
    },
    async getRequiredApproval(scope, id) {
      return byId(scope, 'helm_required_approvals', id, REQUIRED_COLS, toRequired);
    },
    async listRequiredApprovals(scope, filter) {
      let q = client.from('helm_required_approvals').select(REQUIRED_COLS).eq('org_id', scope.orgId);
      if (filter.evaluationId) q = q.eq('evaluation_id', filter.evaluationId);
      if (filter.commitmentId) q = q.eq('commitment_id', filter.commitmentId);
      const { data, error } = await q.order('sequence').order('created_at').order('id');
      return read(data, error, toRequired);
    },

    async recordApprovalAct(scope, input) {
      return insert(
        scope,
        'helm_approval_acts',
        {
          required_approval_id: input.requiredApprovalId,
          evaluation_id: input.evaluationId,
          decision_id: input.decisionId,
          commitment_id: input.commitmentId,
          commitment_fingerprint: input.commitmentFingerprint,
          approver_user_id: input.approverUserId,
          approver_label: input.approverLabel,
          approver_role_id: input.approverRoleId,
          approver_role_label: input.approverRoleLabel,
          basis_kind: input.basis.kind,
          basis_occupancy_id: input.basis.occupancyId,
          basis_delegation_id: input.basis.delegationId,
          basis_rule_id: input.basis.ruleId,
          decision: input.decision,
          comments: input.comments,
          conditions: input.conditions,
          valid_until: input.validUntil,
          acted_at: input.actedAt,
        },
        ACT_COLS,
        toAct,
      );
    },
    async getApprovalAct(scope, id) {
      return byId(scope, 'helm_approval_acts', id, ACT_COLS, toAct);
    },
    async listApprovalActs(scope, filter) {
      let q = client.from('helm_approval_acts').select(ACT_COLS).eq('org_id', scope.orgId);
      if (filter.requiredApprovalId) q = q.eq('required_approval_id', filter.requiredApprovalId);
      if (filter.commitmentId) q = q.eq('commitment_id', filter.commitmentId);
      if (filter.evaluationId) q = q.eq('evaluation_id', filter.evaluationId);
      const { data, error } = await q.order('acted_at').order('id');
      return read(data, error, toAct);
    },
  };
}
