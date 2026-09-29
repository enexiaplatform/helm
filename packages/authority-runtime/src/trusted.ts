/**
 * The TRUSTED authority service (ADR-0024).
 *
 * Phase 6 computed authority verdicts wherever the kernel ran — in cloud mode,
 * the browser — and the database could check identity and immutability but not
 * the threshold arithmetic. This is the server-side path that closes that gap.
 * It is transport-agnostic: the Supabase edge function `helm-authority` wraps
 * it, and the tests drive it directly with the same request bodies.
 *
 * What the service accepts is deliberately tiny. A caller may ask
 *
 *     { op: 'evaluate', orgId, commitmentId }
 *     { op: 'approve' | 'reject' | 'return', orgId, requiredApprovalId, comments, conditions?, validUntil? }
 *
 * and nothing else. A request that tries to SUPPLY a fact — a consequence
 * value, a role, a scope, a policy, an actor or an approver — is refused
 * outright, by name, before anything is read. Everything the verdict rests on
 * is loaded from HELM's own records:
 *
 *   1. the caller's identity comes from a VERIFIED token, never the body;
 *   2. their organization role and units come from membership records;
 *   3. the commitment, its fingerprint and the chosen alternative from the
 *      decision store; the evaluated actor is the recorded committer;
 *   4. the chosen run's consequences from the scenario store — and before
 *      they are believed, the run's calculation trace is RE-DERIVED with the
 *      governed formulas (propagation-engine verify.ts) and every scenario
 *      override it applied is checked against the sealed revision;
 *   5. occupancy, scope, policy version, thresholds — the Phase 6 engine;
 *   6. the evaluation is written by the service, stamped TRUSTED_SERVICE.
 *
 * The caller must be able to SEE the decision (visibility is checked as the
 * caller); what they may see does not change what the verdict is (the facts
 * are read as the service). Seeing is not deciding, and asking is not either:
 * anyone who can read a commitment may ask for it to be evaluated, and the
 * verdict is always about the person who committed it.
 */

import { fail, ok, type OrgId, type OrgRole, type Result, type Scope, type UserId } from '@helm/shared';
import type { DecisionStore } from '@helm/decision-runtime';
import type { ScenarioRuntime } from '@helm/scenario-runtime';
import {
  canonicalNumeric,
  verifyCalculationTrace,
  type CalculationRegistry,
  type CalculationStep,
  type PropagationEngine,
} from '@helm/propagation-engine';
import type { ValueGraph, ValueMetricDefinition, ValueObservation } from '@helm/value-graph';
import type { AuthorityRuntime, AuthorityStore } from './port.ts';
import { AuthorityErrors, type ConsequenceCheck } from './types.ts';

export const TRUSTED_HOST_EDGE = 'edge:helm-authority';

export const TrustedErrors = {
  UNAUTHENTICATED: 'authority.unauthenticated',
  NOT_A_MEMBER: 'authority.not_a_member',
  MALFORMED: 'authority.malformed_request',
  CLIENT_SUPPLIED_FACTS: 'authority.client_supplied_facts',
  CONSEQUENCES_UNVERIFIED: 'authority.consequences_unverified',
} as const;

/** Who is calling, as a verified token says. Nothing else about them is taken from the caller. */
export type VerifiedIdentity = { readonly userId: UserId };

export type Membership = {
  readonly orgRole: OrgRole;
  readonly memberUnitIds: readonly string[];
};

export type TrustedAuthorityDeps = {
  /** The authority runtime over the SERVICE's stores, constructed as TRUSTED_SERVICE. */
  readonly runtime: AuthorityRuntime;
  readonly store: AuthorityStore;
  readonly decisions: DecisionStore;
  readonly scenarios: ScenarioRuntime;
  readonly engine: PropagationEngine;
  readonly registry: CalculationRegistry;
  readonly valueGraph: ValueGraph;
  /** The caller's membership of `orgId`, from membership records. Null = not a member. */
  readonly membershipOf: (userId: UserId, orgId: OrgId) => Promise<Result<Membership | null>>;
  /** Can this caller read this decision? Answered AS THE CALLER (RLS in the cloud). */
  readonly callerCanSeeDecision: (scope: Scope, decisionId: string) => Promise<Result<boolean>>;
};

