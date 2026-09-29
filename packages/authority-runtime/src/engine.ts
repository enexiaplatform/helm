/**
 * The Authority Engine (ADR-0022 §6) — pure and deterministic.
 *
 * Given who acted, when, on a commitment of what type, over what enterprise
 * scope, with what computed consequences, and the authority in force at that
 * instant, it says whether the act was within the actor's authority and — if
 * not — whose authority it needs, with every step written out.
 *
 * No I/O, no clock, no AI, no ranking. The same input always produces the same
 * evaluation, and the evaluation says what it considered, what it matched,
 * what it rejected and why. It never infers permission: anything it cannot
 * establish is INDETERMINATE, with the missing fact named.
 */

import type { UserId } from '@helm/shared';
import { checkConditions, conditionsOutcome, describeCondition, readableAmount } from './conditions.ts';
import { policiesInForce, occupanciesAt, occupantsOf, openAt, rulesInForce, delegationsTo } from './policy.ts';
import {
  checkCoverage,
  checkTouches,
  compareSpecificity,
  describeSpecificity,
  scopeOutcome,
  specificityOf,
} from './scope.ts';
import type {
  ActorRole,
  AuthorityAct,
  AuthorityEvaluation,
  AuthorityHolding,
  AuthorityPolicy,
  AuthorityResult,
  AuthorityRule,
  CommitmentScope,
  ConditionCheck,
  ConditionOutcome,
  ConsequenceValue,
  Delegation,
  DelegationCheck,
  EscalationStep,
  GovernanceGap,
  Governability,
  RequiredAuthority,
  RoleOccupancy,
  RuleAssessment,
  ScopeCheck,
} from './types.ts';

export type EvaluationInput = {
  readonly act: AuthorityAct;
  /** When the governed act happened. Authority is judged as of this instant. */
  readonly actAt: string;
  readonly actor: { readonly userId: UserId | null; readonly label: string };
  /** Who committed — the person an independent approval must not be. */
  readonly committerUserId: UserId | null;
  readonly decisionTypeKey: string | null;
  readonly knownDecisionTypes: readonly string[];
  readonly scope: CommitmentScope;
  readonly consequences: readonly ConsequenceValue[];
  readonly policies: readonly AuthorityPolicy[];
  readonly rules: readonly AuthorityRule[];
  readonly occupancies: readonly RoleOccupancy[];
  readonly delegations: readonly Delegation[];
};

export type EvaluationDraft = Omit<
  AuthorityEvaluation,
  | 'id'
  | 'orgId'
  | 'decisionId'
  | 'commitmentId'
  | 'commitmentFingerprint'
  | 'evaluatedAt'
  | 'evaluatedBy'
  | 'profileId'
  | 'fingerprint'
  | 'supersedesEvaluationId'
>;

const MAX_ESCALATION_STEPS = 6;

const typeName = (key: string | null): string => (key === null ? 'unclassified' : key.replaceAll('_', ' ').toLowerCase());
const dateOf = (iso: string): string => iso.slice(0, 10);

type Candidate = {
  rule: AuthorityRule;
  scopeChecks: ScopeCheck[];
  conditionChecks: ConditionCheck[];
  scope: 'WITHIN' | 'OUTSIDE' | 'UNKNOWN';
  conditions: ConditionOutcome;
};

type Own =
  | { kind: 'NONE' }
  | { kind: 'CONFLICT'; rules: AuthorityRule[] }
  | { kind: 'SCOPE_UNKNOWN'; rules: AuthorityRule[] }
  | { kind: 'DECIDED'; deciding: Candidate; restriction: Candidate | null };

