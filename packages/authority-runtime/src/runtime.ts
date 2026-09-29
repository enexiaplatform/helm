/**
 * The Authority Runtime (ADR-0022).
 *
 *   commitment (Phase 5, untouched) → consequences read from the chosen run →
 *   scope derived from the graph → authority in force at the act →
 *   ENGINE → evaluation → required approvals → approval ACTS → state
 *
 * The runtime adds nothing to the economics and nothing to the commitment. It
 * reads the commitment and its frozen manifest, reads the chosen scenario
 * run's future state, walks the enterprise graph for scope, hands all of it to
 * the pure engine, and records what the engine concluded and what people then
 * did about it.
 *
 * Identity is never taken on trust: the actor of an evaluation is the identity
 * recorded on the commitment; the approver of an act is the authenticated
 * caller, and their role is resolved from occupancy at the moment they act.
 */

import {
  decimal,
  fail,
  hasRole,
  ok,
  periodKey,
  subtract,
  toString as decToString,
  type Clock,
  type Result,
  type Scope,
} from '@helm/shared';
import type { GraphStore } from '@helm/graph-store';
import type { FutureState, FutureStateValue, ScenarioRuntime } from '@helm/scenario-runtime';
import type { DecisionAlternative, DecisionCommitment, DecisionStore } from '@helm/decision-runtime';
import { checkCondition } from './conditions.ts';
import { validateDelegation } from './delegation.ts';
import {
  assessDelegatedAuthority,
  assessRoleAuthority,
  evaluateAuthority,
  findAuthorities,
  whyApprovalIsRequired,
} from './engine.ts';
import { evaluationFingerprint } from './fingerprint.ts';
import { occupanciesAt, policiesInForce, rulesInForce } from './policy.ts';
import { resolveCommitmentScope, type TouchRequest } from './scope.ts';
import { latestEvaluation, projectGovernanceState } from './state.ts';
import {
  AuthorityErrors,
  type ApprovalAct,
  type ApprovalDecision,
  type AuthorityPolicy,
  type AuthorityRule,
  type CommitmentScope,
  type ConsequenceValue,
  type DecisionGovernanceProfile,
  type Delegation,
  type MaterialChange,
  type RoleOccupancy,
} from './types.ts';
import type { ApprovalInput, AuthorityRuntime, AuthorityStore, CreateDelegationInput } from './port.ts';

export const AUTHORITY_STATEMENT =
  'HELM evaluates whether a commitment was within the committing person\'s authority, from the enterprise ' +
  'scope the commitment touches and the consequences the model computed for it, under the authority policy ' +
  'in force when it was made. It records what was required and what was done. It never changes the ' +
  'commitment, and it never approves anything itself.';

export type AuthorityRuntimeOptions = {
  store: AuthorityStore;
  decisions: DecisionStore;
  scenarios: ScenarioRuntime;
  graph: GraphStore;
  clock: Clock;
};

/** Everything the engine needs about one commitment, assembled from existing records. */
type Context = {
  commitment: DecisionCommitment;
  decisionId: string;
  managementQuestion: string;
  chosen: DecisionAlternative;
  state: FutureState | null;
  profile: DecisionGovernanceProfile | null;
  actAt: string;
  consequences: ConsequenceValue[];
  scope: CommitmentScope;
  policies: readonly AuthorityPolicy[];
  rules: readonly AuthorityRule[];
  occupancies: readonly RoleOccupancy[];
  delegations: readonly Delegation[];
  knownTypes: readonly string[];
};

const samePeriod = (a: FutureStateValue['period'], b: FutureStateValue['period'] | null): boolean =>
  b === null || periodKey(a) === periodKey(b);

