/**
 * Decision Authority types — who may commit what, over which scope, under
 * which consequences (ADR-0022).
 *
 * TERMINOLOGY, used consistently below and in the docs:
 *
 *   Decision type     A governance classification of a decision
 *                     (INVENTORY_ALLOCATION, PRICING…). Registry data.
 *   Authority act     What a holder may do with a decision of that type:
 *                     PREPARE, RECOMMEND, COMMIT, APPROVE, EXECUTE,
 *                     OVERRIDE_POLICY. Holding PREPARE does not confer COMMIT.
 *   Authority policy  One version of a delegation-of-authority document
 *                     (DOA-2026-04 v1). Bitemporal, immutable, superseded by a
 *                     later version rather than edited.
 *   Authority rule    One immutable line of a policy: a holder, the decision
 *                     types and acts it covers, an enterprise scope, and
 *                     conditions on computed consequences.
 *   Role occupancy    An authenticated identity holding a Role entity for a
 *                     valid-time window, substantively or as acting holder.
 *                     Authority attaches to the ROLE; people come and go.
 *   Delegation        A time-limited transfer of part of a delegator's
 *                     authority to a delegate. Never exceeds the delegator's.
 *   Commitment scope  The enterprise entities a commitment touches, each placed
 *                     in the graph by dimension. Derived, never typed.
 *   Evaluation        The immutable governance judgement of ONE commitment
 *                     fingerprint under the authority in force at the act.
 *   Required approval An approval an evaluation says is needed. Generated from
 *                     the evaluation, never entered by hand.
 *   Approval act      A person's recorded response to a required approval:
 *                     APPROVE, REJECT or RETURN_FOR_RECONSIDERATION.
 *   Governance state  A projection of the above. Never stored as truth.
 *
 * The commitment itself is never changed. Its `authorityStatus` stays
 * NOT_EVALUATED: the act of committing carries no verdict. The verdict is here.
 */

import type { OrgId, Period, QuantityUnit, UserId } from '@helm/shared';

// ------------------------------------------------------------------ errors

export const AuthorityErrors = {
  NOT_FOUND: 'authority.not_found',
  INVALID_INPUT: 'authority.invalid_input',
  CROSS_ORG: 'authority.cross_org',
  IMMUTABLE: 'authority.immutable',
  DELEGATION_EXCEEDS_AUTHORITY: 'authority.delegation_exceeds_authority',
  NOT_THE_REQUIRED_AUTHORITY: 'authority.not_the_required_authority',
  SEPARATION_OF_DUTIES: 'authority.separation_of_duties',
  FINGERPRINT_MISMATCH: 'authority.fingerprint_mismatch',
  SUPERSEDED_EVALUATION: 'authority.superseded_evaluation',
  OUT_OF_SEQUENCE: 'authority.out_of_sequence',
  ALREADY_ACTED: 'authority.already_acted',
  NOT_EVALUATED: 'authority.not_evaluated',
  WRITE_FAILED: 'authority.write_failed',
  READ_FAILED: 'authority.read_failed',
} as const;

// ----------------------------------------------------------- decision types

/**
 * A governance classification. Seeded with the minimum the canonical cases
 * need; an organization's own types are added as data, not code.
 */
export type DecisionTypeDefinition = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /**
   * null = a HELM system type, available to every organization. Otherwise the
   * organization that extended the registry with it (ADR-0025 §5): its key is
   * unique within that organization, never shadows a system key, and is
   * invisible to every other organization.
   */
  readonly orgId: string | null;
};

export const DECISION_TYPE_KEY = /^[A-Z][A-Z_]{1,62}$/;