export function evaluateAuthority(input: EvaluationInput): EvaluationDraft {
  const { act, actAt, actor, decisionTypeKey, scope, consequences } = input;
  const gaps: GovernanceGap[] = [];
  const gap = (code: GovernanceGap['code'], message: string, blocking = true) => {
    if (!gaps.some((g) => g.code === code && g.message === message)) gaps.push({ code, blocking, message });
  };

  // ---------------------------------------------------- authority in force
  const policies = policiesInForce(input.policies, actAt, actAt);
  const rules = rulesInForce(input.rules, policies, actAt);
  const policyOf = new Map(policies.map((p) => [p.id, p]));

  // --------------------------------------------------------------- the actor
  const actorOccupancies = actor.userId ? occupanciesAt(input.occupancies, actor.userId, actAt) : [];
  const actorRoles: ActorRole[] = actorOccupancies.map((o) => ({
    roleId: o.roleId,
    roleLabel: o.roleLabel,
    occupancyId: o.id,
    kind: o.kind,
  }));
  const actorRoleIds = new Set(actorRoles.map((r) => r.roleId));
  const heldByActor = (rule: AuthorityRule): boolean =>
    rule.holder.kind === 'ROLE' ? actorRoleIds.has(rule.holder.roleId) : actor.userId !== null && rule.holder.userId === actor.userId;

  // ------------------------------------------------------------ gaps first
  if (decisionTypeKey === null) {
    gap('DECISION_TYPE_UNMAPPED', 'The decision has no decision type, so no authority rule can be matched to it.');
  } else if (!input.knownDecisionTypes.includes(decisionTypeKey)) {
    gap('DECISION_TYPE_UNMAPPED', `"${decisionTypeKey}" is not a registered decision type.`);
  }
  if (actor.userId === null) {
    gap('ACTOR_UNKNOWN', 'The commitment records no authenticated identity, so HELM cannot say whose authority was exercised.');
  }
  if (policies.length === 0) {
    gap('NO_POLICY_IN_FORCE', `No authority policy was in force on ${dateOf(actAt)}.`);
  } else if (decisionTypeKey !== null && !rules.some((r) => r.decisionTypes.includes(decisionTypeKey))) {
    gap(
      'NO_RULE_FOR_DECISION_TYPE',
      `The policy in force (${policies.map((p) => `${p.reference} v${p.version}`).join(', ')}) says nothing about ${typeName(decisionTypeKey)} decisions.`,
    );
  }
  if (scope.touched.length === 0) {
    gap('SCOPE_UNRESOLVED', 'HELM found no enterprise entity this commitment touches, so its scope is unknown.');
  }
  for (const u of scope.unresolved) gap('SCOPE_UNRESOLVED', `Scope unresolved: ${u}.`);
  const actorDelegations = actor.userId ? delegationsTo(input.delegations, actor.userId) : [];
  if (actor.userId !== null && actorRoles.length === 0 && actorDelegations.length === 0) {
    gap('ACTOR_ROLE_MISSING', `${actor.label} occupied no role on ${dateOf(actAt)} that HELM knows of, and held no delegation.`);
  }

  // --------------------------------------------------------- every rule, assessed
  const candidateOf = (rule: AuthorityRule): Candidate => {
    const scopeChecks = rule.effect === 'GRANT' ? checkCoverage(rule.scope, scope) : checkTouches(rule.scope, scope);
    const conditionChecks = checkConditions(rule.conditions, consequences);
    return { rule, scopeChecks, conditionChecks, scope: scopeOutcome(scopeChecks), conditions: conditionsOutcome(conditionChecks) };
  };
  const candidates = new Map(rules.map((r) => [r.id, candidateOf(r)]));
  const typeAndAct = (rule: AuthorityRule, a: AuthorityAct) =>
    decisionTypeKey !== null && rule.decisionTypes.includes(decisionTypeKey) && rule.acts.includes(a);

  // --------------------------------------------------- the actor's own authority
  // Specificity orders the rules of ONE holder. A person who occupies two seats
  // may exercise either: each seat is decided on its own rules, and the actor
  // is within authority if any seat is.
  const restrictionFor = (holderRoleIds: ReadonlySet<string>, a: AuthorityAct): Candidate | null => {
    const hits = rules
      .filter(
        (r) =>
          r.effect === 'RESTRICT' &&
          typeAndAct(r, a) &&
          r.holder.kind === 'ROLE' &&
          holderRoleIds.has(r.holder.roleId) &&
          candidates.get(r.id)!.scope === 'WITHIN',
      )
      .map((r) => candidates.get(r.id)!)
      .filter((c) => c.conditions !== 'FAIL');
    return hits.sort((x, y) => compareSpecificity(specificityOf(y.rule), specificityOf(x.rule)) || x.rule.key.localeCompare(y.rule.key))[0] ?? null;
  };
  const holderKey = (r: AuthorityRule) => (r.holder.kind === 'ROLE' ? `role:${r.holder.roleId}` : `person:${r.holder.userId}`);
  const actorGrants = rules.filter((r) => r.effect === 'GRANT' && heldByActor(r) && typeAndAct(r, act));
  const seats: Own[] = [...new Set(actorGrants.map(holderKey))].sort().map((k) => {
    const decided = decideOwn(actorGrants.filter((r) => holderKey(r) === k), candidates);
    if (decided.kind === 'DECIDED' && decided.deciding.conditions === 'PASS') {
      const holder = decided.deciding.rule.holder;
      const restriction = holder.kind === 'ROLE' ? restrictionFor(new Set([holder.roleId]), act) : null;
      return restriction ? { ...decided, restriction } : decided;
    }
    return decided;
  });
  type Seat = Extract<Own, { kind: 'DECIDED' }>;
  const decidedSeats = seats.filter((x): x is Seat => x.kind === 'DECIDED');
  const bySpecificity = (a: Seat, b: Seat) =>
    compareSpecificity(specificityOf(b.deciding.rule), specificityOf(a.deciding.rule)) || a.deciding.rule.key.localeCompare(b.deciding.rule.key);
  const passing = decidedSeats.filter((x) => x.deciding.conditions === 'PASS' && !x.restriction).sort(bySpecificity);
  const exceeded = decidedSeats.filter((x) => x.deciding.conditions === 'FAIL' || x.restriction).sort(bySpecificity);
  const unknownSeats = decidedSeats.filter((x) => x.deciding.conditions === 'UNKNOWN' && !x.restriction).sort(bySpecificity);
  const conflicts = seats.filter((x): x is Extract<Own, { kind: 'CONFLICT' }> => x.kind === 'CONFLICT');
  const scopeUnknown = seats.filter((x): x is Extract<Own, { kind: 'SCOPE_UNKNOWN' }> => x.kind === 'SCOPE_UNKNOWN');
  let chosenSeat: Own = passing[0] ?? unknownSeats[0] ?? exceeded[0] ?? conflicts[0] ?? scopeUnknown[0] ?? { kind: 'NONE' };

  // ------------------------------------------------------------- delegations
  const delegationChecks: DelegationCheck[] = actorDelegations.map((d) =>
    checkDelegation(d, input, rules, candidates, act, restrictionFor),
  );
  const applied = delegationChecks.find((c) => c.outcome === 'APPLIED') ?? null;

  // ------------------------------------------------ matrix requirements
  const matrixCandidates = rules
    .filter((r) => r.effect === 'REQUIRE_APPROVAL' && typeAndAct(r, act))
    .map((r) => candidates.get(r.id)!)
    .filter((c) => c.scope === 'WITHIN');
  const matrixUnknown = matrixCandidates.filter((c) => c.conditions === 'UNKNOWN');
  const matrixApplying = matrixCandidates.filter((c) => c.conditions === 'PASS');

  // ------------------------------------------------------------ the verdict
  const escalationChain: EscalationStep[] = [];
  const required: RequiredAuthority[] = [];
  const touchedRoles = new Set<string>();
  let result: AuthorityResult;
  let basisRuleId: string | null = null;
  let basisDelegationId: string | null = null;

  const blocking = () => gaps.some((g) => g.blocking);
  const independent = (rule: AuthorityRule): UserId | null =>
    rule.approvalIndependence === 'INDEPENDENT_OF_COMMITTER' ? input.committerUserId : null;
  const occupantsFor = (roleId: string) =>
    occupantsOf(input.occupancies, roleId, actAt).map((o) => ({ userId: o.userId, label: o.personLabel }));
  const addMatrix = () => {
    for (const m of matrixApplying) {
      if (m.rule.holder.kind !== 'ROLE') continue;
      const roleId = m.rule.holder.roleId;
      if (required.some((r) => r.roleId === roleId)) continue;
      required.push({
        roleId,
        roleLabel: m.rule.holder.label,
        basisRuleId: m.rule.id,
        basisRuleKey: m.rule.key,
        kind: 'MATRIX',
        reason: `Policy requires ${m.rule.holder.label} as well: ${m.conditionChecks.map((c) => c.statement).join(' ')}`,
        sequence: m.rule.approvalSequence,
        independentOfUserId: independent(m.rule),
        currentOccupants: occupantsFor(roleId),
      });
    }
  };

  if (blocking()) {
    result = 'INDETERMINATE';
  } else if (passing.length > 0 || applied) {
    // Within authority: through one of the actor's own seats, or a delegation.
    if (passing.length > 0) {
      basisRuleId = passing[0].deciding.rule.id;
    } else if (applied) {
      basisRuleId = applied.basisRuleId;
      basisDelegationId = applied.delegationId;
    }
    for (const m of matrixUnknown) {
      gap('METRIC_UNAVAILABLE', `Whether ${m.rule.holder.label}'s approval is required cannot be established: ${m.conditionChecks.filter((c) => c.outcome === 'UNKNOWN').map((c) => c.statement).join(' ')}`);
    }
    if (blocking()) {
      result = 'INDETERMINATE';
    } else {
      addMatrix();
      result = required.length > 0 ? 'REQUIRES_APPROVAL' : 'AUTHORIZED';
    }
  } else if (unknownSeats.length > 0 || delegationChecks.some((d) => d.outcome === 'UNKNOWN')) {
    // A seat that might authorize cannot be established: saying "approval is
    // required" would be as much a guess as saying "authorized".
    for (const seat of unknownSeats) {
      for (const c of seat.deciding.conditionChecks.filter((x) => x.outcome === 'UNKNOWN')) gap('METRIC_UNAVAILABLE', c.statement);
    }
    for (const d of delegationChecks.filter((x) => x.outcome === 'UNKNOWN')) gap('METRIC_UNAVAILABLE', d.statement);
    result = 'INDETERMINATE';
  } else if (conflicts.length > 0) {
    for (const c of conflicts) {
      gap('RULE_CONFLICT', `Rules of equal specificity disagree: ${c.rules.map((r) => `"${r.key}"`).join(' and ')}. HELM will not pick one by order.`);
    }
    result = 'INDETERMINATE';
  } else if (scopeUnknown.length > 0) {
    for (const u of scopeUnknown) {
      gap('SCOPE_UNRESOLVED', `Whether ${u.rules.map((r) => `"${r.key}"`).join(', ')} reaches this commitment cannot be established from the graph.`);
    }
    result = 'INDETERMINATE';
  } else if (exceeded.length > 0) {
    // The actor holds authority over this type and scope, and every seat is
    // exceeded or restricted. Follow each seat's escalation; the nearest
    // authority that covers it is the one required.
    const attempts = exceeded.map((seat) => {
      const chain: EscalationStep[] = [];
      const touched = new Set<string>();
      const from = seat.restriction ?? seat.deciding;
      const resolution = resolveEscalation(from.rule.escalationRoleId, from.rule.escalationRoleLabel, input, rules, candidates, restrictionFor, chain, touched);
      return { seat, from, chain, touched, resolution };
    });
    const covered = attempts
      .filter((x) => x.resolution.kind === 'COVERED')
      .sort((x, y) => (x.resolution as { steps: number }).steps - (y.resolution as { steps: number }).steps || bySpecificity(x.seat, y.seat));
    const chosen = covered[0] ?? attempts[0];
    chosenSeat = chosen.seat;
    escalationChain.push(...chosen.chain);
    for (const r of chosen.touched) touchedRoles.add(r);
    const resolved = chosen.resolution;
    if (resolved.kind === 'COVERED') {
      const cause = chosen.seat.restriction
        ? `the exception "${chosen.seat.restriction.rule.key}" applies — it ${chosen.seat.restriction.scopeChecks.map((s) => s.statement).join(' ')}`
        : `${chosen.seat.deciding.conditionChecks.filter((c) => c.outcome === 'FAIL').map((c) => c.statement).join(' ')}`;
      required.push({
        roleId: resolved.roleId,
        roleLabel: resolved.roleLabel,
        basisRuleId: resolved.rule.id,
        basisRuleKey: resolved.rule.key,
        kind: chosen.seat.restriction ? 'RESTRICTION' : 'ESCALATION',
        reason: `${actor.label}'s authority under "${chosen.seat.deciding.rule.key}" does not decide this: ${cause}`,
        sequence: 1,
        independentOfUserId: independent(chosen.from.rule),
        currentOccupants: occupantsFor(resolved.roleId),
      });
      for (const m of matrixUnknown) {
        gap('METRIC_UNAVAILABLE', `Whether ${m.rule.holder.label}'s approval is also required cannot be established.`);
      }
      if (blocking()) {
        result = 'INDETERMINATE';
      } else {
        addMatrix();
        result = resolved.steps > 1 ? 'ESCALATED' : 'REQUIRES_APPROVAL';
      }
    } else {
      gap(resolved.code, resolved.message);
      result = 'INDETERMINATE';
    }
  } else {
    result = 'NOT_AUTHORIZED';
  }

  for (const r of required) {
    if (r.currentOccupants.length === 0) {
      gap('NO_CURRENT_OCCUPANT', `Nobody occupied ${r.roleLabel} on ${dateOf(actAt)}; the approval cannot be given until someone does.`, false);
    }
  }

  // ---------------------------------------- who holds it (for NOT_AUTHORIZED)
  const authoritiesInScope = rules
    .filter((r) => r.effect === 'GRANT' && typeAndAct(r, act) && r.holder.kind === 'ROLE')
    .map((r) => candidates.get(r.id)!)
    .filter((c) => c.scope === 'WITHIN' && c.conditions === 'PASS')
    .map((c) => ({ roleId: (c.rule.holder as { roleId: string }).roleId, roleLabel: c.rule.holder.label, ruleKey: c.rule.key }));

  // --------------------------------------------- the per-rule report
  const decidingId = chosenSeat.kind === 'DECIDED' ? chosenSeat.deciding.rule.id : null;
  const delegatedRuleIds = new Set(delegationChecks.map((d) => d.basisRuleId).filter((x): x is string => x !== null));
  const assessments: RuleAssessment[] = rules.map((rule) => {
    const c = candidates.get(rule.id)!;
    const policy = policyOf.get(rule.policyId)!;
    const reasons: string[] = [];
    if (decisionTypeKey === null || !rule.decisionTypes.includes(decisionTypeKey)) {
      reasons.push(`covers ${rule.decisionTypes.map(typeName).join(', ')}, not ${typeName(decisionTypeKey)}`);
    }
    if (!rule.acts.includes(act) && rule.effect !== 'REQUIRE_APPROVAL') {
      reasons.push(`grants ${rule.acts.join(', ')}, not ${act}`);
    }
    const prefix = rule.effect === 'GRANT' ? '' : 'does not apply — ';
    for (const s of c.scopeChecks) if (s.outcome !== 'WITHIN') reasons.push(`${prefix}${s.statement}`);
    for (const k of c.conditionChecks) {
      if (k.outcome === 'PASS') continue;
      reasons.push(rule.effect === 'GRANT' && k.outcome === 'FAIL' ? `threshold exceeded — ${k.statement}` : `${prefix}${k.statement}`);
    }
    const relation: RuleAssessment['relation'] = heldByActor(rule)
      ? 'ACTOR'
      : delegatedRuleIds.has(rule.id)
        ? 'DELEGATED'
        : rule.effect === 'REQUIRE_APPROVAL'
          ? 'REQUIREMENT'
          : rule.holder.kind === 'ROLE' && touchedRoles.has(rule.holder.roleId)
            ? 'ESCALATION'
            : 'OTHER_HOLDER';
    if (relation === 'OTHER_HOLDER' && rule.effect === 'GRANT') {
      reasons.push(`held by ${rule.holder.label}, which ${actor.label} did not occupy on ${dateOf(actAt)}`);
    }
    return {
      ruleId: rule.id,
      ruleKey: rule.key,
      policyId: policy.id,
      policyKey: policy.key,
      policyVersion: policy.version,
      policyReference: policy.reference,
      demoPolicy: policy.demo,
      holder: rule.holder,
      effect: rule.effect,
      relation,
      outcome: reasons.length === 0 ? 'MATCHED' : 'REJECTED',
      reasons,
      scopeChecks: c.scopeChecks,
      conditionChecks: c.conditionChecks,
      specificity: describeSpecificity(rule),
      deciding: rule.id === decidingId,
    };
  });

  const governability: Governability =
    result === 'INDETERMINATE' ? 'NOT_GOVERNABLE' : gaps.length > 0 ? 'GOVERNABLE_WITH_GAPS' : 'GOVERNABLE';

  const draft: EvaluationDraft = {
    act,
    actorUserId: actor.userId,
    actorLabel: actor.label,
    actorRoles,
    actAt,
    decisionTypeKey,
    policies: policies.map((p) => ({ policyId: p.id, key: p.key, version: p.version, reference: p.reference, demo: p.demo })),
    scope,
    consequences,
    rules: assessments,
    delegations: delegationChecks,
    basisRuleId,
    basisDelegationId,
    result,
    requiredAuthorities: required.sort((a, b) => a.sequence - b.sequence || a.roleLabel.localeCompare(b.roleLabel)),
    escalationChain,
    authoritiesInScope,
    gaps,
    governability,
    explanation: [],
  };
  return { ...draft, explanation: explain(draft, chosenSeat) };
}