export type TrustedResponse = {
  readonly status: 200 | 400 | 401 | 403 | 404 | 409 | 422;
  readonly body: Readonly<Record<string, unknown>>;
};

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  evaluate: ['op', 'orgId', 'commitmentId'],
  approve: ['op', 'orgId', 'requiredApprovalId', 'comments', 'conditions', 'validUntil'],
  reject: ['op', 'orgId', 'requiredApprovalId', 'comments', 'conditions', 'validUntil'],
  return: ['op', 'orgId', 'requiredApprovalId', 'comments', 'conditions', 'validUntil'],
};

const refuse = (status: TrustedResponse['status'], code: string, message: string, extra: Record<string, unknown> = {}): TrustedResponse => ({
  status,
  body: { ok: false, error: { code, message, ...extra } },
});

const statusOf = (code: string): TrustedResponse['status'] =>
  code === AuthorityErrors.NOT_FOUND
    ? 404
    : code === AuthorityErrors.INVALID_INPUT
      ? 400
      : code.startsWith('authority.')
        ? 409
        : 422;

/**
 * Re-derives a scenario run's consequences from its own trace before anyone
 * relies on them. Returns the problems, never repairs them.
 */
export async function verifyScenarioRun(
  deps: Pick<TrustedAuthorityDeps, 'scenarios' | 'engine' | 'registry' | 'valueGraph'>,
  scope: Scope,
  scenarioRunId: string,
): Promise<Result<ConsequenceCheck & { readonly verified: boolean; readonly problems: readonly string[] }>> {
  const state = await deps.scenarios.getFutureState(scope, scenarioRunId);
  if (!state.ok) return state;
  const run = state.value.run;
  const metrics = await deps.valueGraph.findMetricDefinitions(scope, { includeInactive: true });
  if (!metrics.ok) return metrics;
  const metricByKey = new Map<string, ValueMetricDefinition>(metrics.value.map((m) => [m.key, m]));

  const problems: string[] = [];
  let checkedSteps = 0;
  let checkedInputs = 0;
  const calcRunIds: string[] = [];
  const observationsByNode = new Map<string, readonly ValueObservation[]>();
  const observationOf = async (nodeId: string, id: string): Promise<ValueObservation | null> => {
    if (!observationsByNode.has(nodeId)) {
      const all = await deps.valueGraph.getObservations(scope, { nodeId, limit: 1000 });
      observationsByNode.set(nodeId, all.ok ? all.value : []);
    }
    return observationsByNode.get(nodeId)!.find((o) => o.id === id) ?? null;
  };

  if (run.status !== 'COMPLETED' && run.status !== 'PARTIAL') problems.push(`The run is ${run.status}; only a completed run carries consequences.`);
  if (run.revisionId !== null) {
    const revisions = run.scenarioId ? await deps.scenarios.listRevisions(scope, run.scenarioId) : ok([]);
    if (!revisions.ok) return revisions;
    const revision = revisions.value.find((r) => r.id === run.revisionId);
    if (!revision) problems.push('The run names a scenario revision that does not exist.');
    else if (revision.state !== 'SEALED' || revision.fingerprint !== run.fingerprint) {
      problems.push('The run was not executed from a sealed revision with the fingerprint it claims.');
    }
  }

  for (const pr of run.periodRuns) {
    calcRunIds.push(pr.calculationRunId);
    const calcRun = await deps.engine.getRun(scope, pr.calculationRunId);
    if (!calcRun.ok) return calcRun;
    if (!calcRun.value) {
      problems.push(`Period run ${pr.calculationRunId} does not exist.`);
      continue;
    }
    const steps = await deps.engine.getTrace(scope, pr.calculationRunId);
    if (!steps.ok) return steps;
    const subjects = new Map<string, string | null>();
    for (const s of steps.value) {
      if (subjects.has(s.outputNodeId)) continue;
      const node = await deps.valueGraph.getValueNode(scope, s.outputNodeId);
      subjects.set(s.outputNodeId, node.ok && node.value ? node.value.subjectEntityId : null);
    }
    const nodeOfObservation = new Map<string, string>();
    const remember = (step: CalculationStep) => {
      for (const t of step.inputs) {
        for (const p of t.components ?? [{ nodeId: t.nodeId, observationId: t.observationId }]) nodeOfObservation.set(p.observationId, p.nodeId);
      }
    };
    steps.value.forEach(remember);
    const verified = await verifyCalculationTrace({
      scope,
      run: calcRun.value,
      steps: steps.value,
      registry: deps.registry,
      metricOf: (k) => metricByKey.get(k) ?? null,
      subjectOf: (nodeId) => (subjects.get(nodeId) ?? null) as never,
      observationOf: (id) => observationOf(nodeOfObservation.get(id) ?? '', id),
    });
    if (!verified.ok) return verified;
    checkedSteps += verified.value.checkedSteps;
    checkedInputs += verified.value.checkedInputs;
    problems.push(...verified.value.problems);

    // Every override the trace applied must be one the SEALED revision states.
    for (const o of verified.value.overrides) {
      const overrides = await deps.scenarios.listOverrides(scope, o.override.revisionId);
      if (!overrides.ok) return overrides;
      const stated = overrides.value.find((x) => x.id === o.override.overrideId);
      if (!stated) {
        problems.push(`Input "${o.input}" claims override ${o.override.overrideId}, which revision ${o.override.revisionId} does not state.`);
        continue;
      }
      if (stated.operation !== o.override.operation || stated.value !== o.override.value) {
        problems.push(`Input "${o.input}" applies ${o.override.operation} ${o.override.value}, but the revision states ${stated.operation} ${stated.value}.`);
        continue;
      }
      if (stated.operation === 'ADD') {
        const base = o.override.baseline;
        if (!base) {
          problems.push(`Input "${o.input}" is an ADD override with no recorded baseline.`);
          continue;
        }
        const baseObs = await observationOf(o.nodeId, base.observationId);
        if (!baseObs || canonicalNumeric(String(baseObs.numericValue)) !== canonicalNumeric(base.value)) {
          problems.push(`Input "${o.input}" adds to a baseline of ${base.value} that observation ${base.observationId} does not hold.`);
        }
      }
    }
  }

  const verified = problems.length === 0;
  return ok({
    status: verified ? ('TRACE_VERIFIED' as const) : ('NOT_CHECKED' as const),
    runIds: [scenarioRunId, ...calcRunIds],
    checkedSteps,
    checkedInputs,
    verified,
    problems,
  });
}