export const SEEDED_DECISION_TYPES: readonly DecisionTypeDefinition[] = [
  {
    key: 'INVENTORY_ALLOCATION',
    name: 'Inventory allocation',
    description: 'Which demand a constrained stock position serves, and from where it is drawn.',
    orgId: null,
  },
  {
    key: 'PRICING',
    name: 'Pricing',
    description: 'A realised price, discount or price structure departing from the list.',
    orgId: null,
  },
  {
    key: 'CUSTOMER_TERMS',
    name: 'Customer terms',
    description: 'Delivery, payment or service terms agreed with a named customer.',
    orgId: null,
  },
];

// ----------------------------------------------------------------- acts

/**
 * What a holder may do. This is the first place authority differs from access
 * control: a person may prepare or recommend a decision they may not commit.
 */
export const authorityActs = ['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE', 'OVERRIDE_POLICY'] as const;
export type AuthorityAct = (typeof authorityActs)[number];

// ---------------------------------------------------------------- scope

/**
 * Dimensions of enterprise scope. The ORG CHAIN is ordered: an entity anchored
 * at REGION sits above every COUNTRY. FUNCTION, SEGMENT and CUSTOMER are side
 * axes that do not nest into the chain.
 */
export const scopeDimensions = [
  'ENTERPRISE',
  'REGION',
  'COUNTRY',
  'BUSINESS_UNIT',
  'PORTFOLIO',
  'PRODUCT',
  'FUNCTION',
  'SEGMENT',
  'CUSTOMER',
] as const;
export type ScopeDimension = (typeof scopeDimensions)[number];

export type EntityRef = { readonly entityId: string; readonly label: string };

/** One constraint of a rule's scope: in this dimension, only these entities. */
export type ScopeConstraint = {
  readonly dimension: ScopeDimension;
  readonly entities: readonly EntityRef[];
};

export const touchOrigins = ['CONSEQUENCE', 'SCENARIO_OVERRIDE', 'DECLARED_SUBJECT'] as const;
export type TouchOrigin = (typeof touchOrigins)[number];

/**
 * One enterprise entity a commitment touches, placed in the graph. The
 * coordinates are every entity it sits within, by dimension, found by walking
 * the anchoring edges; `path` says how, for the explanation.
 */
export type TouchedEntity = {
  readonly entityId: string;
  readonly label: string;
  readonly entityTypeKey: string;
  readonly origin: TouchOrigin;
  /** What made HELM look at it: a metric, an override, a declaration. */
  readonly via: string;
  readonly coordinates: Readonly<Partial<Record<ScopeDimension, readonly EntityRef[]>>>;
  readonly path: readonly string[];
};

export type CommitmentScope = {
  readonly touched: readonly TouchedEntity[];
  /** The union of every touched entity's coordinates, for reading only. */
  readonly summary: Readonly<Partial<Record<ScopeDimension, readonly EntityRef[]>>>;
  /** Touched entities the graph could not place at all. */
  readonly unresolved: readonly string[];
};

// --------------------------------------------------------------- policies

export const policySources = [
  'BOARD_POLICY',
  'DOA_DOCUMENT',
  'CORPORATE_POLICY',
  'LOCAL_MANAGEMENT_POLICY',
  'LEGAL_REQUIREMENT',
] as const;
export type PolicySource = (typeof policySources)[number];

/**
 * One version of a delegation-of-authority document. It REFERENCES the
 * document (`reference`), it does not copy it. Valid time says when the
 * version is in force; record time says when HELM learned it. A later version
 * of the same key supersedes it from its own validFrom; nothing is edited.
 */
export type AuthorityPolicy = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly key: string;
  readonly version: number;
  readonly title: string;
  /** External reference: "DOA-2026-04", "Pricing Policy 2026". */
  readonly reference: string;
  readonly source: PolicySource;
  /** True for seeded demonstration policy. Shown as DEMO GOVERNANCE POLICY. */
  readonly demo: boolean;
  /** Why this authority exists. */
  readonly rationale: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly recordedBy: UserId | null;
  readonly supersedesPolicyId: string | null;
};

// ------------------------------------------------------------------ rules