// ------------------------------------------------------------------ helpers

function decideOwn(grants: readonly AuthorityRule[], candidates: ReadonlyMap<string, Candidate>): Own {
  const assessed = grants.map((r) => candidates.get(r.id)!);
  const covering = assessed.filter((c) => c.scope === 'WITHIN');
  if (covering.length === 0) {
    const unknown = assessed.filter((c) => c.scope === 'UNKNOWN').map((c) => c.rule);
    return unknown.length > 0 ? { kind: 'SCOPE_UNKNOWN', rules: unknown } : { kind: 'NONE' };
  }
  const sorted = [...covering].sort(
    (a, b) => compareSpecificity(specificityOf(b.rule), specificityOf(a.rule)) || a.rule.key.localeCompare(b.rule.key),
  );
  const top = sorted.filter((c) => compareSpecificity(specificityOf(c.rule), specificityOf(sorted[0].rule)) === 0);
  if (new Set(top.map((c) => c.conditions)).size > 1) return { kind: 'CONFLICT', rules: top.map((c) => c.rule) };
  return { kind: 'DECIDED', deciding: top[0], restriction: null };
}

function checkDelegation(
  d: Delegation,
  input: EvaluationInput,
  rules: readonly AuthorityRule[],
  candidates: ReadonlyMap<string, Candidate>,
  act: AuthorityAct,
  restrictionFor: (ids: ReadonlySet<string>, a: AuthorityAct) => Candidate | null,
): DelegationCheck {
  const base = {
    delegationId: d.id,
    delegatorLabel: d.delegatorLabel,
    delegatorRoleLabel: d.delegatorRoleLabel,
    delegateLabel: d.delegateLabel,
  };
  const at = input.actAt;
  const window = `${dateOf(d.validFrom)} → ${dateOf(d.validTo)}`;
  const done = (outcome: DelegationCheck['outcome'], statement: string, basisRuleId: string | null = null, conditionChecks: ConditionCheck[] = []): DelegationCheck => ({
    ...base,
    outcome,
    basisRuleId,
    conditionChecks,
    statement,
  });

  if (new Date(d.recordedAt).getTime() > new Date(at).getTime()) {
    return done('NOT_RECORDED_AT_ACT', `The delegation from ${d.delegatorLabel} was recorded after the act; authority is not granted retroactively.`);
  }
  if (d.revokedAt !== null && new Date(d.revokedAt).getTime() <= new Date(at).getTime()) {
    return done('REVOKED', `The delegation from ${d.delegatorLabel} was revoked on ${dateOf(d.revokedAt)}, before the act.`);
  }
  if (!openAt(d.validFrom, d.validTo, at)) {
    return done('NOT_VALID_AT_ACT', `The delegation from ${d.delegatorLabel} is valid ${window}; on ${dateOf(at)} it did not exist.`);
  }
  if (input.decisionTypeKey === null || !d.decisionTypes.includes(input.decisionTypeKey) || !d.acts.includes(act)) {
    return done('TYPE_OR_ACT_NOT_DELEGATED', `The delegation covers ${d.acts.join(', ')} for ${d.decisionTypes.map(typeName).join(', ')}, not ${act} for ${typeName(input.decisionTypeKey)}.`);
  }
  const stillHolds = occupanciesAt(input.occupancies, d.delegatorUserId, at).some((o) => o.roleId === d.delegatorRoleId);
  if (!stillHolds) {
    return done('DELEGATOR_NOT_IN_ROLE', `${d.delegatorLabel} no longer occupied ${d.delegatorRoleLabel} on ${dateOf(at)}; a delegation cannot outlive the authority behind it.`);
  }
  const delegationScope = checkCoverage(d.scope, input.scope);
  if (scopeOutcome(delegationScope) !== 'WITHIN') {
    return done('OUTSIDE_SCOPE', `The delegation is limited to ${delegationScope.map((s) => s.statement).join(' ')}`);
  }
  // The delegator's own deciding rule, intersected with the delegation.
  const delegatorGrants = rules.filter(
    (r) =>
      r.effect === 'GRANT' &&
      r.holder.kind === 'ROLE' &&
      r.holder.roleId === d.delegatorRoleId &&
      input.decisionTypeKey !== null &&
      r.decisionTypes.includes(input.decisionTypeKey) &&
      r.acts.includes(act),
  );
  const own = decideOwn(delegatorGrants, candidates);
  if (own.kind !== 'DECIDED') {
    return done('OUTSIDE_SCOPE', `${d.delegatorRoleLabel}'s own authority does not reach this commitment, so nothing of it could be delegated.`);
  }
  const checks = [...own.deciding.conditionChecks, ...checkConditions(d.conditions, input.consequences)];
  const outcome = conditionsOutcome(checks);
  if (outcome === 'FAIL') {
    return done(
      'EXCEEDED',
      `The delegation does not authorize this: ${checks.filter((c) => c.outcome === 'FAIL').map((c) => c.statement).join(' ')}`,
      own.deciding.rule.id,
      checks,
    );
  }
  if (outcome === 'UNKNOWN') {
    return done('UNKNOWN', `Whether the delegation covers this cannot be established: ${checks.filter((c) => c.outcome === 'UNKNOWN').map((c) => c.statement).join(' ')}`, own.deciding.rule.id, checks);
  }
  const restricted = restrictionFor(new Set([d.delegatorRoleId]), act);
  if (restricted) {
    return done('RESTRICTED', `The exception "${restricted.rule.key}" restricts ${d.delegatorRoleLabel}'s authority here, and a delegation carries the restriction with it.`, own.deciding.rule.id, checks);
  }
  return done(
    'APPLIED',
    `Authorized through ${d.delegatorLabel}'s delegation of ${d.delegatorRoleLabel} authority (${window}, "${d.reason}"): ` +
      `${checks.map((c) => c.statement).join(' ')}`,
    own.deciding.rule.id,
    checks,
  );
}