export function createTrustedAuthorityService(deps: TrustedAuthorityDeps) {
  async function callerScope(identity: VerifiedIdentity, orgId: unknown): Promise<Result<Scope>> {
    if (typeof orgId !== 'string' || orgId.length === 0) return fail(TrustedErrors.MALFORMED, 'The request names no organization.');
    const membership = await deps.membershipOf(identity.userId, orgId as OrgId);
    if (!membership.ok) return membership;
    if (!membership.value) return fail(TrustedErrors.NOT_A_MEMBER, 'The caller is not a member of that organization.');
    return ok({
      orgId: orgId as OrgId,
      actorId: identity.userId,
      role: membership.value.orgRole,
      orgUnitIds: membership.value.memberUnitIds as never,
      functions: [],
    });
  }

  async function gate(scope: Scope, decisionId: string): Promise<TrustedResponse | null> {
    const visible = await deps.callerCanSeeDecision(scope, decisionId);
    if (!visible.ok) return refuse(422, visible.error.code, visible.error.message);
    // Not 403: a decision the caller cannot read is, to them, one that does not exist.
    return visible.value ? null : refuse(404, AuthorityErrors.NOT_FOUND, 'No such commitment is visible to the caller.');
  }

  return {
    /**
     * One request. `identity` is what the host's token verification produced;
     * `body` is the untrusted request body, exactly as received.
     */
    async handle(identity: VerifiedIdentity | null, body: unknown): Promise<TrustedResponse> {
      if (!identity) return refuse(401, TrustedErrors.UNAUTHENTICATED, 'The authority service needs a signed-in caller.');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return refuse(400, TrustedErrors.MALFORMED, 'The request body must be a JSON object.');
      }
      const request = body as Record<string, unknown>;
      const op = typeof request.op === 'string' ? request.op : '';
      const allowed = ALLOWED_KEYS[op];
      if (!allowed) return refuse(400, TrustedErrors.MALFORMED, `Unknown operation "${op}". Allowed: ${Object.keys(ALLOWED_KEYS).join(', ')}.`);
      const supplied = Object.keys(request).filter((k) => !allowed.includes(k)).sort();
      if (supplied.length > 0) {
        return refuse(
          400,
          TrustedErrors.CLIENT_SUPPLIED_FACTS,
          `The authority service reads consequences, roles, scope, policy and identity from HELM's own records; ` +
            `it does not accept them from a caller. Refused field${supplied.length === 1 ? '' : 's'}: ${supplied.join(', ')}.`,
          { refusedFields: supplied },
        );
      }
      const scope = await callerScope(identity, request.orgId);
      if (!scope.ok) return refuse(scope.error.code === TrustedErrors.NOT_A_MEMBER ? 403 : 400, scope.error.code, scope.error.message);

      if (op === 'evaluate') {
        if (typeof request.commitmentId !== 'string') return refuse(400, TrustedErrors.MALFORMED, 'evaluate needs a commitmentId.');
        const commitment = await deps.decisions.getCommitment(scope.value, request.commitmentId);
        if (!commitment.ok) return refuse(422, commitment.error.code, commitment.error.message);
        if (!commitment.value) return refuse(404, AuthorityErrors.NOT_FOUND, 'No such commitment is visible to the caller.');
        const denied = await gate(scope.value, commitment.value.decisionId);
        if (denied) return denied;

        // Verify the consequences before the engine is allowed to read them.
        const alternatives = await deps.decisions.listAlternatives(scope.value, commitment.value.revisionId);
        if (!alternatives.ok) return refuse(422, alternatives.error.code, alternatives.error.message);
        const chosen = alternatives.value.find((a) => a.id === commitment.value!.chosenAlternativeId);
        let check: ConsequenceCheck = { status: 'NOT_CHECKED', runIds: [], checkedSteps: 0, checkedInputs: 0 };
        if (chosen?.scenarioRunId) {
          const verified = await verifyScenarioRun(deps, scope.value, chosen.scenarioRunId);
          if (!verified.ok) return refuse(422, verified.error.code, verified.error.message);
          if (!verified.value.verified) {
            await deps.decisions.appendEvent(scope.value, {
              decisionId: commitment.value.decisionId,
              eventType: 'AUTHORITY_REFUSED',
              actorId: identity.userId,
              payload: { commitmentId: commitment.value.id, reason: 'consequences did not verify', problems: verified.value.problems.slice(0, 20) },
            });
            return refuse(
              422,
              TrustedErrors.CONSEQUENCES_UNVERIFIED,
              'The chosen future\'s calculation trace does not re-derive from its recorded inputs, so no authority ' +
                'verdict is given on it. Nothing was recorded as an evaluation.',
              { problems: verified.value.problems },
            );
          }
          check = { status: 'TRACE_VERIFIED', runIds: verified.value.runIds, checkedSteps: verified.value.checkedSteps, checkedInputs: verified.value.checkedInputs };
        }
        const result = await deps.runtime.evaluate(scope.value, commitment.value.id, { consequenceCheck: check });
        if (!result.ok) return refuse(statusOf(result.error.code), result.error.code, result.error.message);
        return { status: 200, body: { ok: true, evaluation: result.value.evaluation, required: result.value.required } };
      }

      // approve / reject / return: the approver IS the verified caller.
      if (typeof request.requiredApprovalId !== 'string') return refuse(400, TrustedErrors.MALFORMED, `${op} needs a requiredApprovalId.`);
      if (typeof request.comments !== 'string') return refuse(400, TrustedErrors.MALFORMED, `${op} needs comments.`);
      const requirement = await deps.store.getRequiredApproval(scope.value, request.requiredApprovalId);
      if (!requirement.ok) return refuse(422, requirement.error.code, requirement.error.message);
      if (!requirement.value) return refuse(404, AuthorityErrors.NOT_FOUND, 'No such approval requirement is visible to the caller.');
      const denied = await gate(scope.value, requirement.value.decisionId);
      if (denied) return denied;
      const input = {
        comments: request.comments,
        conditions: typeof request.conditions === 'string' ? request.conditions : undefined,
        validUntil: typeof request.validUntil === 'string' ? request.validUntil : null,
      };
      const act =
        op === 'approve'
          ? await deps.runtime.recordApproval(scope.value, requirement.value.id, input)
          : op === 'reject'
            ? await deps.runtime.recordRejection(scope.value, requirement.value.id, input)
            : await deps.runtime.returnForReconsideration(scope.value, requirement.value.id, input);
      if (!act.ok) return refuse(statusOf(act.error.code), act.error.code, act.error.message);
      return { status: 200, body: { ok: true, act: act.value } };
    },
  };
}

export type TrustedAuthorityService = ReturnType<typeof createTrustedAuthorityService>;
