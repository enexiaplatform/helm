/**
 * Decision, commitment and governance state under a two-time lens.
 *
 * Several kernel records carry a field that moves after they are written — a
 * decision's `state`, an action intent's `status`, an assumption's `outcome`,
 * a challenge's `status`. The twin never reads those fields as history. It
 * reconstructs what they were at the knowledge boundary from the append-only
 * record that moved them:
 *
 *   decision state        the timeline: DECISION_OPENED, STATE_CHANGED, COMMITTED, RECONSIDERED
 *   action intent status  ACTION_INTENT_STATUS_CHANGED events
 *   assumption outcome    outcome reviews recorded by the boundary
 *   challenge status      resolved only if `resolvedAt` is inside the boundary
 *   governance state      evaluations, requirements and acts inside the boundary,
 *                         projected by the authority runtime's own projection
 *
 * So a snapshot of 23 September replayed in January reads what HELM knew on
 * 23 September, and nothing that was decided, approved or disproved since.
 */

import { ok, periodKey, type Result, type Scope } from '@helm/shared';
import type {
  Decision,
  DecisionAssumption,
  DecisionChallenge,
  DecisionCommitment,
  DecisionStore,
  DecisionTimelineEvent,
} from '@helm/decision-runtime';
import type { ScenarioRuntime } from '@helm/scenario-runtime';
import {
  policiesInForce,
  projectGovernanceState,
  type AuthorityRuntime,
  type AuthorityStore,
} from '@helm/authority-runtime';
import { sensitivityOfMetric } from './sensitivity.ts';
import type { CompletenessReason, KernelRef, TwinItem, TwinLens } from './types.ts';
import type { StructureView } from './structure.ts';

const ms = (t: string | null | undefined): number => (t ? Date.parse(t) : NaN);
const known = (t: string | null | undefined, T: number): boolean => t !== null && t !== undefined && ms(t) <= T;
const ref = (kind: KernelRef['kind'], id: string, pin: string | null = null, label: string | null = null): KernelRef => ({ kind, id, pin, label });

export const OPEN_DECISION_STATES = ['DRAFT', 'INVESTIGATING', 'MODELLING', 'READY_FOR_DECISION'] as const;

export type ManagementSources = {
  readonly decisions: DecisionStore;
  readonly scenarios: ScenarioRuntime;
  readonly authority: AuthorityRuntime;
  readonly authorityStore: AuthorityStore;
};

export type ManagementComposition = {
  readonly items: TwinItem[];
  readonly reasons: CompletenessReason[];
  readonly sourceRefs: KernelRef[];
};

/** Decision state as of T, from the timeline alone. */
export function decisionStateAt(events: readonly DecisionTimelineEvent[], T: number): string | null {
  let state: string | null = null;
  for (const e of [...events].sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt) || a.id.localeCompare(b.id))) {
    if (ms(e.recordedAt) > T) break;
    if (e.eventType === 'DECISION_OPENED') state = 'DRAFT';
    else if (e.eventType === 'STATE_CHANGED' && typeof e.payload.to === 'string') state = e.payload.to;
    else if (e.eventType === 'COMMITTED' || e.eventType === 'RECONSIDERED') state = 'COMMITTED';
  }
  return state;
}

function challengeStatusAt(c: DecisionChallenge, T: number): DecisionChallenge['status'] {
  return c.status !== 'OPEN' && known(c.resolvedAt, T) ? c.status : 'OPEN';
}

type Options = {
  readonly lens: TwinLens;
  readonly view: StructureView;
  readonly enterprise: boolean;
  /** COMMITTED_FUTURE: only this decision. */
  readonly onlyDecisionId: string | null;
  /** Whether to include the committed-future expected values of each commitment. */
  readonly expectedValues: boolean;
};