/**
 *   GRANT             the holder may perform the acts, within the scope, while
 *                     the conditions hold.
 *   RESTRICT          an explicit exception: where it matches, the holder's
 *                     GRANT does not decide, and the excess goes to the named
 *                     escalation role. An exception always wins.
 *   REQUIRE_APPROVAL  a matrix requirement: where it matches, the holder's
 *                     approval is needed whoever committed.
 */
export const ruleEffects = ['GRANT', 'RESTRICT', 'REQUIRE_APPROVAL'] as const;
export type RuleEffect = (typeof ruleEffects)[number];

/** Authority attaches to a role. A person holder is a flagged exception. */
export type AuthorityHolder =
  | { readonly kind: 'ROLE'; readonly roleId: string; readonly label: string }
  | { readonly kind: 'PERSON'; readonly userId: string; readonly label: string };

export const comparators = ['GTE', 'GT', 'LTE', 'LT'] as const;
export type Comparator = (typeof comparators)[number];

/**
 * A line on a COMPUTED consequence: "CashImpact ≥ −1 000 000 000 VND". The
 * value is read from the chosen scenario run's future state. There is no
 * field here for a number anyone typed.
 */
export type AuthorityCondition = {
  readonly metricKey: string;
  readonly label: string;
  readonly comparator: Comparator;
  /** Exact canonical decimal. */
  readonly threshold: string;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
};

export const approvalIndependences = ['INDEPENDENT_OF_COMMITTER', 'NONE'] as const;
export type ApprovalIndependence = (typeof approvalIndependences)[number];

export type AuthorityRule = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly policyId: string;
  readonly key: string;
  readonly holder: AuthorityHolder;
  readonly effect: RuleEffect;
  readonly decisionTypes: readonly string[];
  readonly acts: readonly AuthorityAct[];
  readonly scope: readonly ScopeConstraint[];
  readonly conditions: readonly AuthorityCondition[];
  /** Where the excess goes when this rule is exceeded or restricted. */
  readonly escalationRoleId: string | null;
  readonly escalationRoleLabel: string | null;
  /** Whether the approval this rule causes must come from someone else. */
  readonly approvalIndependence: ApprovalIndependence;
  /** Order among required approvals; equal numbers are parallel. */
  readonly approvalSequence: number;
  readonly rationale: string;
  readonly recordedAt: string;
};

// -------------------------------------------------------- role occupancy

export const occupancyKinds = ['SUBSTANTIVE', 'ACTING'] as const;
export type OccupancyKind = (typeof occupancyKinds)[number];

/**
 * An authenticated identity holding a Role for a valid-time window. This is
 * what makes "Country GM" a seat rather than a person: the rule names the
 * role, and whoever occupies it at the act holds it. Acting is an occupancy,
 * not a delegation.
 */
export type RoleOccupancy = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly userId: UserId;
  /** The enterprise Person entity, when the graph has one. */
  readonly personEntityId: string | null;
  readonly personLabel: string;
  readonly kind: OccupancyKind;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly basis: string;
  readonly recordedAt: string;
  readonly recordedBy: UserId | null;
  /**
   * RECORD time of the ending — when HELM learned that `validTo` was set.
   * Ending an occupancy writes `validTo` onto the row, so without this a reader
   * reconstructing an earlier knowledge boundary (the digital twin) could not
   * tell a role holder who had left from one HELM only later learned had left.
   */
  readonly endedAt: string | null;
};

// ------------------------------------------------------------ delegation

export type Delegation = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly delegatorUserId: UserId;
  readonly delegatorLabel: string;
  /** The role whose authority is delegated; the delegator must occupy it. */
  readonly delegatorRoleId: string;
  readonly delegatorRoleLabel: string;
  readonly delegateUserId: UserId;
  readonly delegateLabel: string;
  readonly decisionTypes: readonly string[];
  readonly acts: readonly AuthorityAct[];
  readonly scope: readonly ScopeConstraint[];
  readonly conditions: readonly AuthorityCondition[];
  readonly validFrom: string;
  /** Required: a delegation without an end is a role change, not a delegation. */
  readonly validTo: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
};