export function createAuthorityRuntime(opts: AuthorityRuntimeOptions): AuthorityRuntime {
  const { store, decisions, scenarios, graph, clock } = opts;
  const now = () => clock.now().toISOString();

  const event = async (scope: Scope, decisionId: string, eventType: string, payload: Record<string, unknown>) => {
    await decisions.appendEvent(scope, { decisionId, eventType, actorId: scope.actorId ?? null, payload });
  };

  const needAdmin = (scope: Scope, what: string): Result<true> =>
    hasRole(scope, 'admin') ? ok(true) : fail(AuthorityErrors.INVALID_INPUT, `Only an organization admin may ${what}.`);

  // --------------------------------------------------------------- context

  async function currentProfile(scope: Scope, decisionId: string): Promise<Result<DecisionGovernanceProfile | null>> {
    const profiles = await store.listProfiles(scope, decisionId);
    if (!profiles.ok) return profiles;
    return ok(profiles.value[profiles.value.length - 1] ?? null);
  }

  /**
   * Reads each consequence a rule might ask about from the chosen future state.
   * Through the commitment's expected outcome when it names one — that fixes
   * the node and the period — otherwise the one node the future state has for
   * the metric. Anything else is reported as unavailable, with why.
   */
  function readConsequences(
    commitment: DecisionCommitment,
    state: FutureState | null,
    metricKeys: readonly string[],
    labels: ReadonlyMap<string, string>,
  ): ConsequenceValue[] {
    const out: ConsequenceValue[] = [];
    for (const metricKey of metricKeys) {
      const label = labels.get(metricKey) ?? metricKey;
      const expected = commitment.expectedOutcomes.filter((e) => e.kind === 'MODELLED' && e.metricKey === metricKey && e.nodeId);
      const none = (reason: string): ConsequenceValue => ({
        metricKey,
        label,
        nodeId: null,
        nodeLabel: null,
        runId: state?.run.id ?? null,
        period: null,
        value: null,
        unit: null,
        currency: null,
        origin: null,
        source: 'NOT_AVAILABLE',
        reason,
      });
      if (!state) {
        out.push(none('the chosen alternative has no computed future state to read it from'));
        continue;
      }
      let value: FutureStateValue | undefined;
      let source: ConsequenceValue['source'] = 'FUTURE_STATE';
      if (expected.length > 1) {
        out.push(none(`the commitment expects ${expected.length} different ${metricKey} values; HELM will not pick one`));
        continue;
      }
      if (expected.length === 1) {
        value = state.values.find((v) => v.nodeId === expected[0].nodeId && samePeriod(v.period, expected[0].period));
        source = 'EXPECTED_OUTCOME';
      } else {
        const candidates = state.values.filter((v) => v.metricKey === metricKey);
        if (candidates.length > 1) {
          out.push(
            none(
              `the chosen future state has ${candidates.length} ${metricKey} values (${candidates.map((c) => c.nodeLabel).join('; ')}) and the commitment names none of them`,
            ),
          );
          continue;
        }
        value = candidates[0];
      }
      if (!value) {
        out.push(none(`the chosen future state does not model ${metricKey}`));
        continue;
      }
      out.push({
        metricKey,
        label,
        nodeId: value.nodeId,
        nodeLabel: value.nodeLabel,
        runId: state.run.id,
        period: value.period,
        value: value.value,
        unit: value.unit,
        currency: value.currency,
        origin: value.origin,
        source,
        reason: value.value === null ? `${value.origin}${value.reason ? `: ${value.reason}` : ''}` : null,
      });
    }
    return out;
  }

  async function assemble(scope: Scope, commitmentId: string, at?: string): Promise<Result<Context>> {
    const commitment = await decisions.getCommitment(scope, commitmentId);
    if (!commitment.ok) return commitment;
    if (!commitment.value) return fail(AuthorityErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
    const c = commitment.value;
    const decision = await decisions.getDecision(scope, c.decisionId);
    if (!decision.ok) return decision;
    if (!decision.value) return fail(AuthorityErrors.NOT_FOUND, 'The decision behind the commitment could not be read.');
    const alternatives = await decisions.listAlternatives(scope, c.revisionId);
    if (!alternatives.ok) return alternatives;
    const chosen = alternatives.value.find((a) => a.id === c.chosenAlternativeId);
    if (!chosen) return fail(AuthorityErrors.NOT_FOUND, 'The chosen alternative could not be read.');

    let state: FutureState | null = null;
    if (chosen.scenarioRunId) {
      const s = await scenarios.getFutureState(scope, chosen.scenarioRunId);
      if (!s.ok) return s;
      state = s.value;
    }

    const profile = await currentProfile(scope, c.decisionId);
    if (!profile.ok) return profile;

    const [policies, rules, occupancies, delegations, types] = await Promise.all([
      store.listPolicies(scope),
      store.listRules(scope),
      store.listOccupancies(scope),
      store.listDelegations(scope),
      store.listDecisionTypes(scope),
    ]);
    if (!policies.ok) return policies;
    if (!rules.ok) return rules;
    if (!occupancies.ok) return occupancies;
    if (!delegations.ok) return delegations;
    if (!types.ok) return types;

    const actAt = at ?? c.committedAt;
    // Every metric a rule in force might ask about, plus what the commitment expects.
    const inForce = rulesInForce(rules.value, policiesInForce(policies.value, actAt, actAt), actAt);
    const labels = new Map<string, string>();
    for (const r of inForce) for (const k of r.conditions) labels.set(k.metricKey, k.label);
    for (const d of delegations.value) for (const k of d.conditions) labels.set(k.metricKey, k.label);
    for (const e of c.expectedOutcomes) if (e.metricKey && !labels.has(e.metricKey)) labels.set(e.metricKey, e.label);
    const metricKeys = [...new Set([...labels.keys()])].sort();
    const consequences = readConsequences(c, state, metricKeys, labels);

    // What the commitment touches: its consequences, the chosen future's overrides, declared subjects.
    const requests: TouchRequest[] = [];
    for (const v of consequences) {
      if (!v.nodeId || !state) continue;
      const node = state.values.find((x) => x.nodeId === v.nodeId);
      if (node?.subjectEntityId) requests.push({ entityId: node.subjectEntityId, origin: 'CONSEQUENCE', via: `${v.label} (${node.nodeLabel})` });
    }
    if (chosen.scenarioRevisionId) {
      const overrides = await scenarios.listOverrides(scope, chosen.scenarioRevisionId);
      if (!overrides.ok) return overrides;
      for (const o of overrides.value) {
        if (o.subjectEntityId) requests.push({ entityId: o.subjectEntityId, origin: 'SCENARIO_OVERRIDE', via: `${o.operation} ${o.metricKey} override` });
      }
    }
    for (const s of profile.value?.declaredSubjects ?? []) {
      requests.push({ entityId: s.entityId, origin: 'DECLARED_SUBJECT', via: `declared subject ${s.label}` });
    }
    const resolved = await resolveCommitmentScope(graph, scope, requests, actAt);
    if (!resolved.ok) return resolved;

    return ok({
      commitment: c,
      decisionId: c.decisionId,
      managementQuestion: decision.value.managementQuestion,
      chosen,
      state,
      profile: profile.value,
      actAt,
      consequences,
      scope: resolved.value,
      policies: policies.value,
      rules: rules.value,
      occupancies: occupancies.value,
      delegations: delegations.value,
      knownTypes: types.value.map((t) => t.key),
    });
  }

  async function stateOf(scope: Scope, commitmentId: string) {
    const commitment = await decisions.getCommitment(scope, commitmentId);
    if (!commitment.ok) return commitment;
    if (!commitment.value) return fail(AuthorityErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
    const [evaluations, requirements, acts] = await Promise.all([
      store.listEvaluations(scope, { commitmentId }),
      store.listRequiredApprovals(scope, { commitmentId }),
      store.listApprovalActs(scope, { commitmentId }),
    ]);
    if (!evaluations.ok) return evaluations;
    if (!requirements.ok) return requirements;
    if (!acts.ok) return acts;
    return ok(
      projectGovernanceState({
        commitmentId,
        commitmentFingerprint: commitment.value.fingerprint,
        evaluations: evaluations.value,
        requirements: requirements.value,
        acts: acts.value,
        now: now(),
      }),
    );
  }

  async function validate(scope: Scope, input: CreateDelegationInput) {
    const [policies, rules, occupancies] = await Promise.all([store.listPolicies(scope), store.listRules(scope), store.listOccupancies(scope)]);
    if (!policies.ok) return policies;
    if (!rules.ok) return rules;
    if (!occupancies.ok) return occupancies;
    // The ancestry of every entity the delegation or the delegator's rules name.
    const ids = new Set<string>();
    for (const c of input.scope) for (const e of c.entities) ids.add(e.entityId);
    const placed = await resolveCommitmentScope(
      graph,
      scope,
      [...ids].map((entityId) => ({ entityId, origin: 'DECLARED_SUBJECT' as const, via: 'delegation scope' })),
      now(),
    );
    if (!placed.ok) return placed;
    const ancestry = new Map(
      placed.value.touched.map((t) => [t.entityId, Object.values(t.coordinates).flatMap((refs) => (refs ?? []).map((r) => r.entityId))]),
    );
    return ok(
      validateDelegation({
        draft: { ...input, delegatorUserId: scope.actorId, delegateUserId: input.delegateUserId },
        now: now(),
        policies: policies.value,
        rules: rules.value,
        occupancies: occupancies.value,
        ancestry: (id) => ancestry.get(id) ?? [],
      }),
    );
  }

  // --------------------------------------------------------- approval acts

  async function act(scope: Scope, requiredApprovalId: string, decision: ApprovalDecision, input: ApprovalInput): Promise<Result<ApprovalAct>> {
    const requirement = await store.getRequiredApproval(scope, requiredApprovalId);
    if (!requirement.ok) return requirement;
    if (!requirement.value) return fail(AuthorityErrors.NOT_FOUND, `Required approval ${requiredApprovalId} not found.`);
    const r = requirement.value;
    const at = now();

    const refuse = async (code: string, message: string): Promise<Result<never>> => {
      await event(scope, r.decisionId, 'APPROVAL_REFUSED', {
        requiredApprovalId,
        role: r.roleLabel,
        attemptedBy: scope.actorId ?? null,
        decision,
        code,
        reason: message,
      });
      return fail(code, message);
    };

    if (input.comments.trim().length < 4 && decision !== 'APPROVE') {
      return fail(AuthorityErrors.INVALID_INPUT, 'A rejection or a return needs a reason the committer can act on.');
    }
    const evaluation = await store.getEvaluation(scope, r.evaluationId);
    if (!evaluation.ok) return evaluation;
    if (!evaluation.value) return fail(AuthorityErrors.NOT_FOUND, 'The evaluation behind the requirement could not be read.');
    const commitment = await decisions.getCommitment(scope, r.commitmentId);
    if (!commitment.ok) return commitment;
    if (!commitment.value) return fail(AuthorityErrors.NOT_FOUND, 'The commitment could not be read.');
    if (commitment.value.fingerprint !== r.commitmentFingerprint || evaluation.value.commitmentFingerprint !== r.commitmentFingerprint) {
      return refuse(AuthorityErrors.FINGERPRINT_MISMATCH, 'The requirement was raised for a different commitment fingerprint.');
    }
    const all = await store.listEvaluations(scope, { commitmentId: r.commitmentId });
    if (!all.ok) return all;
    const { latest } = latestEvaluation(all.value, r.commitmentFingerprint);
    if (latest?.id !== r.evaluationId) {
      return refuse(AuthorityErrors.SUPERSEDED_EVALUATION, 'A later evaluation of this commitment superseded the one that raised this requirement. Act on the current one.');
    }
    const siblings = await store.listRequiredApprovals(scope, { evaluationId: r.evaluationId });
    if (!siblings.ok) return siblings;
    const priorActs = await store.listApprovalActs(scope, { evaluationId: r.evaluationId });
    if (!priorActs.ok) return priorActs;
    if (priorActs.value.some((a) => a.requiredApprovalId === r.id)) {
      return refuse(AuthorityErrors.ALREADY_ACTED, `${r.roleLabel} has already responded to this requirement. An act is never replaced.`);
    }
    const earlier = siblings.value.filter((s) => s.sequence < r.sequence);
    const waiting = earlier.filter((s) => !priorActs.value.some((a) => a.requiredApprovalId === s.id && a.decision === 'APPROVE'));
    if (waiting.length > 0) {
      return refuse(AuthorityErrors.OUT_OF_SEQUENCE, `The policy orders these approvals: ${waiting.map((w) => w.roleLabel).join(', ')} must approve first.`);
    }

    const approver = scope.actorId;
    if (r.independentOfUserId !== null && r.independentOfUserId === approver) {
      return refuse(
        AuthorityErrors.SEPARATION_OF_DUTIES,
        `Separation of duties: this approval must come from someone other than the person who committed. ` +
          `${commitment.value.committedByLabel} committed it, and cannot also be the independent ${r.roleLabel} approval — ` +
          'whatever role they occupy now.',
      );
    }

    const [policies, rules, occupancies, delegations] = await Promise.all([
      store.listPolicies(scope),
      store.listRules(scope),
      store.listOccupancies(scope),
      store.listDelegations(scope),
    ]);
    if (!policies.ok) return policies;
    if (!rules.ok) return rules;
    if (!occupancies.ok) return occupancies;
    if (!delegations.ok) return delegations;

    const ctx = {
      act: 'APPROVE' as const,
      at,
      decisionTypeKey: evaluation.value.decisionTypeKey,
      scope: evaluation.value.scope,
      consequences: evaluation.value.consequences,
      policies: policies.value,
      rules: rules.value,
      occupancies: occupancies.value,
    };
    const held = occupanciesAt(occupancies.value, approver, at);
    const seat = held.find((o) => o.roleId === r.roleId) ?? null;
    let basis: ApprovalAct['basis'];
    let approverLabel = held[0]?.personLabel ?? String(approver);
    if (seat && r.kind === 'MATRIX') {
      // A matrix requirement IS the policy's statement that this role approves
      // such commitments; its own rule is the basis. Occupancy is what is checked.
      basis = { kind: 'ROLE_OCCUPANCY', occupancyId: seat.id, delegationId: null, ruleId: r.basisRuleId };
      approverLabel = seat.personLabel;
    } else if (seat) {
      const authority = assessRoleAuthority({ ...ctx, roleId: r.roleId });
      if (authority.outcome !== 'COVERS') {
        return refuse(
          AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY,
          `${seat.personLabel} occupies ${r.roleLabel}, but on ${at.slice(0, 10)} that role's authority does not cover this commitment: ${authority.statement} Re-evaluate under the policy now in force.`,
        );
      }
      basis = { kind: 'ROLE_OCCUPANCY', occupancyId: seat.id, delegationId: null, ruleId: authority.rule?.id ?? null };
      approverLabel = seat.personLabel;
    } else if (r.kind === 'MATRIX') {
      return refuse(
        AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY,
        `This requires ${r.roleLabel} in person: a policy requirement is not delegable in this phase. ` +
          `The person acting occupies ${held.length > 0 ? held.map((o) => o.roleLabel).join(' and ') : 'no role'} on ${at.slice(0, 10)}.`,
      );
    } else {
      const delegated = delegations.value
        .filter((d) => d.delegateUserId === approver && d.delegatorRoleId === r.roleId)
        .map((d) => ({ d, check: assessDelegatedAuthority(d, ctx) }))
        .find((x) => x.check.outcome === 'APPLIED');
      if (!delegated) {
        const occupies = held.length > 0 ? held.map((o) => o.roleLabel).join(' and ') : 'no role';
        return refuse(
          AuthorityErrors.NOT_THE_REQUIRED_AUTHORITY,
          `This requires ${r.roleLabel}. The person acting occupies ${occupies} on ${at.slice(0, 10)} and holds no delegation of ${r.roleLabel} authority that covers it.`,
        );
      }
      basis = { kind: 'DELEGATION', occupancyId: null, delegationId: delegated.d.id, ruleId: delegated.check.basisRuleId };
      approverLabel = delegated.d.delegateLabel;
    }

    const recorded = await store.recordApprovalAct(scope, {
      requiredApprovalId: r.id,
      evaluationId: r.evaluationId,
      decisionId: r.decisionId,
      commitmentId: r.commitmentId,
      commitmentFingerprint: r.commitmentFingerprint,
      approverUserId: approver,
      approverLabel,
      approverRoleId: r.roleId,
      approverRoleLabel: r.roleLabel,
      basis,
      decision,
      comments: input.comments,
      conditions: input.conditions ?? '',
      validUntil: input.validUntil ?? null,
      actedAt: at,
    });
    if (!recorded.ok) return refuse(recorded.error.code, recorded.error.message);
    await event(scope, r.decisionId, decision === 'APPROVE' ? 'APPROVAL_GRANTED' : decision === 'REJECT' ? 'APPROVAL_REJECTED' : 'RETURNED_FOR_RECONSIDERATION', {
      requiredApprovalId: r.id,
      approvalActId: recorded.value.id,
      role: r.roleLabel,
      approver: approverLabel,
      basis: basis.kind,
      commitmentFingerprint: r.commitmentFingerprint,
    });
    if (basis.kind === 'DELEGATION') {
      await event(scope, r.decisionId, 'DELEGATION_USED', { delegationId: basis.delegationId, act: 'APPROVE', approvalActId: recorded.value.id });
    }
    return recorded;
  }

  // ------------------------------------------------------------------- API
  return {
    async listDecisionTypes(scope) {
      return store.listDecisionTypes(scope);
    },

    async recordPolicy(scope, input) {
      const allowed = needAdmin(scope, 'record an authority policy');
      if (!allowed.ok) return allowed;
      if (input.rationale.trim().length < 8) {
        return fail(AuthorityErrors.INVALID_INPUT, 'A policy needs its provenance: why does this authority exist?');
      }
      if (input.rules.length === 0) return fail(AuthorityErrors.INVALID_INPUT, 'A policy version with no rules governs nothing.');
      const policy = await store.recordPolicy(scope, {
        key: input.key,
        version: input.version,
        title: input.title,
        reference: input.reference,
        source: input.source,
        demo: input.demo,
        rationale: input.rationale,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        recordedAt: now(),
        recordedBy: scope.actorId ?? null,
        supersedesPolicyId: input.supersedesPolicyId ?? null,
      });
      if (!policy.ok) return policy;
      const recorded: AuthorityRule[] = [];
      for (const r of input.rules) {
        const rule = await store.recordRule(scope, {
          policyId: policy.value.id,
          key: r.key,
          holder: r.holder,
          effect: r.effect,
          decisionTypes: r.decisionTypes,
          acts: r.acts,
          scope: r.scope,
          conditions: r.conditions ?? [],
          escalationRoleId: r.escalationRoleId ?? null,
          escalationRoleLabel: r.escalationRoleLabel ?? null,
          approvalIndependence: r.approvalIndependence ?? 'INDEPENDENT_OF_COMMITTER',
          approvalSequence: r.approvalSequence ?? 1,
          rationale: r.rationale,
          recordedAt: policy.value.recordedAt,
        });
        if (!rule.ok) return rule;
        recorded.push(rule.value);
      }
      return ok({ policy: policy.value, rules: recorded });
    },

    async recordOccupancy(scope, input) {
      const allowed = needAdmin(scope, 'record who occupies a role');
      if (!allowed.ok) return allowed;
      const role = await graph.getEntity(scope, input.roleId as never);
      if (!role.ok) return role;
      if (!role.value || role.value.entityTypeKey !== 'Role') {
        return fail(AuthorityErrors.NOT_FOUND, 'An occupancy names a Role entity of this organization\'s graph.');
      }
      return store.recordOccupancy(scope, {
        roleId: input.roleId,
        roleLabel: role.value.name,
        userId: input.userId,
        personEntityId: input.personEntityId ?? null,
        personLabel: input.personLabel,
        kind: input.kind,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        basis: input.basis,
        recordedAt: now(),
        recordedBy: scope.actorId ?? null,
      });
    },

    async endOccupancy(scope, occupancyId, validTo) {
      const allowed = needAdmin(scope, 'end an occupancy');
      if (!allowed.ok) return allowed;
      return store.endOccupancy(scope, occupancyId, validTo);
    },

    async validateDelegation(scope, input) {
      return validate(scope, input);
    },

    async createDelegation(scope, input) {
      const validation = await validate(scope, input);
      if (!validation.ok) return validation;
      if (!validation.value.valid) {
        return fail(
          AuthorityErrors.DELEGATION_EXCEEDS_AUTHORITY,
          `This delegation is refused: ${validation.value.problems.join('; ')}.`,
          { problems: validation.value.problems },
        );
      }
      const occupancies = await store.listOccupancies(scope);
      if (!occupancies.ok) return occupancies;
      const seat = occupanciesAt(occupancies.value, scope.actorId, now()).find((o) => o.roleId === input.delegatorRoleId)!;
      const created = await store.recordDelegation(scope, {
        delegatorUserId: scope.actorId,
        delegatorLabel: seat.personLabel,
        delegatorRoleId: input.delegatorRoleId,
        delegatorRoleLabel: seat.roleLabel,
        delegateUserId: input.delegateUserId,
        delegateLabel: input.delegateLabel,
        decisionTypes: input.decisionTypes,
        acts: input.acts,
        scope: input.scope,
        conditions: input.conditions,
        validFrom: input.validFrom,
        validTo: input.validTo,
        reason: input.reason,
        recordedAt: now(),
        revokedAt: null,
        revokedReason: null,
      });
      return created;
    },

    async revokeDelegation(scope, delegationId, reason) {
      const d = await store.getDelegation(scope, delegationId);
      if (!d.ok) return d;
      if (!d.value) return fail(AuthorityErrors.NOT_FOUND, `Delegation ${delegationId} not found.`);
      if (d.value.delegatorUserId !== scope.actorId && !hasRole(scope, 'admin')) {
        return fail(AuthorityErrors.INVALID_INPUT, 'Only the delegator or an organization admin may revoke a delegation.');
      }
      return store.revokeDelegation(scope, delegationId, now(), reason);
    },

    async declareGovernanceProfile(scope, decisionId, input) {
      if (!hasRole(scope, 'member')) return fail(AuthorityErrors.INVALID_INPUT, 'Classifying a decision needs member access.');
      const decision = await decisions.getDecision(scope, decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(AuthorityErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
      if (input.decisionTypeKey !== null) {
        const types = await store.listDecisionTypes(scope);
        if (!types.ok) return types;
        if (!types.value.some((t) => t.key === input.decisionTypeKey)) {
          return fail(AuthorityErrors.INVALID_INPUT, `"${input.decisionTypeKey}" is not a registered decision type.`);
        }
      }
      for (const s of input.declaredSubjects ?? []) {
        const e = await graph.getEntity(scope, s.entityId as never);
        if (!e.ok) return e;
        if (!e.value) return fail(AuthorityErrors.NOT_FOUND, `Declared subject ${s.label} is not in this organization's graph.`);
      }
      const profile = await store.recordProfile(scope, {
        decisionId,
        decisionTypeKey: input.decisionTypeKey,
        declaredSubjects: input.declaredSubjects ?? [],
        note: input.note ?? '',
        declaredBy: scope.actorId ?? null,
        declaredAt: now(),
      });
      if (!profile.ok) return profile;
      await event(scope, decisionId, 'GOVERNANCE_CLASSIFIED', {
        profileId: profile.value.id,
        decisionTypeKey: input.decisionTypeKey,
        declaredSubjects: (input.declaredSubjects ?? []).map((s) => s.label),
      });
      return profile;
    },

    async grantVisibility(scope, decisionId, input) {
      if (!hasRole(scope, 'member')) return fail(AuthorityErrors.INVALID_INPUT, 'Sharing a decision needs member access.');
      const decision = await decisions.getDecision(scope, decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(AuthorityErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
      if (input.reason.trim().length < 4) return fail(AuthorityErrors.INVALID_INPUT, 'Sharing a decision needs a reason.');
      return store.grantVisibility(scope, {
        decisionId,
        orgUnitId: input.orgUnitId,
        orgUnitLabel: input.orgUnitLabel,
        reason: input.reason,
        grantedBy: scope.actorId ?? null,
        grantedAt: now(),
      });
    },

    // ------------------------------------------------------------ evaluation
    async evaluate(scope, commitmentId) {
      const ctx = await assemble(scope, commitmentId);
      if (!ctx.ok) return ctx;
      const c = ctx.value;
      const committer = c.commitment.committedBy;
      const seat = committer ? occupanciesAt(c.occupancies, committer, c.actAt)[0] : undefined;
      const draft = evaluateAuthority({
        act: 'COMMIT',
        actAt: c.actAt,
        actor: { userId: committer, label: seat?.personLabel ?? c.commitment.committedByLabel },
        committerUserId: committer,
        decisionTypeKey: c.profile?.decisionTypeKey ?? null,
        knownDecisionTypes: c.knownTypes,
        scope: c.scope,
        consequences: c.consequences,
        policies: c.policies,
        rules: c.rules,
        occupancies: c.occupancies,
        delegations: c.delegations,
      });
      const previous = await store.listEvaluations(scope, { commitmentId });
      if (!previous.ok) return previous;
      const { latest } = latestEvaluation(previous.value, c.commitment.fingerprint);

      const evaluation = await store.recordEvaluation(scope, {
        ...draft,
        decisionId: c.decisionId,
        commitmentId,
        commitmentFingerprint: c.commitment.fingerprint,
        evaluatedAt: now(),
        evaluatedBy: scope.actorId ?? null,
        profileId: c.profile?.id ?? null,
        fingerprint: evaluationFingerprint({ commitmentFingerprint: c.commitment.fingerprint, ...draft }),
        supersedesEvaluationId: latest?.id ?? null,
      });
      if (!evaluation.ok) return evaluation;

      const required = [];
      for (const r of draft.requiredAuthorities) {
        const recorded = await store.recordRequiredApproval(scope, {
          evaluationId: evaluation.value.id,
          decisionId: c.decisionId,
          commitmentId,
          commitmentFingerprint: c.commitment.fingerprint,
          roleId: r.roleId,
          roleLabel: r.roleLabel,
          basisRuleId: r.basisRuleId,
          kind: r.kind,
          reason: r.reason,
          sequence: r.sequence,
          independentOfUserId: r.independentOfUserId,
          createdAt: evaluation.value.evaluatedAt,
        });
        if (!recorded.ok) return recorded;
        required.push(recorded.value);
      }

      await event(scope, c.decisionId, 'AUTHORITY_EVALUATED', {
        evaluationId: evaluation.value.id,
        commitmentId,
        commitmentFingerprint: c.commitment.fingerprint,
        result: draft.result,
        policies: draft.policies.map((p) => `${p.reference} v${p.version}`),
        supersedes: latest?.id ?? null,
      });
      for (const r of required) {
        await event(scope, c.decisionId, 'APPROVAL_REQUESTED', { requiredApprovalId: r.id, role: r.roleLabel, kind: r.kind, sequence: r.sequence });
      }
      if (draft.result === 'ESCALATED') {
        await event(scope, c.decisionId, 'ESCALATED', { to: draft.requiredAuthorities.map((r) => r.roleLabel), chain: draft.escalationChain.map((s) => s.roleLabel) });
      }
      if (draft.basisDelegationId) {
        await event(scope, c.decisionId, 'DELEGATION_USED', { delegationId: draft.basisDelegationId, act: 'COMMIT', evaluationId: evaluation.value.id });
      }
      return ok({ evaluation: evaluation.value, required });
    },

    async explain(scope, evaluationId) {
      const e = await store.getEvaluation(scope, evaluationId);
      if (!e.ok) return e;
      if (!e.value) return fail(AuthorityErrors.NOT_FOUND, `Evaluation ${evaluationId} not found.`);
      return ok({ evaluation: e.value, why: [...whyApprovalIsRequired(e.value), ...e.value.explanation] });
    },

    async findAuthorities(scope, commitmentId, act) {
      const ctx = await assemble(scope, commitmentId);
      if (!ctx.ok) return ctx;
      const type = ctx.value.profile?.decisionTypeKey;
      if (!type) return fail(AuthorityErrors.INVALID_INPUT, 'The decision has no decision type, so nobody can be found to hold authority over it.');
      return ok(
        findAuthorities({
          act,
          at: now(),
          decisionTypeKey: type,
          scope: ctx.value.scope,
          consequences: ctx.value.consequences,
          policies: ctx.value.policies,
          rules: ctx.value.rules,
          occupancies: ctx.value.occupancies,
        }),
      );
    },

    async resolveRequiredApprovals(scope, evaluationId) {
      return store.listRequiredApprovals(scope, { evaluationId });
    },

    async approvalRequest(scope, requiredApprovalId) {
      const r = await store.getRequiredApproval(scope, requiredApprovalId);
      if (!r.ok) return r;
      if (!r.value) return fail(AuthorityErrors.NOT_FOUND, `Required approval ${requiredApprovalId} not found.`);
      const e = await store.getEvaluation(scope, r.value.evaluationId);
      if (!e.ok) return e;
      if (!e.value) return fail(AuthorityErrors.NOT_FOUND, 'The evaluation could not be read.');
      const c = await decisions.getCommitment(scope, r.value.commitmentId);
      if (!c.ok) return c;
      if (!c.value) return fail(AuthorityErrors.NOT_FOUND, 'The commitment could not be read.');
      const decision = await decisions.getDecision(scope, c.value.decisionId);
      if (!decision.ok) return decision;
      const snapshot = await decisions.getSnapshot(scope, c.value.snapshotId);
      if (!snapshot.ok) return snapshot;
      const challenges = await decisions.listChallenges(scope, c.value.revisionId);
      if (!challenges.ok) return challenges;
      const assumptions = await decisions.listAssumptions(scope, c.value.revisionId);
      if (!assumptions.ok) return assumptions;
      const chosen = snapshot.value?.alternatives.find((a) => a.chosen);
      const uncertainty = [
        ...challenges.value.filter((x) => x.status === 'OPEN').map((x) => `Open challenge — ${x.author.label}: ${x.concern}`),
        ...assumptions.value
          .filter((a) => a.criticality === 'CRITICAL' && a.owner === null)
          .map((a) => `Critical assumption nobody stands behind: ${a.statement}`),
        ...(chosen?.completeness && chosen.completeness !== 'COMPLETE' ? [`The chosen future state is ${chosen.completeness}.`] : []),
        ...e.value.gaps.map((g) => g.message),
      ];
      return ok({
        requirement: r.value,
        evaluation: e.value,
        managementQuestion: decision.value?.managementQuestion ?? '',
        chosenAlternative: { id: c.value.chosenAlternativeId, label: chosen?.label ?? '', scenarioKey: chosen?.scenarioKey ?? null },
        committedByLabel: c.value.committedByLabel,
        committedAt: c.value.committedAt,
        keyConsequences: e.value.consequences.filter((v) => v.value !== null),
        acceptedTradeOffs: c.value.acceptedTradeOffs.map((t) => ({ label: t.label, statement: t.statement })),
        uncertainty,
        authorityReason: whyApprovalIsRequired(e.value),
      });
    },

    async recordApproval(scope, requiredApprovalId, input) {
      return act(scope, requiredApprovalId, 'APPROVE', input);
    },
    async recordRejection(scope, requiredApprovalId, input) {
      return act(scope, requiredApprovalId, 'REJECT', input);
    },
    async returnForReconsideration(scope, requiredApprovalId, input) {
      return act(scope, requiredApprovalId, 'RETURN_FOR_RECONSIDERATION', input);
    },

    async getGovernanceState(scope, commitmentId) {
      return stateOf(scope, commitmentId);
    },

    async explainApproval(scope, approvalActId) {
      const a = await store.getApprovalAct(scope, approvalActId);
      if (!a.ok) return a;
      if (!a.value) return fail(AuthorityErrors.NOT_FOUND, `Approval act ${approvalActId} not found.`);
      const r = await store.getRequiredApproval(scope, a.value.requiredApprovalId);
      if (!r.ok) return r;
      if (!r.value) return fail(AuthorityErrors.NOT_FOUND, 'The requirement could not be read.');
      const e = await store.getEvaluation(scope, a.value.evaluationId);
      if (!e.ok) return e;
      if (!e.value) return fail(AuthorityErrors.NOT_FOUND, 'The evaluation could not be read.');
      const basisRuleId = a.value.basis.ruleId ?? r.value.basisRuleId;
      const basisRule = await store.getRule(scope, basisRuleId);
      if (!basisRule.ok) return basisRule;
      if (!basisRule.value) return fail(AuthorityErrors.NOT_FOUND, 'The rule the approval rested on could not be read.');
      const requirementRule = await store.getRule(scope, r.value.basisRuleId);
      if (!requirementRule.ok) return requirementRule;
      if (!requirementRule.value) return fail(AuthorityErrors.NOT_FOUND, 'The rule behind the requirement could not be read.');
      const policy = await store.getPolicy(scope, basisRule.value.policyId);
      if (!policy.ok) return policy;
      if (!policy.value) return fail(AuthorityErrors.NOT_FOUND, 'The policy could not be read.');
      const occupancies = await store.listOccupancies(scope);
      if (!occupancies.ok) return occupancies;
      const c = await decisions.getCommitment(scope, a.value.commitmentId);
      if (!c.ok) return c;
      if (!c.value) return fail(AuthorityErrors.NOT_FOUND, 'The commitment could not be read.');
      const runId = e.value.consequences.find((v) => v.runId)?.runId ?? null;
      const valueLineage: unknown[] = [];
      for (const v of e.value.consequences) {
        if (!v.nodeId || !v.runId) continue;
        const l = await scenarios.explain(scope, v.runId, v.nodeId, v.period ?? undefined);
        if (l.ok) valueLineage.push(l.value);
      }
      return ok({
        act: a.value,
        requirement: r.value,
        evaluation: e.value,
        basisRule: basisRule.value,
        basisPolicy: policy.value,
        requirementRule: requirementRule.value,
        approverOccupancy: occupancies.value.find((o) => o.id === a.value!.basis.occupancyId) ?? null,
        commitment: {
          id: c.value.id,
          fingerprint: c.value.fingerprint,
          chosenAlternativeId: c.value.chosenAlternativeId,
          committedByLabel: c.value.committedByLabel,
        },
        chosenRunId: runId,
        consequences: e.value.consequences,
        valueLineage,
        statement:
          `${a.value.approverLabel} ${a.value.decision === 'APPROVE' ? 'approved' : a.value.decision === 'REJECT' ? 'rejected' : 'returned'} ` +
          `as ${a.value.approverRoleLabel} under "${basisRule.value.key}" (${policy.value.reference} v${policy.value.version}); ` +
          `the requirement came from evaluation ${e.value.fingerprint} of commitment ${c.value.fingerprint}.`,
      });
    },

    async materialChange(scope, evaluationId, againstRunId) {
      const e = await store.getEvaluation(scope, evaluationId);
      if (!e.ok) return e;
      if (!e.value) return fail(AuthorityErrors.NOT_FOUND, `Evaluation ${evaluationId} not found.`);
      const state = await scenarios.getFutureState(scope, againstRunId);
      if (!state.ok) return state;
      const changes: MaterialChange[] = [];
      for (const v of e.value.consequences) {
        const current = state.value.values.find(
          (x) => v.nodeId !== null && x.nodeId === v.nodeId && (v.period === null || periodKey(x.period) === periodKey(v.period)),
        );
        const currentValue = current?.value ?? null;
        if (currentValue === v.value) continue;
        const replaced = e.value.consequences.map((x) => (x.metricKey === v.metricKey ? { ...x, value: currentValue } : x));
        const flips = e.value.rules.some((rule) =>
          rule.conditionChecks.some((check) => {
            if (check.metricKey !== v.metricKey) return false;
            const again = checkCondition(
              { metricKey: check.metricKey, label: check.label, comparator: check.comparator, threshold: check.threshold, unit: check.unit, currency: check.currency },
              replaced,
            );
            return again.outcome !== check.outcome;
          }),
        );
        const delta =
          currentValue !== null && v.value !== null ? decToString(subtract(decimal(currentValue), decimal(v.value))) : null;
        changes.push({ metricKey: v.metricKey, label: v.label, evaluatedValue: v.value, currentValue, delta, changesACondition: flips });
      }
      const required = changes.some((c) => c.changesACondition);
      return ok({
        evaluationId,
        againstRunId,
        changes,
        reevaluationRequired: required,
        statement: required
          ? 'A consequence the evaluation relied on has moved across a line a rule draws. The evaluation still stands as a record of what was judged; a new commitment, evaluated afresh, is how the change is governed.'
          : changes.length > 0
            ? 'Consequences have moved, but not across any line a rule draws.'
            : 'Nothing the evaluation read has changed.',
      });
    },

    async listPolicies(scope) {
      return store.listPolicies(scope);
    },
    async listRules(scope) {
      return store.listRules(scope);
    },
    async listOccupancies(scope) {
      return store.listOccupancies(scope);
    },
    async listDelegations(scope) {
      return store.listDelegations(scope);
    },
    async listEvaluations(scope, filter) {
      return store.listEvaluations(scope, filter);
    },
    async listApprovalActs(scope, filter) {
      return store.listApprovalActs(scope, filter);
    },
    async listVisibility(scope, decisionId) {
      return store.listVisibility(scope, decisionId);
    },
    async currentProfile(scope, decisionId) {
      return currentProfile(scope, decisionId);
    },
  };
}