type Resolution =
  | { kind: 'COVERED'; roleId: string; roleLabel: string; rule: AuthorityRule; steps: number }
  | { kind: 'FAILED'; code: GovernanceGap['code']; message: string };

function resolveEscalation(
  startRoleId: string | null,
  startLabel: string | null,
  input: EvaluationInput,
  rules: readonly AuthorityRule[],
  candidates: ReadonlyMap<string, Candidate>,
  restrictionFor: (ids: ReadonlySet<string>, a: AuthorityAct) => Candidate | null,
  chain: EscalationStep[],
  touched: Set<string>,
): Resolution {
  let roleId = startRoleId;
  let label = startLabel ?? '';
  const visited = new Set<string>();
  for (let step = 1; step <= MAX_ESCALATION_STEPS; step += 1) {
    if (roleId === null) {
      return {
        kind: 'FAILED',
        code: 'ESCALATION_PATH_MISSING',
        message:
          step === 1
            ? 'The rule that was exceeded names no role its excess goes to, and HELM does not assume one.'
            : `${chain[chain.length - 1]?.roleLabel ?? 'The last authority'} is exceeded too, and its rule names nobody further. HELM does not assume a CEO.`,
      };
    }
    if (visited.has(roleId)) {
      chain.push({ roleId, roleLabel: label, ruleKey: null, outcome: 'CYCLE', statement: `${label} was already on the path: the escalation circles.` });
      return { kind: 'FAILED', code: 'ESCALATION_PATH_MISSING', message: 'The escalation path circles back on itself.' };
    }
    visited.add(roleId);
    touched.add(roleId);
    const approve = rules.filter(
      (r) =>
        r.effect === 'GRANT' &&
        r.holder.kind === 'ROLE' &&
        r.holder.roleId === roleId &&
        input.decisionTypeKey !== null &&
        r.decisionTypes.includes(input.decisionTypeKey) &&
        r.acts.includes('APPROVE'),
    );
    const decided = decideOwn(approve, candidates);
    if (decided.kind !== 'DECIDED') {
      chain.push({
        roleId,
        roleLabel: label,
        ruleKey: null,
        outcome: 'NO_RULE',
        statement: `${label} holds no approval authority for ${typeName(input.decisionTypeKey)} that reaches this scope.`,
      });
      return { kind: 'FAILED', code: 'ESCALATION_PATH_MISSING', message: `The escalation reaches ${label}, whose authority does not cover this commitment, and goes no further.` };
    }
    const rule = decided.deciding.rule;
    label = rule.holder.label;
    const restricted = decided.deciding.conditions === 'PASS' ? restrictionFor(new Set([roleId]), 'APPROVE') : null;
    if (restricted) {
      chain.push({ roleId, roleLabel: label, ruleKey: restricted.rule.key, outcome: 'RESTRICTED', statement: `${label}'s approval is restricted here by "${restricted.rule.key}".` });
      roleId = restricted.rule.escalationRoleId;
      label = restricted.rule.escalationRoleLabel ?? '';
      continue;
    }
    if (decided.deciding.conditions === 'PASS') {
      chain.push({
        roleId,
        roleLabel: label,
        ruleKey: rule.key,
        outcome: 'COVERS',
        statement: `${label} — "${rule.key}": ${decided.deciding.scopeChecks.map((s) => s.statement).join(' ')} ${decided.deciding.conditionChecks.map((c) => c.statement).join(' ')}`.trim(),
      });
      return { kind: 'COVERED', roleId, roleLabel: label, rule, steps: step };
    }
    if (decided.deciding.conditions === 'UNKNOWN') {
      chain.push({ roleId, roleLabel: label, ruleKey: rule.key, outcome: 'UNKNOWN', statement: `Whether ${label} covers it cannot be established.` });
      return {
        kind: 'FAILED',
        code: 'METRIC_UNAVAILABLE',
        message: decided.deciding.conditionChecks.filter((c) => c.outcome === 'UNKNOWN').map((c) => c.statement).join(' '),
      };
    }
    chain.push({
      roleId,
      roleLabel: label,
      ruleKey: rule.key,
      outcome: 'EXCEEDED',
      statement: `${label} — "${rule.key}": ${decided.deciding.conditionChecks.filter((c) => c.outcome === 'FAIL').map((c) => c.statement).join(' ')}`,
    });
    roleId = rule.escalationRoleId;
    label = rule.escalationRoleLabel ?? '';
  }
  return { kind: 'FAILED', code: 'ESCALATION_PATH_MISSING', message: 'The escalation path is longer than any policy HELM will follow.' };
}

