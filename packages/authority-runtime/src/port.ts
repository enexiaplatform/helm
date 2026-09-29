/**
 * The Authority Runtime port, and the AuthorityStore it persists through.
 *
 * Two jobs, kept apart on purpose (ADR-0022 §9):
 *
 *   the ENGINE decides what authority a commitment needed — pure, in engine.ts;
 *   the RUNTIME records what people did about it — approval acts, delegations,
 *   occupancies — and assembles the engine's input from records that already
 *   exist: the commitment, the chosen run's future state and the graph.
 *
 * Every store method is tenant-scoped by `scope.orgId`. Recorded governance is
 * immutable: rules, policies, evaluations, requirements and acts are
 * write-once; an occupancy is closed once; a delegation is revoked once.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { DelegationValidation } from './delegation.ts';
import type { ConsequenceCheck } from './types.ts';
import type {
  ApprovalAct,
  ApprovalLineage,
  ApprovalRequest,
  AuthorityAct,
  AuthorityCondition,
  AuthorityEvaluation,
  AuthorityHolding,
  AuthorityPolicy,
  AuthorityRule,
  DecisionGovernanceProfile,
  DecisionTypeDefinition,
  DecisionVisibilityGrant,
  Delegation,
  EntityRef,
  GovernanceState,
  MaterialChangeReport,
  OccupancyKind,
  RequiredApproval,
  RoleOccupancy,
  ScopeConstraint,
} from './types.ts';

// ------------------------------------------------------------------ store

export type NewPolicy = Omit<AuthorityPolicy, 'id' | 'orgId'>;
export type NewRule = Omit<AuthorityRule, 'id' | 'orgId'>;
export type NewOccupancy = Omit<RoleOccupancy, 'id' | 'orgId' | 'endedAt'>;
export type NewDelegation = Omit<Delegation, 'id' | 'orgId'>;
export type NewProfile = Omit<DecisionGovernanceProfile, 'id' | 'orgId'>;
export type NewVisibilityGrant = Omit<DecisionVisibilityGrant, 'id' | 'orgId'>;
export type NewEvaluation = Omit<AuthorityEvaluation, 'id' | 'orgId'>;
export type NewRequiredApproval = Omit<RequiredApproval, 'id' | 'orgId'>;
export type NewApprovalAct = Omit<ApprovalAct, 'id' | 'orgId'>;

export type NewDecisionType = { key: string; name: string; description: string };

export interface AuthorityStore {
  /** The system types and this organization's own — never another organization's. */
  listDecisionTypes(scope: Scope): Promise<Result<readonly DecisionTypeDefinition[]>>;
  /** An organization extension. Refused when it would redefine a system type or repeat one of its own. */
  registerDecisionType(scope: Scope, input: NewDecisionType): Promise<Result<DecisionTypeDefinition>>;

  recordPolicy(scope: Scope, input: NewPolicy): Promise<Result<AuthorityPolicy>>;
  getPolicy(scope: Scope, id: string): Promise<Result<AuthorityPolicy | null>>;
  listPolicies(scope: Scope): Promise<Result<readonly AuthorityPolicy[]>>;

  /** A rule belongs to exactly one policy version and never changes. */
  recordRule(scope: Scope, input: NewRule): Promise<Result<AuthorityRule>>;
  getRule(scope: Scope, id: string): Promise<Result<AuthorityRule | null>>;
  listRules(scope: Scope): Promise<Result<readonly AuthorityRule[]>>;

  recordOccupancy(scope: Scope, input: NewOccupancy): Promise<Result<RoleOccupancy>>;
  /** Sets validTo, once. Nothing else about an occupancy changes. */
  endOccupancy(scope: Scope, id: string, validTo: string): Promise<Result<RoleOccupancy>>;
  listOccupancies(scope: Scope): Promise<Result<readonly RoleOccupancy[]>>;

  recordDelegation(scope: Scope, input: NewDelegation): Promise<Result<Delegation>>;
  /** Sets revokedAt, once. */
  revokeDelegation(scope: Scope, id: string, revokedAt: string, reason: string): Promise<Result<Delegation>>;
  getDelegation(scope: Scope, id: string): Promise<Result<Delegation | null>>;
  listDelegations(scope: Scope): Promise<Result<readonly Delegation[]>>;

  /** Insert-only: the latest profile of a decision is its current classification. */
  recordProfile(scope: Scope, input: NewProfile): Promise<Result<DecisionGovernanceProfile>>;
  listProfiles(scope: Scope, decisionId: string): Promise<Result<readonly DecisionGovernanceProfile[]>>;

  grantVisibility(scope: Scope, input: NewVisibilityGrant): Promise<Result<DecisionVisibilityGrant>>;
  listVisibility(scope: Scope, decisionId: string): Promise<Result<readonly DecisionVisibilityGrant[]>>;

  recordEvaluation(scope: Scope, input: NewEvaluation): Promise<Result<AuthorityEvaluation>>;
  getEvaluation(scope: Scope, id: string): Promise<Result<AuthorityEvaluation | null>>;
  listEvaluations(
    scope: Scope,
    filter: { commitmentId?: string; decisionId?: string },
  ): Promise<Result<readonly AuthorityEvaluation[]>>;

  /** Must name an evaluation of the same commitment and fingerprint. */
  recordRequiredApproval(scope: Scope, input: NewRequiredApproval): Promise<Result<RequiredApproval>>;
  getRequiredApproval(scope: Scope, id: string): Promise<Result<RequiredApproval | null>>;
  listRequiredApprovals(
    scope: Scope,
    filter: { evaluationId?: string; commitmentId?: string },
  ): Promise<Result<readonly RequiredApproval[]>>;

  /** Must name a requirement of the same fingerprint; one act per requirement. */
  recordApprovalAct(scope: Scope, input: NewApprovalAct): Promise<Result<ApprovalAct>>;
  getApprovalAct(scope: Scope, id: string): Promise<Result<ApprovalAct | null>>;
  listApprovalActs(
    scope: Scope,
    filter: { requiredApprovalId?: string; commitmentId?: string; evaluationId?: string },
  ): Promise<Result<readonly ApprovalAct[]>>;
}

