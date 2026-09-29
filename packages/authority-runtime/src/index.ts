/**
 * @helm/authority-runtime — the Decision Authority Graph.
 *
 * Who may commit which management decision, over which enterprise scope,
 * under which computed consequences, during which validity period — and, when
 * a commitment goes beyond that, whose authority it needs. It judges
 * commitments; it never changes them, and it never approves anything itself.
 */

export * from './types.ts';
export * from './port.ts';
export { createAuthorityRuntime, AUTHORITY_STATEMENT } from './runtime.ts';
export type { AuthorityRuntimeOptions } from './runtime.ts';
export { createInMemoryAuthorityStore, checkRule } from './inMemoryStore.ts';
export type { InMemoryAuthorityStoreOptions } from './inMemoryStore.ts';
export {
  evaluateAuthority,
  findAuthorities,
  assessRoleAuthority,
  assessDelegatedAuthority,
  whyApprovalIsRequired,
} from './engine.ts';
export type { EvaluationInput, EvaluationDraft, RoleAuthorityAssessment } from './engine.ts';
export { evaluationFingerprint } from './fingerprint.ts';
export { validateDelegation } from './delegation.ts';
export type { DelegationDraft, DelegationValidation } from './delegation.ts';
export { checkCondition, checkConditions, conditionsOutcome, conditionWithin, describeCondition, readableAmount, readableNumber } from './conditions.ts';
export {
  resolveCommitmentScope,
  checkCoverage,
  checkTouches,
  scopeOf,
  specificityOf,
  compareSpecificity,
  SCOPE_ANCHORS,
  DIMENSION_OF_ENTITY_TYPE,
  ORG_CHAIN,
  SIDE_AXES,
} from './scope.ts';
export type { TouchRequest } from './scope.ts';
export { policiesInForce, rulesInForce, occupanciesAt, occupantsOf } from './policy.ts';
export { projectGovernanceState, latestEvaluation } from './state.ts';
export { canSeeDecision, visibleUnits } from './visibility.ts';
export type { OrgUnit, VisibilityViewer, VisibilityVerdict } from './visibility.ts';
export {
  DEMO_GOVERNANCE_LABEL,
  MERIDIAN_DEMO_USERS,
  MERIDIAN_DEMO_PEOPLE,
  MERIDIAN_DEMO_UNITS,
  Q1_2027_CALL_OFF,
  buildMeridianGovernanceGraph,
  recordMeridianDoaV1,
  recordMeridianDoaV2,
  recordMeridianOccupancies,
  buildCallOffScenario,
  buildProofDecision,
  scopeAs,
} from './meridianGovernance.ts';
export type { MeridianGovernanceGraph } from './meridianGovernance.ts';
export { createTrustedAuthorityService, verifyScenarioRun, TrustedErrors, TRUSTED_HOST_EDGE } from './trusted.ts';
export type { TrustedAuthorityDeps, TrustedAuthorityService, TrustedResponse, VerifiedIdentity, Membership } from './trusted.ts';