export async function composeManagement(
  sources: ManagementSources,
  scope: Scope,
  opts: Options,
): Promise<Result<ManagementComposition>> {
  const { lens, view } = opts;
  const E = ms(lens.effectiveAsOf);
  // Decisions, commitments, evaluations and approvals are ACTS: they exist from the
  // moment they are done, which is also when they are recorded. So they must fall
  // inside BOTH lenses — an approval given on 24 Sep is not part of 23 Sep, however
  // late the knowledge boundary is set.
  const T = Math.min(ms(lens.recordedThrough), E);
  const recordedThrough = new Date(T).toISOString();
  const items: TwinItem[] = [];
  const reasons: CompletenessReason[] = [];
  const sourceRefs: KernelRef[] = [];

  // ------------------------------------------------------------ governance structure
  const [policies, rules, occupancies, delegations] = await Promise.all([
    sources.authority.listPolicies(scope),
    sources.authority.listRules(scope),
    sources.authority.listOccupancies(scope),
    sources.authority.listDelegations(scope),
  ]);
  if (!policies.ok) return policies;
  if (!rules.ok) return rules;
  if (!occupancies.ok) return occupancies;
  if (!delegations.ok) return delegations;

  const Tknow = ms(lens.recordedThrough);
  for (const p of policiesInForce(policies.value, lens.effectiveAsOf, lens.recordedThrough)) {
    const ruleKeys = rules.value.filter((r) => r.policyId === p.id).map((r) => r.key).sort();
    items.push({
      key: `policy:${p.key}`,
      kind: 'POLICY',
      categories: ['GOVERNANCE'],
      label: `${p.title} (${p.reference} v${p.version})`,
      subjectEntityId: null,
      layer: null,
      status: 'KNOWN',
      state: { key: p.key, version: p.version, reference: p.reference, title: p.title, demo: p.demo, validFrom: p.validFrom, validTo: p.validTo, ruleKeys },
      refs: [ref('POLICY', p.id, `v${p.version}`, p.reference), ...rules.value.filter((r) => r.policyId === p.id).map((r) => ref('RULE', r.id, null, r.key))],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
    sourceRefs.push(ref('POLICY', p.id, `v${p.version}`, p.reference));
  }

  for (const o of occupancies.value) {
    if (!known(o.recordedAt, Tknow)) continue;
    // The recorded end applies only if HELM knew of it by the boundary.
    const validTo = o.validTo !== null && (o.endedAt === null || known(o.endedAt, Tknow)) ? o.validTo : null;
    if (ms(o.validFrom) > E || (validTo !== null && ms(validTo) <= E)) continue;
    if (!opts.enterprise && !view.inScope.has(o.roleId)) continue;
    items.push({
      key: `occupancy:${o.roleId}:${o.kind}`,
      kind: 'ROLE_OCCUPANCY',
      categories: ['STRUCTURE', 'GOVERNANCE'],
      label: `${o.roleLabel}: ${o.personLabel}${o.kind === 'ACTING' ? ' (acting)' : ''}`,
      subjectEntityId: o.roleId,
      layer: null,
      status: 'KNOWN',
      state: { roleId: o.roleId, roleLabel: o.roleLabel, holderUserId: o.userId, personLabel: o.personLabel, kind: o.kind, validFrom: o.validFrom, validTo },
      refs: [ref('OCCUPANCY', o.id, o.recordedAt, o.personLabel), ref('ENTITY', o.roleId, null, o.roleLabel)],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
  }

  for (const d of delegations.value) {
    if (!known(d.recordedAt, Tknow)) continue;
    if (d.revokedAt !== null && known(d.revokedAt, Math.min(Tknow, E))) continue;
    if (ms(d.validFrom) > E || ms(d.validTo) <= E) continue;
    items.push({
      key: `delegation:${d.id}`,
      kind: 'DELEGATION',
      categories: ['GOVERNANCE'],
      label: `${d.delegatorRoleLabel} authority delegated to ${d.delegateLabel}`,
      subjectEntityId: d.delegatorRoleId,
      layer: null,
      status: 'KNOWN',
      state: {
        delegatorLabel: d.delegatorLabel,
        delegatorRoleLabel: d.delegatorRoleLabel,
        delegateLabel: d.delegateLabel,
        decisionTypes: [...d.decisionTypes].sort(),
        acts: [...d.acts].sort(),
        validFrom: d.validFrom,
        validTo: d.validTo,
        reason: d.reason,
      },
      refs: [ref('DELEGATION', d.id, d.recordedAt, d.delegateLabel)],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
  }

  // ------------------------------------------------------------------- decisions
  const decisions = await sources.decisions.listDecisions(scope);
  if (!decisions.ok) return decisions;
  const futureCompleteness = new Map<string, string | null>();
  const completenessOf = async (runId: string): Promise<string | null> => {
    if (!futureCompleteness.has(runId)) {
      const f = await sources.scenarios.getFutureState(scope, runId);
      futureCompleteness.set(runId, f.ok ? f.value.completeness : null);
    }
    return futureCompleteness.get(runId)!;
  };

  for (const decision of [...decisions.value].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!known(decision.createdAt, T)) continue;
    if (opts.onlyDecisionId && decision.id !== opts.onlyDecisionId) continue;
    const events = await sources.decisions.listEvents(scope, decision.id);
    if (!events.ok) return events;
    const state = decisionStateAt(events.value, T);
    if (state === null) continue;
    const revisions = await sources.decisions.listRevisions(scope, decision.id);
    if (!revisions.ok) return revisions;
    const revs = revisions.value.filter((r) => known(r.createdAt, T)).sort((a, b) => a.revisionNumber - b.revisionNumber);
    const revision = revs[revs.length - 1];
    if (!revision) continue;
    const alternatives = await sources.decisions.listAlternatives(scope, revision.id);
    if (!alternatives.ok) return alternatives;
    const alts = alternatives.value.filter((a) => known(a.createdAt, T));
    const commitments = await sources.decisions.listCommitments(scope, decision.id);
    if (!commitments.ok) return commitments;
    const committed = commitments.value.filter((c) => known(c.committedAt, T)).sort((a, b) => ms(a.committedAt) - ms(b.committedAt));
    const commitment: DecisionCommitment | null = committed[committed.length - 1] ?? null;

    // --- in scope? the entities its futures and its governance touch ---
    if (!opts.enterprise && !opts.onlyDecisionId) {
      const touched = new Set<string>();
      for (const a of alts) {
        if (!a.scenarioRevisionId) continue;
        const overrides = await sources.scenarios.listOverrides(scope, a.scenarioRevisionId);
        if (overrides.ok) for (const o of overrides.value) if (o.subjectEntityId) touched.add(o.subjectEntityId);
      }
      const profiles = await sources.authorityStore.listProfiles(scope, decision.id);
      if (profiles.ok) for (const p of profiles.value) if (known(p.declaredAt, T)) for (const s of p.declaredSubjects) touched.add(s.entityId);
      if (commitment) {
        const evals = await sources.authority.listEvaluations(scope, { commitmentId: commitment.id });
        if (evals.ok) for (const e of evals.value) if (known(e.evaluatedAt, T)) for (const t of e.scope.touched) touched.add(t.entityId);
      }
      if (![...touched].some((id) => view.inScope.get(id) === 'CORE')) continue;
    }

    const lastEvent = events.value.filter((e) => known(e.recordedAt, T)).sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt)).pop();
    const alternativeStates = [];
    for (const a of alts.sort((x, y) => x.sort - y.sort || x.id.localeCompare(y.id))) {
      alternativeStates.push({
        label: a.label,
        status: a.status,
        scenarioRunId: a.scenarioRunId,
        completeness: a.scenarioRunId ? await completenessOf(a.scenarioRunId) : null,
      });
    }
    items.push({
      key: `decision:${decision.id}`,
      kind: 'DECISION',
      categories: ['DECISIONS'],
      label: decision.title,
      subjectEntityId: null,
      layer: null,
      status: 'KNOWN',
      state: {
        title: decision.title,
        managementQuestion: decision.managementQuestion,
        state,
        open: (OPEN_DECISION_STATES as readonly string[]).includes(state),
        revisionNumber: revision.revisionNumber,
        reconsidered: revs.some((r) => r.reason === 'RECONSIDERED'),
        commitments: committed.length,
        deadline: decision.horizon.decisionDeadline,
        ownerLabel: decision.owner?.label ?? null,
        alternatives: alternativeStates,
      },
      refs: [
        ref('DECISION', decision.id, null, decision.title),
        ref('DECISION_REVISION', revision.id, `r${revision.revisionNumber}`),
        ...(lastEvent ? [ref('DECISION_EVENT', lastEvent.id, lastEvent.recordedAt, lastEvent.eventType)] : []),
      ],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });

    // --- assumptions and challenges of the revision in force at the boundary ---
    const [assumptions, challenges, reviews] = await Promise.all([
      sources.decisions.listAssumptions(scope, revision.id),
      sources.decisions.listChallenges(scope, revision.id),
      sources.decisions.listOutcomeReviews(scope, decision.id),
    ]);
    if (!assumptions.ok) return assumptions;
    if (!challenges.ok) return challenges;
    if (!reviews.ok) return reviews;
    const reviewsKnown = reviews.value.filter((r) => known(r.reviewedAt, T)).sort((a, b) => ms(a.reviewedAt) - ms(b.reviewedAt));
    const outcomeOf = (a: DecisionAssumption) => {
      let outcome: string = 'PENDING';
      let reviewId: string | null = null;
      let note: string | null = null;
      for (const r of reviewsKnown) {
        const hit = r.assumptionResults.find((x) => x.assumptionId === a.id);
        if (hit) {
          outcome = hit.outcome;
          reviewId = r.id;
          note = hit.note;
        }
      }
      return { outcome, reviewId, note };
    };
    const liveChallenges = challenges.value.filter((c) => known(c.raisedAt, T));
    for (const a of assumptions.value.filter((x) => known(x.createdAt, T)).sort((x, y) => x.id.localeCompare(y.id))) {
      const { outcome, reviewId, note } = outcomeOf(a);
      const open = liveChallenges.filter((c) => c.targetKind === 'ASSUMPTION' && c.targetId === a.id && challengeStatusAt(c, T) === 'OPEN');
      items.push({
        key: `assumption:${a.id}`,
        kind: 'ASSUMPTION',
        categories: ['ASSUMPTIONS'],
        label: a.statement,
        subjectEntityId: null,
        layer: null,
        status: 'KNOWN',
        state: {
          decisionId: decision.id,
          statement: a.statement,
          criticality: a.criticality,
          outcome,
          outcomeNote: note,
          challenged: open.length > 0,
          supportsCommitment: commitment !== null && commitment.revisionId === revision.id,
          ownerLabel: a.owner?.label ?? null,
          scenarioOverrideId: a.scenarioOverrideId,
        },
        refs: [
          ref('ASSUMPTION', a.id, null, a.statement.slice(0, 60)),
          ...(reviewId ? [ref('OUTCOME_REVIEW', reviewId)] : []),
          ...open.map((c) => ref('CHALLENGE', c.id)),
        ],
        sensitivity: 'GENERAL_MANAGEMENT',
        reason: null,
      });
    }
    for (const c of liveChallenges.sort((x, y) => x.id.localeCompare(y.id))) {
      items.push({
        key: `challenge:${c.id}`,
        kind: 'CHALLENGE',
        categories: ['ASSUMPTIONS'],
        label: c.concern,
        subjectEntityId: null,
        layer: null,
        status: 'KNOWN',
        state: { decisionId: decision.id, targetKind: c.targetKind, targetId: c.targetId, concern: c.concern, status: challengeStatusAt(c, T), author: c.author.label },
        refs: [ref('CHALLENGE', c.id, null, c.concern.slice(0, 60))],
        sensitivity: 'GENERAL_MANAGEMENT',
        reason: null,
      });
    }

    if (!commitment) continue;

    // --- the commitment: intent, not reality ---
    const snapshot = await sources.decisions.getSnapshot(scope, commitment.snapshotId);
    if (!snapshot.ok) return snapshot;
    const chosen = snapshot.value?.alternatives.find((a) => a.chosen) ?? null;
    items.push({
      key: `commitment:${decision.id}`,
      kind: 'COMMITMENT',
      categories: ['COMMITMENTS', 'DECISIONS'],
      label: `${decision.title}: ${chosen?.label ?? 'chosen alternative'}`,
      subjectEntityId: null,
      layer: null,
      status: 'KNOWN',
      state: {
        commitmentId: commitment.id,
        fingerprint: commitment.fingerprint,
        chosenAlternative: chosen?.label ?? null,
        chosenScenarioRunId: chosen?.scenarioRunId ?? null,
        committedByLabel: commitment.committedByLabel,
        committedAt: commitment.committedAt,
        summary: commitment.summary,
        horizon: decision.horizon.expectedOutcomeHorizon,
        expectedOutcomes: commitment.expectedOutcomes.map((e) => ({ label: e.label, metricKey: e.metricKey, nodeId: e.nodeId, period: e.period ? periodKey(e.period) : null })),
        reconsideration: revision.reason === 'RECONSIDERED' && revision.id === commitment.revisionId,
        authorityStatusOnCommitment: commitment.authorityStatus,
      },
      refs: [
        ref('COMMITMENT', commitment.id, commitment.fingerprint, decision.title),
        ...(snapshot.value ? [ref('COMMITMENT_SNAPSHOT', snapshot.value.id, snapshot.value.fingerprint)] : []),
        ...(chosen?.scenarioRunId ? [ref('SCENARIO_RUN', chosen.scenarioRunId, chosen.scenarioFingerprint, chosen.label)] : []),
      ],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
    sourceRefs.push(ref('COMMITMENT', commitment.id, commitment.fingerprint));

    // The committed future's expected values, exactly as frozen in the commitment.
    if (opts.expectedValues) {
      for (const e of commitment.expectedOutcomes) {
        if (e.kind !== 'MODELLED' || !e.nodeId || !e.metricKey) continue;
        const period = e.period ? periodKey(e.period) : null;
        items.push({
          key: `value:${e.nodeId}:COMMITTED_FUTURE${period ? `:${period}` : ''}:${decision.id}`,
          kind: 'VALUE',
          categories: ['VALUE', 'COMMITMENTS'],
          label: `${e.label} — committed future`,
          subjectEntityId: null,
          layer: 'COMMITTED_FUTURE',
          status: e.expectedValue === null ? 'UNAVAILABLE' : 'KNOWN',
          state: {
            nodeId: e.nodeId,
            metricKey: e.metricKey,
            value: e.expectedValue,
            unit: e.unit,
            currency: e.currency,
            period,
            periodEnd: e.period?.end ?? null,
            commitmentId: commitment.id,
            decisionId: decision.id,
            scenarioRunId: chosen?.scenarioRunId ?? null,
            expectedOutcome: true,
          },
          refs: [ref('COMMITMENT', commitment.id, commitment.fingerprint), ...(chosen?.scenarioRunId ? [ref('SCENARIO_RUN', chosen.scenarioRunId, chosen.scenarioFingerprint)] : []), ref('VALUE_NODE', e.nodeId)],
          sensitivity: sensitivityOfMetric(e.metricKey),
          reason: e.expectedValue === null ? 'the committed future did not compute this outcome' : null,
        });
      }
    }

    // --- action intents, their status as of the boundary ---
    const intents = await sources.decisions.listActionIntents(scope, commitment.id);
    if (!intents.ok) return intents;
    for (const intent of intents.value.filter((i) => known(i.createdAt, T)).sort((a, b) => a.id.localeCompare(b.id))) {
      const moves = events.value
        .filter((ev) => ev.eventType === 'ACTION_INTENT_STATUS_CHANGED' && ev.payload.actionIntentId === intent.id && known(ev.recordedAt, T))
        .sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt));
      const status = moves.length > 0 ? String(moves[moves.length - 1].payload.to) : 'INTENDED';
      items.push({
        key: `intent:${intent.id}`,
        kind: 'ACTION_INTENT',
        categories: ['COMMITMENTS'],
        label: intent.title,
        subjectEntityId: null,
        layer: null,
        status: 'KNOWN',
        state: { decisionId: decision.id, commitmentId: commitment.id, title: intent.title, ownerLabel: intent.ownerLabel, dueDate: intent.dueDate, status, targetSystem: intent.targetSystem },
        refs: [ref('ACTION_INTENT', intent.id, status, intent.title), ...moves.map((m) => ref('DECISION_EVENT', m.id, m.recordedAt, 'ACTION_INTENT_STATUS_CHANGED'))],
        sensitivity: 'GENERAL_MANAGEMENT',
        reason: null,
      });
    }

    // --- governance: consumed from the authority runtime's projection ---
    const [evaluations, requirements, acts] = await Promise.all([
      sources.authority.listEvaluations(scope, { commitmentId: commitment.id }),
      sources.authorityStore.listRequiredApprovals(scope, { commitmentId: commitment.id }),
      sources.authority.listApprovalActs(scope, { commitmentId: commitment.id }),
    ]);
    if (!evaluations.ok) return evaluations;
    if (!requirements.ok) return requirements;
    if (!acts.ok) return acts;
    const g = projectGovernanceState({
      commitmentId: commitment.id,
      commitmentFingerprint: commitment.fingerprint,
      evaluations: evaluations.value.filter((e) => known(e.evaluatedAt, T)),
      requirements: requirements.value.filter((r) => known(r.createdAt, T)),
      acts: acts.value.filter((a) => known(a.actedAt, T)),
      now: recordedThrough,
    });
    const e = g.evaluation;
    const pending = g.requirements.filter((r) => !r.satisfied).map((r) => r.requirement.roleLabel);
    const governanceKey = `governance:${decision.id}`;
    items.push({
      key: governanceKey,
      kind: 'GOVERNANCE',
      categories: ['GOVERNANCE', 'COMMITMENTS'],
      label: `Governance of ${decision.title}`,
      subjectEntityId: null,
      layer: null,
      status: 'KNOWN',
      state: {
        commitmentId: commitment.id,
        state: g.state,
        policyResult: g.policyResult,
        approvalProgress: g.approvalProgress,
        evaluationId: e?.id ?? null,
        evaluator: e?.evaluator.kind ?? null,
        consequenceCheck: e?.evaluator.consequenceCheck.status ?? null,
        policies: e ? e.policies.map((p) => `${p.reference} v${p.version}`).sort() : [],
        actor: e?.actorLabel ?? null,
        pending,
        acted: g.requirements.flatMap((r) => r.acts.map((a) => ({ role: r.requirement.roleLabel, approver: a.approverLabel, decision: a.decision, actedAt: a.actedAt }))),
        gaps: e ? e.gaps.map((x) => x.code).sort() : [],
        statement: g.statement,
      },
      refs: [
        ...(e ? [ref('EVALUATION', e.id, e.fingerprint, e.result)] : []),
        ...g.requirements.map((r) => ref('REQUIRED_APPROVAL', r.requirement.id, null, r.requirement.roleLabel)),
        ...g.requirements.flatMap((r) => r.acts.map((a) => ref('APPROVAL_ACT', a.id, a.actedAt, a.decision))),
        ...(e ? e.policies.map((p) => ref('POLICY', p.policyId, `v${p.version}`, p.reference)) : []),
      ],
      sensitivity: 'GENERAL_MANAGEMENT',
      reason: null,
    });
    if (!e) {
      reasons.push({ code: 'AUTHORITY_NOT_EVALUATED', severity: 'DEGRADED', message: `No authority evaluation of "${decision.title}" was recorded by ${recordedThrough}.`, itemKey: governanceKey });
    } else {
      if (e.evaluator.kind !== 'TRUSTED_SERVICE') {
        reasons.push({
          code: 'AUTHORITY_VERDICT_UNTRUSTED',
          severity: 'DEGRADED',
          message: `The authority verdict on "${decision.title}" was computed by a client runtime, not the trusted authority service; it is shown, not relied on.`,
          itemKey: governanceKey,
        });
      }
      if (g.policyResult === 'INDETERMINATE') {
        reasons.push({ code: 'AUTHORITY_INDETERMINATE', severity: 'DEGRADED', message: `Authority over "${decision.title}" could not be determined: ${e.gaps.map((x) => x.message).join('; ')}`, itemKey: governanceKey });
      }
    }
  }

  return ok({ items, reasons, sourceRefs });
}

export type { Decision };