// ------------------------------------------------ decision governance data

/**
 * How a decision is classified for governance. Insert-only: a later profile
 * supersedes an earlier one, and each evaluation records which it used.
 * Declared subjects ADD to the scope HELM derives; they never remove from it.
 */
export type DecisionGovernanceProfile = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly decisionTypeKey: string | null;
  readonly declaredSubjects: readonly EntityRef[];
  readonly note: string;
  readonly declaredBy: UserId | null;
  readonly declaredAt: string;
};

/**
 * DATA VISIBILITY, not authority. A decision is visible to members of the
 * granted unit and of every unit above it, to its creator and to org admins.
 * A cross-functional decision gets one grant per unit; it is never copied.
 */
export type DecisionVisibilityGrant = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly orgUnitId: string;
  readonly orgUnitLabel: string;
  readonly reason: string;
  readonly grantedBy: UserId | null;
  readonly grantedAt: string;
};

// ------------------------------------------------------------ evaluation

/** A computed consequence the evaluation read, with where it came from. */
export type ConsequenceValue = {
  readonly metricKey: string;
  readonly label: string;
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly runId: string | null;
  readonly period: Period | null;
  /** Exact decimal, or null when the model cannot compute it. */
  readonly value: string | null;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  /** COMPUTED, OVERRIDDEN, BLOCKED… as the future state said. */
  readonly origin: string | null;
  readonly source: 'EXPECTED_OUTCOME' | 'FUTURE_STATE' | 'NOT_AVAILABLE';
  readonly reason: string | null;
};

export const scopeCheckOutcomes = ['WITHIN', 'OUTSIDE', 'UNKNOWN'] as const;
export type ScopeCheckOutcome = (typeof scopeCheckOutcomes)[number];

export type ScopeCheck = {
  readonly dimension: ScopeDimension;
  readonly allowed: readonly EntityRef[];
  /** COVERS_ALL for a grant; TOUCHES for an exception or a requirement. */
  readonly mode: 'COVERS_ALL' | 'TOUCHES';
  readonly outcome: ScopeCheckOutcome;
  readonly statement: string;
};

export const conditionOutcomes = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type ConditionOutcome = (typeof conditionOutcomes)[number];

export type ConditionCheck = {
  readonly metricKey: string;
  readonly label: string;
  readonly comparator: Comparator;
  readonly threshold: string;
  readonly unit: QuantityUnit | null;
  readonly currency: string | null;
  readonly value: string | null;
  readonly nodeId: string | null;
  readonly outcome: ConditionOutcome;
  readonly statement: string;
};

export const ruleAssessmentOutcomes = ['MATCHED', 'REJECTED'] as const;
export type RuleAssessmentOutcome = (typeof ruleAssessmentOutcomes)[number];

/** Every rule in force is assessed and reported, matched or not, with why. */
export type RuleAssessment = {
  readonly ruleId: string;
  readonly ruleKey: string;
  readonly policyId: string;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly policyReference: string;
  readonly demoPolicy: boolean;
  readonly holder: AuthorityHolder;
  readonly effect: RuleEffect;
  /** How the rule reached this evaluation. */
  readonly relation: 'ACTOR' | 'DELEGATED' | 'ESCALATION' | 'REQUIREMENT' | 'OTHER_HOLDER';
  readonly outcome: RuleAssessmentOutcome;
  readonly reasons: readonly string[];
  readonly scopeChecks: readonly ScopeCheck[];
  readonly conditionChecks: readonly ConditionCheck[];
  /** Readable specificity, for the precedence explanation. */
  readonly specificity: string;
  /** True for the rule that decided the actor's own authority. */
  readonly deciding: boolean;
};