// --------------------------------------------------------------- runtime

export type RecordPolicyInput = {
  key: string;
  version: number;
  title: string;
  reference: string;
  source: AuthorityPolicy['source'];
  demo: boolean;
  rationale: string;
  validFrom: string;
  validTo?: string | null;
  supersedesPolicyId?: string | null;
  rules: readonly {
    key: string;
    holder: AuthorityRule['holder'];
    effect: AuthorityRule['effect'];
    decisionTypes: readonly string[];
    acts: readonly AuthorityAct[];
    scope: readonly ScopeConstraint[];
    conditions?: readonly AuthorityCondition[];
    escalationRoleId?: string | null;
    escalationRoleLabel?: string | null;
    approvalIndependence?: AuthorityRule['approvalIndependence'];
    approvalSequence?: number;
    rationale: string;
  }[];
};

export type RecordOccupancyInput = {
  roleId: string;
  userId: UserId;
  personEntityId?: string | null;
  personLabel: string;
  kind: OccupancyKind;
  validFrom: string;
  validTo?: string | null;
  basis: string;
};

export type CreateDelegationInput = {
  delegatorRoleId: string;
  delegateUserId: UserId;
  delegateLabel: string;
  decisionTypes: readonly string[];
  acts: readonly AuthorityAct[];
  scope: readonly ScopeConstraint[];
  conditions: readonly AuthorityCondition[];
  validFrom: string;
  validTo: string;
  reason: string;
};

export type ApprovalInput = {
  comments: string;
  conditions?: string;
  validUntil?: string | null;
};

export interface AuthorityRuntime {
  listDecisionTypes(scope: Scope): Promise<Result<readonly DecisionTypeDefinition[]>>;
  /** Admin only. Extends the registry for this organization; never redefines a HELM type. */
  registerDecisionType(scope: Scope, input: NewDecisionType): Promise<Result<DecisionTypeDefinition>>;