/** "Who could do this?" — every holder of the act over the scope, covering or not. */
export function findAuthorities(input: {
  act: AuthorityAct;
  at: string;
  decisionTypeKey: string;
  scope: CommitmentScope;
  consequences: readonly ConsequenceValue[];
  policies: readonly AuthorityPolicy[];
  rules: readonly AuthorityRule[];
  occupancies: readonly RoleOccupancy[];
}): AuthorityHolding[] {
  const policies = policiesInForce(input.policies, input.at, input.at);
  const refOf = new Map(policies.map((p) => [p.id, `${p.reference} v${p.version}`]));
  return rulesInForce(input.rules, policies, input.at)
    .filter((r) => r.effect === 'GRANT' && r.holder.kind === 'ROLE' && r.decisionTypes.includes(input.decisionTypeKey) && r.acts.includes(input.act))
    .map((r) => {
      const scopeChecks = checkCoverage(r.scope, input.scope);
      const conditionChecks = checkConditions(r.conditions, input.consequences);
      const roleId = (r.holder as { roleId: string }).roleId;
      return {
        roleId,
        roleLabel: r.holder.label,
        ruleId: r.id,
        ruleKey: r.key,
        policyReference: refOf.get(r.policyId) ?? '',
        acts: r.acts,
        covers: scopeOutcome(scopeChecks) === 'WITHIN' && conditionsOutcome(conditionChecks) === 'PASS',
        conditionChecks,
        occupants: occupantsOf(input.occupancies, roleId, input.at).map((o) => ({ userId: o.userId, label: o.personLabel, kind: o.kind })),
      };
    });
}