export const delegationCheckOutcomes = [
  'APPLIED',
  'NOT_RECORDED_AT_ACT',
  'NOT_VALID_AT_ACT',
  'REVOKED',
  'TYPE_OR_ACT_NOT_DELEGATED',
  'DELEGATOR_NOT_IN_ROLE',
  'OUTSIDE_SCOPE',
  'EXCEEDED',
  'RESTRICTED',
  'UNKNOWN',
] as const;
export type DelegationCheckOutcome = (typeof delegationCheckOutcomes)[number];

export type DelegationCheck = {
  readonly delegationId: string;
  readonly delegatorLabel: string;
  readonly delegatorRoleLabel: string;
  readonly delegateLabel: string;
  readonly outcome: DelegationCheckOutcome;
  readonly basisRuleId: string | null;
  readonly conditionChecks: readonly ConditionCheck[];
  readonly statement: string;
};

export const requirementKinds = ['ESCALATION', 'RESTRICTION', 'MATRIX'] as const;
export type RequirementKind = (typeof requirementKinds)[number];

export type RequiredAuthority = {
  readonly roleId: string;
  readonly roleLabel: string;
  readonly basisRuleId: string;
  readonly basisRuleKey: string;
  readonly kind: RequirementKind;
  readonly reason: string;
  readonly sequence: number;
  /** When set, this person cannot satisfy the requirement. */
  readonly independentOfUserId: UserId | null;
  /** Who occupies the role at the act — for reading; approval is re-checked when it happens. */
  readonly currentOccupants: readonly { readonly userId: UserId; readonly label: string }[];
};

export type EscalationStep = {
  readonly roleId: string;
  readonly roleLabel: string;
  readonly ruleKey: string | null;
  readonly outcome: 'COVERS' | 'EXCEEDED' | 'RESTRICTED' | 'NO_RULE' | 'UNKNOWN' | 'CYCLE';
  readonly statement: string;
};

export const authorityResults = [
  'AUTHORIZED',
  'REQUIRES_APPROVAL',
  'ESCALATED',
  'NOT_AUTHORIZED',
  'INDETERMINATE',
] as const;
export type AuthorityResult = (typeof authorityResults)[number];

export const governabilities = ['GOVERNABLE', 'GOVERNABLE_WITH_GAPS', 'NOT_GOVERNABLE'] as const;
export type Governability = (typeof governabilities)[number];

export const gapCodes = [
  'DECISION_TYPE_UNMAPPED',
  'ACTOR_UNKNOWN',
  'ACTOR_ROLE_MISSING',
  'NO_POLICY_IN_FORCE',
  'NO_RULE_FOR_DECISION_TYPE',
  'SCOPE_UNRESOLVED',
  'METRIC_UNAVAILABLE',
  'RULE_CONFLICT',
  'ESCALATION_PATH_MISSING',
  'NO_CURRENT_OCCUPANT',
] as const;
export type GapCode = (typeof gapCodes)[number];

export type GovernanceGap = {
  readonly code: GapCode;
  /** True when the gap alone makes the result INDETERMINATE. */
  readonly blocking: boolean;
  readonly message: string;
};

export type ActorRole = {
  readonly roleId: string;
  readonly roleLabel: string;
  readonly occupancyId: string;
  readonly kind: OccupancyKind;
};

/**
 * The immutable governance judgement of one commitment fingerprint. Recorded
 * once; a later evaluation of the same commitment supersedes it for the
 * projection but never rewrites it.
 */