  /** A DOA version and its rules. Versions are added, never edited. */
  recordPolicy(scope: Scope, input: RecordPolicyInput): Promise<Result<{ policy: AuthorityPolicy; rules: readonly AuthorityRule[] }>>;
  recordOccupancy(scope: Scope, input: RecordOccupancyInput): Promise<Result<RoleOccupancy>>;
  endOccupancy(scope: Scope, occupancyId: string, validTo: string): Promise<Result<RoleOccupancy>>;

  /** The delegator is the authenticated actor. Refused if it would exceed their authority. */
  createDelegation(scope: Scope, input: CreateDelegationInput): Promise<Result<Delegation>>;
  revokeDelegation(scope: Scope, delegationId: string, reason: string): Promise<Result<Delegation>>;
  validateDelegation(scope: Scope, input: CreateDelegationInput): Promise<Result<DelegationValidation>>;

  /** Classifies a decision for governance. Declared subjects add to the derived scope. */
  declareGovernanceProfile(
    scope: Scope,
    decisionId: string,
    input: { decisionTypeKey: string | null; declaredSubjects?: readonly EntityRef[]; note?: string },
  ): Promise<Result<DecisionGovernanceProfile>>;
  grantVisibility(
    scope: Scope,
    decisionId: string,
    input: { orgUnitId: string; orgUnitLabel: string; reason: string },
  ): Promise<Result<DecisionVisibilityGrant>>;

  /** Evaluates the COMMIT act of one commitment, records it, and generates its required approvals. */
  evaluate(
    scope: Scope,
    commitmentId: string,
    options?: { consequenceCheck?: ConsequenceCheck },
  ): Promise<Result<{ evaluation: AuthorityEvaluation; required: readonly RequiredApproval[] }>>;
  explain(scope: Scope, evaluationId: string): Promise<Result<{ evaluation: AuthorityEvaluation; why: readonly string[] }>>;
  findAuthorities(scope: Scope, commitmentId: string, act: AuthorityAct): Promise<Result<readonly AuthorityHolding[]>>;
  resolveRequiredApprovals(scope: Scope, evaluationId: string): Promise<Result<readonly RequiredApproval[]>>;
  approvalRequest(scope: Scope, requiredApprovalId: string): Promise<Result<ApprovalRequest>>;

  /** The approver is the authenticated actor; their role is resolved, never supplied. */
  recordApproval(scope: Scope, requiredApprovalId: string, input: ApprovalInput): Promise<Result<ApprovalAct>>;
  recordRejection(scope: Scope, requiredApprovalId: string, input: ApprovalInput): Promise<Result<ApprovalAct>>;
  returnForReconsideration(scope: Scope, requiredApprovalId: string, input: ApprovalInput): Promise<Result<ApprovalAct>>;

  getGovernanceState(scope: Scope, commitmentId: string): Promise<Result<GovernanceState>>;
  explainApproval(scope: Scope, approvalActId: string): Promise<Result<ApprovalLineage>>;
  /** Compares an evaluation's consequences with another run. Reports; never re-evaluates. */
  materialChange(scope: Scope, evaluationId: string, againstRunId: string): Promise<Result<MaterialChangeReport>>;

  listPolicies(scope: Scope): Promise<Result<readonly AuthorityPolicy[]>>;
  listRules(scope: Scope): Promise<Result<readonly AuthorityRule[]>>;
  listOccupancies(scope: Scope): Promise<Result<readonly RoleOccupancy[]>>;
  listDelegations(scope: Scope): Promise<Result<readonly Delegation[]>>;
  listEvaluations(scope: Scope, filter: { commitmentId?: string; decisionId?: string }): Promise<Result<readonly AuthorityEvaluation[]>>;
  listApprovalActs(scope: Scope, filter: { commitmentId?: string }): Promise<Result<readonly ApprovalAct[]>>;
  listVisibility(scope: Scope, decisionId: string): Promise<Result<readonly DecisionVisibilityGrant[]>>;
  currentProfile(scope: Scope, decisionId: string): Promise<Result<DecisionGovernanceProfile | null>>;
}