// ------------------------------------------------------------- explanation

function explain(draft: EvaluationDraft, own: Own): string[] {
  const lines: string[] = [];
  const policy = draft.policies.map((p) => `${p.reference} v${p.version}${p.demo ? ' (DEMO GOVERNANCE POLICY)' : ''}`).join(', ');
  lines.push(`Decision type: ${typeName(draft.decisionTypeKey)}.`);
  lines.push(
    draft.actorRoles.length > 0
      ? `Actor: ${draft.actorLabel}, occupying ${draft.actorRoles.map((r) => `${r.roleLabel}${r.kind === 'ACTING' ? ' (acting)' : ''}`).join(' and ')} on ${dateOf(draft.actAt)}.`
      : `Actor: ${draft.actorLabel}, occupying no role HELM knows of on ${dateOf(draft.actAt)}.`,
  );
  const summary = Object.entries(draft.scope.summary)
    .filter(([d]) => ['COUNTRY', 'REGION', 'BUSINESS_UNIT', 'CUSTOMER', 'PRODUCT'].includes(d))
    .map(([d, refs]) => `${d.replaceAll('_', ' ').toLowerCase()} ${(refs ?? []).map((r) => r.label).join(', ')}`)
    .join(' · ');
  lines.push(`Scope: ${summary || 'unresolved'} — derived from ${draft.scope.touched.length} entit${draft.scope.touched.length === 1 ? 'y' : 'ies'} the commitment touches.`);
  if (policy) lines.push(`Authority in force on ${dateOf(draft.actAt)}: ${policy}.`);
  for (const c of draft.consequences.filter((x) => x.value !== null)) {
    lines.push(`${c.label}: ${readableAmount(c.value!, c.unit, c.currency)}, read from the chosen future state (${c.nodeLabel ?? c.metricKey}).`);
  }
  if (own.kind === 'DECIDED') {
    const d = own.deciding;
    lines.push(`Rule "${d.rule.key}" (${d.rule.holder.label}): ${d.scopeChecks.map((s) => s.statement).join(' ')}`);
    for (const c of d.conditionChecks) {
      lines.push(c.outcome === 'FAIL' ? `Threshold exceeded: ${c.statement}` : c.outcome === 'UNKNOWN' ? `Threshold unknown: ${c.statement}` : c.statement);
    }
    if (d.rule.conditions.length === 0) lines.push('The rule sets no threshold on consequences.');
    if (own.restriction) lines.push(`Exception "${own.restriction.rule.key}" applies: it ${own.restriction.scopeChecks.map((s) => s.statement).join(' ')}`);
  }
  for (const dc of draft.delegations) lines.push(`Delegation: ${dc.statement}`);
  for (const step of draft.escalationChain) lines.push(`Escalation: ${step.statement}`);
  for (const r of draft.requiredAuthorities) {
    lines.push(
      `Therefore ${r.roleLabel} approval is required${r.kind === 'MATRIX' ? ' (policy requirement)' : ''}` +
        `${r.independentOfUserId ? ', from someone other than the person who committed' : ''}.`,
    );
  }
  if (draft.result === 'NOT_AUTHORIZED') {
    const holds = draft.rules.filter((r) => r.relation === 'ACTOR' && r.effect === 'GRANT');
    if (holds.length > 0) {
      lines.push(
        `${draft.actorLabel} holds ${holds.map((h) => `"${h.ruleKey}"`).join(', ')}, which do not grant ${draft.act} for this commitment: ` +
          holds.flatMap((h) => h.reasons).join('; ') + '.',
      );
    } else {
      lines.push(`${draft.actorLabel} holds no ${draft.act} authority for ${typeName(draft.decisionTypeKey)} decisions.`);
    }
    if (draft.authoritiesInScope.length > 0) {
      lines.push(`Authority over this commitment is held by ${draft.authoritiesInScope.map((a) => a.roleLabel).join(', ')}.`);
    }
  }
  if (draft.basisDelegationId) lines.push('Authorized through a delegation, not through the actor\'s own role.');
  for (const g of draft.gaps) lines.push(`${g.blocking ? 'Missing' : 'Note'}: ${g.message}`);
  lines.push(`Result: ${draft.result}.`);
  return lines;
}