export type AuthorityEvaluation = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly commitmentFingerprint: string;
  readonly act: AuthorityAct;
  /** The identity that committed — resolved from the commitment, never supplied. */
  readonly actorUserId: UserId | null;
  readonly actorLabel: string;
  readonly actorRoles: readonly ActorRole[];
  /** When the governed act happened: authority is judged as of this instant. */
  readonly actAt: string;
  readonly evaluatedAt: string;
  readonly evaluatedBy: UserId | null;
  readonly decisionTypeKey: string | null;
  readonly profileId: string | null;
  readonly policies: readonly {
    readonly policyId: string;
    readonly key: string;
    readonly version: number;
    readonly reference: string;
    readonly demo: boolean;
  }[];
  readonly scope: CommitmentScope;
  readonly consequences: readonly ConsequenceValue[];
  readonly rules: readonly RuleAssessment[];
  readonly delegations: readonly DelegationCheck[];
  readonly basisRuleId: string | null;
  readonly basisDelegationId: string | null;
  readonly result: AuthorityResult;
  readonly requiredAuthorities: readonly RequiredAuthority[];
  readonly escalationChain: readonly EscalationStep[];
  /** For NOT_AUTHORIZED: who does hold the authority. Information, not routing. */
  readonly authoritiesInScope: readonly { readonly roleId: string; readonly roleLabel: string; readonly ruleKey: string }[];
  readonly gaps: readonly GovernanceGap[];
  readonly governability: Governability;
  readonly explanation: readonly string[];
  readonly fingerprint: string;
  readonly supersedesEvaluationId: string | null;
  /** Which code path produced the verdict, and whether it checked the consequences it read. */
  readonly evaluator: EvaluatorIdentity;
};

/**
 *   TRUSTED_SERVICE  the server-side authority runtime (ADR-0024): identity from a
 *                    verified token, every fact loaded from HELM's own records,
 *                    the chosen run's trace re-derived before it is believed
 *   CLIENT_RUNTIME   the same kernel running in a client — demo mode, tests, or a
 *                    tool. Its verdict is a computation, not a trusted record: the
 *                    database accepts evaluations only from the trusted service.
 */
export const evaluatorKinds = ['TRUSTED_SERVICE', 'CLIENT_RUNTIME'] as const;
export type EvaluatorKind = (typeof evaluatorKinds)[number];

export type ConsequenceCheck = {
  readonly status: 'TRACE_VERIFIED' | 'NOT_CHECKED';
  readonly runIds: readonly string[];
  readonly checkedSteps: number;
  readonly checkedInputs: number;
};

export type EvaluatorIdentity = {
  readonly kind: EvaluatorKind;
  /** Where it ran: 'edge:helm-authority', 'in-process', … */
  readonly host: string;
  readonly consequenceCheck: ConsequenceCheck;
};

export const NOT_CHECKED: ConsequenceCheck = { status: 'NOT_CHECKED', runIds: [], checkedSteps: 0, checkedInputs: 0 };

// ---------------------------------------------------------------- approval

export type RequiredApproval = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly commitmentFingerprint: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly basisRuleId: string;
  readonly kind: RequirementKind;
  readonly reason: string;
  readonly sequence: number;
  readonly independentOfUserId: UserId | null;
  readonly createdAt: string;
};

export const approvalDecisions = ['APPROVE', 'REJECT', 'RETURN_FOR_RECONSIDERATION'] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export type ApprovalBasis = {
  readonly kind: 'ROLE_OCCUPANCY' | 'DELEGATION';
  readonly occupancyId: string | null;
  readonly delegationId: string | null;
  /** The rule whose authority the approver exercised, as in force at the act. */
  readonly ruleId: string | null;
};

/** A person's response to a required approval. Write-once. */
export type ApprovalAct = {
  readonly id: string;
  readonly orgId: OrgId;
  readonly requiredApprovalId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly commitmentId: string;
  readonly commitmentFingerprint: string;
  readonly approverUserId: UserId;
  readonly approverLabel: string;
  readonly approverRoleId: string;
  readonly approverRoleLabel: string;
  readonly basis: ApprovalBasis;
  readonly decision: ApprovalDecision;
  readonly comments: string;
  readonly conditions: string;
  /** After this, the approval no longer satisfies its requirement. */
  readonly validUntil: string | null;
  readonly actedAt: string;
};