/** Why a required approval exists, in one paragraph — the "why does this need approval?" answer. */
export function whyApprovalIsRequired(evaluation: Pick<AuthorityEvaluation, 'requiredAuthorities' | 'rules' | 'escalationChain'>): string[] {
  const out: string[] = [];
  const deciding = evaluation.rules.find((r) => r.deciding);
  if (deciding) {
    out.push(`${deciding.holder.label}'s authority comes from "${deciding.ruleKey}" (${deciding.policyReference} v${deciding.policyVersion}).`);
    for (const s of deciding.scopeChecks) out.push(`Scope — ${s.statement}`);
    for (const c of deciding.conditionChecks) out.push(`${c.outcome === 'PASS' ? 'Within' : c.outcome === 'FAIL' ? 'Exceeded' : 'Unknown'} — ${c.statement}`);
  }
  for (const step of evaluation.escalationChain) out.push(`Escalation — ${step.statement}`);
  for (const r of evaluation.requiredAuthorities) out.push(`Required — ${r.roleLabel}: ${r.reason}`);
  return out;
}

export { describeCondition };

// --------------------------------------------------- approver authority

export type RoleAuthorityAssessment = {
  readonly outcome: 'COVERS' | 'EXCEEDED' | 'RESTRICTED' | 'NO_RULE' | 'UNKNOWN' | 'CONFLICT';
  readonly rule: AuthorityRule | null;
  readonly conditionChecks: readonly ConditionCheck[];
  readonly statement: string;
};

type AuthorityContext = {
  readonly act: AuthorityAct;
  readonly at: string;
  readonly decisionTypeKey: string | null;
  readonly scope: CommitmentScope;
  readonly consequences: readonly ConsequenceValue[];
  readonly policies: readonly AuthorityPolicy[];
  readonly rules: readonly AuthorityRule[];
  readonly occupancies: readonly RoleOccupancy[];
};

function contextRules(ctx: AuthorityContext) {
  const rules = rulesInForce(ctx.rules, policiesInForce(ctx.policies, ctx.at, ctx.at), ctx.at);
  const candidates = new Map(
    rules.map((rule) => {
      const scopeChecks = rule.effect === 'GRANT' ? checkCoverage(rule.scope, ctx.scope) : checkTouches(rule.scope, ctx.scope);
      const conditionChecks = checkConditions(rule.conditions, ctx.consequences);
      return [rule.id, { rule, scopeChecks, conditionChecks, scope: scopeOutcome(scopeChecks), conditions: conditionsOutcome(conditionChecks) }] as const;
    }),
  );
  const restrictionFor = (ids: ReadonlySet<string>, a: AuthorityAct): Candidate | null =>
    rules
      .filter(
        (r) =>
          r.effect === 'RESTRICT' &&
          ctx.decisionTypeKey !== null &&
          r.decisionTypes.includes(ctx.decisionTypeKey) &&
          r.acts.includes(a) &&
          r.holder.kind === 'ROLE' &&
          ids.has(r.holder.roleId) &&
          candidates.get(r.id)!.scope === 'WITHIN',
      )
      .map((r) => candidates.get(r.id)!)
      .filter((c) => c.conditions !== 'FAIL')[0] ?? null;
  return { rules, candidates, restrictionFor };
}

/**
 * Does a role's own authority, as in force at `at`, cover this act on this
 * commitment? Used to judge an approver at the moment they act — not at the
 * moment the requirement was raised.
 */
export function assessRoleAuthority(ctx: AuthorityContext & { roleId: string }): RoleAuthorityAssessment {
  const { rules, candidates, restrictionFor } = contextRules(ctx);
  const grants = rules.filter(
    (r) =>
      r.effect === 'GRANT' &&
      r.holder.kind === 'ROLE' &&
      r.holder.roleId === ctx.roleId &&
      ctx.decisionTypeKey !== null &&
      r.decisionTypes.includes(ctx.decisionTypeKey) &&
      r.acts.includes(ctx.act),
  );
  const decided = decideOwn(grants, candidates);
  if (decided.kind === 'CONFLICT') {
    return { outcome: 'CONFLICT', rule: null, conditionChecks: [], statement: 'Rules of equal specificity disagree about this role.' };
  }
  if (decided.kind !== 'DECIDED') {
    return { outcome: 'NO_RULE', rule: null, conditionChecks: [], statement: `No ${ctx.act} authority of this role reaches this commitment on ${dateOf(ctx.at)}.` };
  }
  const d = decided.deciding;
  if (d.conditions === 'UNKNOWN') {
    return { outcome: 'UNKNOWN', rule: d.rule, conditionChecks: d.conditionChecks, statement: d.conditionChecks.filter((c) => c.outcome === 'UNKNOWN').map((c) => c.statement).join(' ') };
  }
  if (d.conditions === 'FAIL') {
    return { outcome: 'EXCEEDED', rule: d.rule, conditionChecks: d.conditionChecks, statement: d.conditionChecks.filter((c) => c.outcome === 'FAIL').map((c) => c.statement).join(' ') };
  }
  const restricted = restrictionFor(new Set([ctx.roleId]), ctx.act);
  if (restricted) {
    return { outcome: 'RESTRICTED', rule: d.rule, conditionChecks: d.conditionChecks, statement: `Restricted by "${restricted.rule.key}".` };
  }
  return {
    outcome: 'COVERS',
    rule: d.rule,
    conditionChecks: d.conditionChecks,
    statement: `"${d.rule.key}" covers it: ${[...d.scopeChecks.map((s) => s.statement), ...d.conditionChecks.map((c) => c.statement)].join(' ')}`,
  };
}

/** A delegation assessed for an act at `at` — the same check an evaluation makes. */
export function assessDelegatedAuthority(d: Delegation, ctx: AuthorityContext): DelegationCheck {
  const { rules, candidates, restrictionFor } = contextRules(ctx);
  const input = {
    act: ctx.act,
    actAt: ctx.at,
    actor: { userId: d.delegateUserId, label: d.delegateLabel },
    committerUserId: null,
    decisionTypeKey: ctx.decisionTypeKey,
    knownDecisionTypes: [],
    scope: ctx.scope,
    consequences: ctx.consequences,
    policies: ctx.policies,
    rules: ctx.rules,
    occupancies: ctx.occupancies,
    delegations: [d],
  } satisfies EvaluationInput;
  return checkDelegation(d, input, rules, candidates, ctx.act, restrictionFor);
}