// ------------------------------------------------------- governance state

export const governanceStates = [
  'NOT_EVALUATED',
  'AUTHORIZED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'ESCALATED',
  'NOT_AUTHORIZED',
  'INDETERMINATE',
] as const;
export type GovernanceStateKey = (typeof governanceStates)[number];

/** Workflow progress — kept apart from the policy result on purpose. */
export const approvalProgresses = ['NONE_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'RETURNED'] as const;
export type ApprovalProgress = (typeof approvalProgresses)[number];

export type RequirementStatus = {
  readonly requirement: RequiredApproval;
  readonly acts: readonly ApprovalAct[];
  readonly satisfied: boolean;
  readonly note: string | null;
};

export type GovernanceState = {
  readonly commitmentId: string;
  readonly commitmentFingerprint: string;
  readonly state: GovernanceStateKey;
  /** What the policy said. Null before any evaluation. */
  readonly policyResult: AuthorityResult | null;
  /** How far the approvals have got. */
  readonly approvalProgress: ApprovalProgress;
  readonly evaluation: AuthorityEvaluation | null;
  readonly requirements: readonly RequirementStatus[];
  /** Evaluations of this commitment that a later one superseded. */
  readonly supersededEvaluationIds: readonly string[];
  readonly statement: string;
};

// ----------------------------------------------------------- read models

/**
 * What an approver receives: the decision, not a blank form. Every field is
 * read from records that already exist.
 */
export type ApprovalRequest = {
  readonly requirement: RequiredApproval;
  readonly evaluation: AuthorityEvaluation;
  readonly managementQuestion: string;
  readonly chosenAlternative: { readonly id: string; readonly label: string; readonly scenarioKey: string | null };
  readonly committedByLabel: string;
  readonly committedAt: string;
  readonly keyConsequences: readonly ConsequenceValue[];
  readonly acceptedTradeOffs: readonly { readonly label: string; readonly statement: string }[];
  readonly uncertainty: readonly string[];
  readonly authorityReason: readonly string[];
};

/** Approval act → requirement → evaluation → rule → role & scope → commitment → run → value → trace → source. */
export type ApprovalLineage = {
  readonly act: ApprovalAct;
  readonly requirement: RequiredApproval;
  readonly evaluation: AuthorityEvaluation;
  readonly basisRule: AuthorityRule;
  readonly basisPolicy: AuthorityPolicy;
  readonly requirementRule: AuthorityRule;
  readonly approverOccupancy: RoleOccupancy | null;
  readonly commitment: { readonly id: string; readonly fingerprint: string; readonly chosenAlternativeId: string; readonly committedByLabel: string };
  readonly chosenRunId: string | null;
  readonly consequences: readonly ConsequenceValue[];
  /** Scenario explanations of each consequence, into calculation traces and source observations. */
  readonly valueLineage: readonly unknown[];
  readonly statement: string;
};

export type MaterialChange = {
  readonly metricKey: string;
  readonly label: string;
  readonly evaluatedValue: string | null;
  readonly currentValue: string | null;
  readonly delta: string | null;
  /** Whether the change alters the outcome of a condition the evaluation relied on. */
  readonly changesACondition: boolean;
};

export type MaterialChangeReport = {
  readonly evaluationId: string;
  readonly againstRunId: string;
  readonly changes: readonly MaterialChange[];
  readonly reevaluationRequired: boolean;
  readonly statement: string;
};

/** Who holds an act for a decision type over a scope, and on what rule. */
export type AuthorityHolding = {
  readonly roleId: string;
  readonly roleLabel: string;
  readonly ruleId: string;
  readonly ruleKey: string;
  readonly policyReference: string;
  readonly acts: readonly AuthorityAct[];
  readonly covers: boolean;
  readonly conditionChecks: readonly ConditionCheck[];
  readonly occupants: readonly { readonly userId: UserId; readonly label: string; readonly kind: OccupancyKind }[];
};
