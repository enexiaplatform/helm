/**
 * The Decision Runtime (ADR-0021).
 *
 *   management question → alternatives → scenario futures → criteria →
 *   evidence & assumptions → challenges → readiness → COMMITMENT → frozen
 *   snapshot → action intents → outcome review
 *
 * There is no decision calculator here, and no second value model. Every
 * number a decision shows is read from a scenario future state the Phase 4
 * runtime produced with the Phase 3 engine. What this runtime adds is the
 * management layer around those numbers: what was being decided, what
 * mattered, what was believed, who disagreed, what was given up, and what was
 * chosen.
 *
 * Four properties it protects:
 *
 *   NO CHOOSING       it evaluates criteria, states trade-offs and can report
 *                     factual dominance; it never ranks, scores or recommends.
 *   IMMUTABILITY      a commitment and its evidence manifest are frozen at the
 *                     moment they are made. New evidence, a new forecast and a
 *                     rebased scenario all leave them untouched.
 *   TRACEABILITY      "why did management choose this?" resolves through the
 *                     rationale and the criteria into scenario lineage, and
 *                     from there into calculations and source observations.
 *   HONESTY           an unmodelled alternative says so; an unevaluable
 *                     criterion says why; an unowned assumption is a gap. None
 *                     of them is filled in with a plausible number.
 *
 * Authority is NOT here. Phase 5 records that management committed; whether
 * the actor was allowed to is Phase 6's question, and `authorityStatus` is
 * written once, as NOT_EVALUATED.
 */

import {
  abs,
  decimal,
  fail,
  ok,
  subtract,
  toString as decToString,
  type Clock,
  type Result,
  type Scope,
} from '@helm/shared';
import { canonicalNumeric } from '@helm/propagation-engine';
import type {
  Completeness,
  FutureState,
  ScenarioComparison,
  ScenarioExplanation,
  ScenarioRun,
  ScenarioRuntime,
} from '@helm/scenario-runtime';
import { snapshotFingerprint, commitmentFingerprint } from './fingerprint.ts';
import { evaluateCriteria, weightedView, type AlternativeState } from './criteria.ts';
import { buildTradeOffSpace } from './tradeoff.ts';
import { evaluateReadiness } from './readiness.ts';
import {
  DecisionErrors,
  type CommitmentSnapshot,
  type CriterionAssessment,
  type CriterionEvaluation,
  type DecisionAlternative,
  type DecisionAssumption,
  type DecisionChallenge,
  type DecisionCommittedEvent,
  type DecisionCriterion,
  type DecisionEvidence,
  type DecisionExplanation,
  type ExpectedOutcome,
  type ManagementWeighting,
  type OutcomeVariance,
  type ReadinessReport,
  type TradeOffSpace,
  type WeightedView,
} from './types.ts';
import type {
  AddAlternativeInput,
  AddAssumptionInput,
  AddCriterionInput,
  AddEvidenceInput,
  ChallengeInput,
  CommitInput,
  CreateDecisionInput,
  DecisionRuntime,
  DecisionStore,
  DecisionWorkspace,
  ReconsiderInput,
} from './port.ts';

export const DECISION_STATEMENT =
  'HELM records what management decided and everything it knew when it decided. It computes ' +
  'what each alternative does to the enterprise, states how each stands against management\'s ' +
  'own criteria, and names the trade-offs. It does not rank the alternatives, score them, or ' +
  'recommend one.';

export type DecisionRuntimeOptions = {
  store: DecisionStore;
  scenarios: ScenarioRuntime;
  clock: Clock;
};

/** Everything one decision revision is made of, read in one go. */
type RevisionParts = {
  alternatives: readonly DecisionAlternative[];
  criteria: readonly DecisionCriterion[];
  assessments: readonly CriterionAssessment[];
  assumptions: readonly DecisionAssumption[];
  challenges: readonly DecisionChallenge[];
  evidence: readonly DecisionEvidence[];
  weighting: ManagementWeighting | null;
};

type Loaded = {
  parts: RevisionParts;
  states: readonly AlternativeState[];
  evaluations: readonly CriterionEvaluation[];
};

const str = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : canonicalNumeric(String(v));

export function createDecisionRuntime(opts: DecisionRuntimeOptions): DecisionRuntime {
  const { store, scenarios, clock } = opts;
  const now = () => clock.now().toISOString();

  const event = async (
    scope: Scope,
    decisionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await store.appendEvent(scope, { decisionId, eventType, actorId: scope.actorId ?? null, payload });
  };

  /** Reads each alternative's future state. A missing or unbound one is null, never faked. */
  const alternativeStates = async (
    scope: Scope,
    alternatives: readonly DecisionAlternative[],
  ): Promise<AlternativeState[]> => {
    const out: AlternativeState[] = [];
    for (const alternative of alternatives) {
      if (alternative.status !== 'MODELLED' || !alternative.scenarioRunId) {
        out.push({ alternative, state: null });
        continue;
      }
      const s = await scenarios.getFutureState(scope, alternative.scenarioRunId);
      out.push({ alternative, state: s.ok ? s.value : null });
    }
    return out;
  };

  const comparisonFor = async (
    scope: Scope,
    states: readonly AlternativeState[],
  ): Promise<ScenarioComparison | null> => {
    const runs = states.map((s) => s.state?.run.id).filter((id): id is string => Boolean(id));
    if (runs.length < 2) return null;
    // The first modelled alternative stands in for "the baseline" here: a
    // decision compares options with one another, not with doing nothing —
    // unless one of the options IS doing nothing, in which case it is an
    // alternative like any other.
    const c = await scenarios.compare(scope, { baselineRunId: runs[0], alternativeRunIds: runs.slice(1) });
    return c.ok ? c.value : null;
  };

  const loadRevisionParts = async (scope: Scope, revisionId: string): Promise<Result<RevisionParts>> => {
    const alternatives = await store.listAlternatives(scope, revisionId);
    if (!alternatives.ok) return alternatives;
    const criteria = await store.listCriteria(scope, revisionId);
    if (!criteria.ok) return criteria;
    const assessments = await store.listAssessments(scope, revisionId);
    if (!assessments.ok) return assessments;
    const assumptions = await store.listAssumptions(scope, revisionId);
    if (!assumptions.ok) return assumptions;
    const challenges = await store.listChallenges(scope, revisionId);
    if (!challenges.ok) return challenges;
    const evidence = await store.listEvidence(scope, revisionId);
    if (!evidence.ok) return evidence;
    const weighting = await store.getWeighting(scope, revisionId);
    if (!weighting.ok) return weighting;
    return ok({
      alternatives: alternatives.value,
      criteria: criteria.value,
      assessments: assessments.value,
      assumptions: assumptions.value,
      challenges: challenges.value,
      evidence: evidence.value,
      weighting: weighting.value,
    });
  };

  const completenessOf = (state: FutureState): Completeness => state.completeness;

  const evaluationsFor = async (scope: Scope, revisionId: string): Promise<Result<Loaded>> => {
    const parts = await loadRevisionParts(scope, revisionId);
    if (!parts.ok) return parts;
    const states = await alternativeStates(scope, parts.value.alternatives);
    return ok({
      parts: parts.value,
      states,
      evaluations: evaluateCriteria(parts.value.criteria, states, parts.value.assessments),
    });
  };

  // ------------------------------------------------------------------ API
  return {
    async createDecision(scope, input: CreateDecisionInput) {
      if (input.managementQuestion.trim().length < 12) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          'A decision needs a management question, not a label: "How should we fulfil the Rohto order given constrained SKU-X inventory?", not "Inventory".',
        );
      }
      const at = now();
      const fork = {
        effectiveAsOf: input.fork?.effectiveAsOf ?? at,
        recordedThrough: input.fork?.recordedThrough ?? at,
        policy: input.fork?.policy ?? ('SOURCE_TRUTH' as const),
      };
      if (new Date(fork.recordedThrough).getTime() > new Date(at).getTime()) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          'recordedThrough cannot be in the future: a decision may only rest on what was known.',
        );
      }
      const created = await store.createDecision(scope, {
        title: input.title,
        managementQuestion: input.managementQuestion.trim(),
        context: input.context ?? '',
        problem: input.problem ?? '',
        scope: input.scope ?? '',
        triggerType: input.triggerType,
        triggerRefs: input.triggerRefs ?? [],
        state: 'DRAFT',
        owner: input.owner ?? null,
        fork,
        horizon: {
          decisionDeadline: input.horizon?.decisionDeadline ?? null,
          effectiveFrom: input.horizon?.effectiveFrom ?? null,
          expectedOutcomeHorizon: input.horizon?.expectedOutcomeHorizon ?? null,
          reviewDate: input.horizon?.reviewDate ?? null,
        },
        objectives: input.objectives ?? [],
        reversibility: input.reversibility ?? 'UNASSESSED',
        reversalWindowDays: input.reversalWindowDays ?? null,
        authorityStatus: 'NOT_EVALUATED',
        createdBy: scope.actorId ?? null,
        metadata: input.metadata ?? {},
      });
      if (!created.ok) return created;

      const revision = await store.createRevision(scope, {
        decisionId: created.value.id,
        revisionNumber: 1,
        state: 'DRAFT',
        reason: 'OPENED',
        basedOnRevisionId: null,
        reconsidersCommitmentId: null,
        reconsiderationReason: null,
        fork,
        notes: null,
        createdBy: scope.actorId ?? null,
      });
      if (!revision.ok) return revision;

      await event(scope, created.value.id, 'DECISION_OPENED', {
        managementQuestion: created.value.managementQuestion,
        triggerType: created.value.triggerType,
        revisionId: revision.value.id,
      });
      return ok({ decision: created.value, revision: revision.value });
    },

    async updateFraming(scope, decisionId, patch) {
      return store.updateDecisionFraming(scope, decisionId, patch);
    },

    async setState(scope, decisionId, state) {
      const before = await store.getDecision(scope, decisionId);
      if (!before.ok) return before;
      if (!before.value) return fail(DecisionErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
      if (state === 'COMMITTED') {
        return fail(
          DecisionErrors.INVALID_TRANSITION,
          'COMMITTED is reached by committing, not by setting a status. Use commit().',
        );
      }
      const next = await store.setDecisionState(scope, decisionId, state);
      if (!next.ok) return next;
      await event(scope, decisionId, 'STATE_CHANGED', { from: before.value.state, to: state });
      return next;
    },

    // --------------------------------------------------------- alternatives
    async addAlternative(scope, revisionId, input: AddAlternativeInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      const existing = await store.listAlternatives(scope, revisionId);
      if (!existing.ok) return existing;

      let binding: Pick<
        DecisionAlternative,
        'status' | 'scenarioId' | 'scenarioRevisionId' | 'scenarioRunId' | 'unmodelledReason'
      > = {
        status: 'UNMODELLED',
        scenarioId: null,
        scenarioRevisionId: null,
        scenarioRunId: null,
        unmodelledReason:
          input.unmodelledReason ??
          'No scenario is bound yet, so this alternative has no computed future state.',
      };
      if (input.scenarioId) {
        const bound = await resolveBinding(scope, input.scenarioId);
        if (!bound.ok) return bound;
        binding = bound.value;
      }

      const created = await store.addAlternative(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        label: input.label,
        description: input.description ?? '',
        ...binding,
        sort: input.sort ?? existing.value.length,
        createdBy: scope.actorId ?? null,
        metadata: input.metadata ?? {},
      });
      if (!created.ok) return created;
      await event(scope, revision.value.decisionId, 'ALTERNATIVE_ADDED', {
        alternativeId: created.value.id,
        label: created.value.label,
        status: created.value.status,
      });
      return created;
    },

    async bindScenario(scope, alternativeId, scenarioId, runId) {
      const bound = await resolveBinding(scope, scenarioId, runId);
      if (!bound.ok) return bound;
      const next = await store.setAlternativeBinding(scope, alternativeId, bound.value);
      if (!next.ok) return next;
      await event(scope, next.value.decisionId, 'SCENARIO_BOUND', {
        alternativeId,
        scenarioId,
        scenarioRunId: bound.value.scenarioRunId,
      });
      return next;
    },

    async withdrawAlternative(scope, alternativeId, reason) {
      const alternatives = await store.setAlternativeBinding(scope, alternativeId, {
        status: 'WITHDRAWN',
        scenarioId: null,
        scenarioRevisionId: null,
        scenarioRunId: null,
        unmodelledReason: reason,
      });
      if (!alternatives.ok) return alternatives;
      await event(scope, alternatives.value.decisionId, 'ALTERNATIVE_WITHDRAWN', { alternativeId, reason });
      return alternatives;
    },

    // ------------------------------------------------------------- criteria
    async addCriterion(scope, revisionId, input: AddCriterionInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      if ((input.style === 'HARD_CONSTRAINT' || input.style === 'TARGET') && input.threshold === undefined) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          `A ${input.style} criterion needs the line management actually stated. HELM does not invent a threshold.`,
        );
      }
      if (input.style === 'OPTIONAL_WEIGHTED' && (input.weight === undefined || input.weight === null)) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          'A weighted criterion needs management\'s own weight. There is no default weight.',
        );
      }
      if (input.rationale.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'A criterion nobody can justify is not a criterion.');
      }
      const created = await store.addCriterion(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        style: input.style,
        required: input.required ?? false,
        metricKey: input.metricKey ?? null,
        subjectHint: input.subjectHint ?? null,
        threshold: str(input.threshold ?? null),
        unit: input.unit ?? null,
        direction: input.direction ?? 'NONE',
        weight: str(input.weight ?? null),
        author: input.author,
        rationale: input.rationale,
        demoPolicy: input.demoPolicy ?? false,
        sort: input.sort ?? 0,
      });
      if (!created.ok) return created;
      await event(scope, revision.value.decisionId, 'CRITERION_ADDED', {
        criterionId: created.value.id,
        key: created.value.key,
        style: created.value.style,
      });
      return created;
    },

    async recordAssessment(scope, input) {
      const criterion = await findCriterion(scope, input.criterionId);
      if (!criterion.ok) return criterion;
      if (criterion.value.style !== 'QUALITATIVE') {
        return fail(
          DecisionErrors.INVALID_INPUT,
          `"${criterion.value.name}" is a ${criterion.value.style} criterion: it is evaluated from the model, not rated by hand.`,
        );
      }
      if (input.rationale.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'A qualitative rating needs a reason. HELM never rates one itself.');
      }
      const created = await store.recordAssessment(scope, {
        revisionId: criterion.value.revisionId,
        criterionId: input.criterionId,
        alternativeId: input.alternativeId,
        rating: input.rating,
        rationale: input.rationale,
        author: input.author,
        assessedAt: now(),
      });
      if (!created.ok) return created;
      await event(scope, criterion.value.decisionId, 'ASSESSMENT_RECORDED', {
        criterionId: input.criterionId,
        alternativeId: input.alternativeId,
        rating: input.rating,
        author: input.author.label,
      });
      return created;
    },

    async declareWeighting(scope, revisionId, input) {
      if (input.rationale.trim().length < 8 || input.method.trim().length < 8) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          'A weighting method has to be stated and justified by a person. There is no system default.',
        );
      }
      return store.declareWeighting(scope, {
        revisionId,
        method: input.method,
        rationale: input.rationale,
        author: input.author,
        declaredAt: now(),
      });
    },

    async weightedView(scope, revisionId): Promise<Result<WeightedView>> {
      const loaded = await evaluationsFor(scope, revisionId);
      if (!loaded.ok) return loaded;
      if (!loaded.value.parts.weighting) {
        return fail(
          DecisionErrors.WEIGHTING_NOT_DECLARED,
          'No weighting has been declared. HELM does not combine criteria into one number unless management states the method, the weights and why.',
        );
      }
      return ok(weightedView(loaded.value.parts.weighting, loaded.value.parts.criteria, loaded.value.states, loaded.value.evaluations));
    },

    // ---------------------------------------------------------- assumptions
    async addAssumption(scope, revisionId, input: AddAssumptionInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      if (input.statement.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'An assumption needs to state something.');
      }
      const created = await store.addAssumption(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        statement: input.statement,
        owner: input.owner ?? null,
        source: input.source ?? '',
        rationale: input.rationale ?? '',
        confidence: input.confidence ?? null,
        criticality: input.criticality ?? 'MATERIAL',
        scenarioRevisionId: input.scenarioRevisionId ?? null,
        scenarioOverrideId: input.scenarioOverrideId ?? null,
        alternativeIds: input.alternativeIds ?? [],
        outcome: 'PENDING',
        outcomeNote: null,
        createdBy: scope.actorId ?? null,
      });
      if (!created.ok) return created;
      await event(scope, revision.value.decisionId, 'ASSUMPTION_ADDED', {
        assumptionId: created.value.id,
        statement: created.value.statement,
        owner: created.value.owner?.label ?? null,
      });
      return created;
    },

    async challenge(scope, revisionId, input: ChallengeInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      if (input.concern.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'A challenge needs to say what the concern is.');
      }
      const created = await store.addChallenge(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        targetKind: input.targetKind,
        targetId: input.targetId ?? null,
        author: input.author,
        concern: input.concern,
        evidenceId: input.evidenceId ?? null,
        status: 'OPEN',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
      });
      if (!created.ok) return created;
      await event(scope, revision.value.decisionId, 'ASSUMPTION_CHALLENGED', {
        challengeId: created.value.id,
        targetKind: created.value.targetKind,
        targetId: created.value.targetId,
        author: created.value.author.label,
        concern: created.value.concern,
      });
      return created;
    },

    async resolveChallenge(scope, challengeId, outcome) {
      if (outcome.status === 'OPEN') {
        return fail(DecisionErrors.INVALID_INPUT, 'Resolving a challenge means moving it out of OPEN.');
      }
      if (outcome.resolution.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'Say how the challenge was resolved; a status alone is not a resolution.');
      }
      const resolved = await store.resolveChallenge(scope, challengeId, {
        status: outcome.status,
        resolution: outcome.resolution,
        resolvedBy: scope.actorId ?? null,
      });
      if (!resolved.ok) return resolved;
      await event(scope, resolved.value.decisionId, 'CHALLENGE_RESOLVED', {
        challengeId,
        status: outcome.status,
        resolution: outcome.resolution,
      });
      return resolved;
    },

    async addEvidence(scope, revisionId, input: AddEvidenceInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      const created = await store.addEvidence(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? '',
        relation: input.relation,
        targetKind: input.targetKind,
        targetId: input.targetId ?? null,
        sourceSystem: input.sourceSystem,
        sourceRef: input.sourceRef ?? null,
        effectiveAt: input.effectiveAt ?? null,
        recordedAt: now(),
        confidence: input.confidence ?? null,
        author: input.author ?? null,
      });
      if (!created.ok) return created;
      await event(scope, revision.value.decisionId, 'EVIDENCE_ADDED', {
        evidenceId: created.value.id,
        kind: created.value.kind,
        relation: created.value.relation,
        targetKind: created.value.targetKind,
        targetId: created.value.targetId,
      });
      return created;
    },

    // ------------------------------------------------------- the trade-offs
    async evaluateCriteria(scope, revisionId) {
      const loaded = await evaluationsFor(scope, revisionId);
      if (!loaded.ok) return loaded;
      return ok(loaded.value.evaluations);
    },

    async tradeOffSpace(scope, revisionId, referenceAlternativeId): Promise<Result<TradeOffSpace>> {
      const loaded = await evaluationsFor(scope, revisionId);
      if (!loaded.ok) return loaded;
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      const comparison = await comparisonFor(scope, loaded.value.states);
      return ok(
        buildTradeOffSpace({
          decisionId: revision.value.decisionId,
          revisionId,
          criteria: loaded.value.parts.criteria,
          alternatives: loaded.value.states,
          evaluations: loaded.value.evaluations,
          comparison,
          referenceAlternativeId: referenceAlternativeId ?? null,
          completenessOf: (a) => loaded.value.states.find((s) => s.alternative.id === a.id)?.state?.completeness ?? null,
        }),
      );
    },

    async evaluateReadiness(scope, revisionId): Promise<Result<ReadinessReport>> {
      const loaded = await evaluationsFor(scope, revisionId);
      if (!loaded.ok) return loaded;
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      const decision = await store.getDecision(scope, revision.value.decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(DecisionErrors.NOT_FOUND, 'Decision not found.');
      const report = evaluateReadiness({
        decisionId: decision.value.id,
        revisionId,
        managementQuestion: decision.value.managementQuestion,
        hasOwner: decision.value.owner !== null,
        alternatives: loaded.value.states,
        criteria: loaded.value.parts.criteria,
        assessments: loaded.value.parts.assessments,
        assumptions: loaded.value.parts.assumptions,
        challenges: loaded.value.parts.challenges,
        evidence: loaded.value.parts.evidence,
        evaluations: loaded.value.evaluations,
        completenessOf,
        now: now(),
      });
      await event(scope, decision.value.id, 'READINESS_EVALUATED', {
        state: report.state,
        gaps: report.gaps.length,
      });
      return ok(report);
    },

    // ----------------------------------------------------------- commitment
    async prepareCommitment(scope, revisionId, chosenAlternativeId) {
      return buildSnapshot(scope, revisionId, chosenAlternativeId, false);
    },

    async commit(scope, revisionId, input: CommitInput) {
      const revision = await store.getRevision(scope, revisionId);
      if (!revision.ok) return revision;
      if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
      if (revision.value.state === 'SEALED') {
        return fail(DecisionErrors.REVISION_SEALED, 'That revision is already sealed and committed.');
      }

      const loaded = await evaluationsFor(scope, revisionId);
      if (!loaded.ok) return loaded;

      const chosen = loaded.value.parts.alternatives.find((a) => a.id === input.chosenAlternativeId);
      if (!chosen) {
        return fail(DecisionErrors.NOT_FOUND, `Alternative ${input.chosenAlternativeId} is not on this revision.`);
      }
      if (chosen.status === 'WITHDRAWN') {
        return fail(DecisionErrors.INVALID_INPUT, `${chosen.label} was withdrawn; it cannot be the chosen alternative.`);
      }
      if (input.rationale.length === 0) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          'A commitment needs a rationale: why this alternative, and what was accepted by choosing it.',
        );
      }
      // Management may commit over an open challenge — but only by saying so.
      // The challenge stays OPEN in the record; what is not allowed is
      // committing as though nobody had objected.
      const openChallenges = loaded.value.parts.challenges.filter((c) => c.status === 'OPEN');
      if (openChallenges.length > 0 && input.acknowledgeOpenChallenges !== true) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          `${openChallenges.length} challenge${openChallenges.length === 1 ? ' is' : 's are'} still open: ` +
            openChallenges.map((c) => `${c.author.label} — ${c.concern}`).join('; ') +
            '. Resolve them, or commit with acknowledgeOpenChallenges so the record shows management decided over them.',
        );
      }

      const decision = await store.getDecision(scope, revision.value.decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(DecisionErrors.NOT_FOUND, 'Decision not found.');

      const readiness = evaluateReadiness({
        decisionId: revision.value.decisionId,
        revisionId,
        managementQuestion: decision.value.managementQuestion,
        hasOwner: decision.value.owner !== null,
        alternatives: loaded.value.states,
        criteria: loaded.value.parts.criteria,
        assessments: loaded.value.parts.assessments,
        assumptions: loaded.value.parts.assumptions,
        challenges: loaded.value.parts.challenges,
        evidence: loaded.value.parts.evidence,
        evaluations: loaded.value.evaluations,
        completenessOf,
        now: now(),
      });
      if (readiness.state === 'NOT_READY') {
        return fail(
          DecisionErrors.NOT_READY,
          `This decision is NOT_READY: ${readiness.gaps
            .filter((g) => g.severity === 'BLOCKING')
            .map((g) => g.message)
            .join(' ')}`,
        );
      }

      const snapshot = await buildSnapshot(scope, revisionId, input.chosenAlternativeId, true);
      if (!snapshot.ok) return snapshot;

      const expected = await resolveExpectedOutcomes(scope, chosen, input.expectedOutcomes ?? []);
      if (!expected.ok) return expected;

      const committedAt = now();
      const fingerprint = commitmentFingerprint({
        orgId: scope.orgId,
        decisionId: revision.value.decisionId,
        revisionId,
        snapshotFingerprint: snapshot.value.fingerprint,
        chosenAlternativeId: input.chosenAlternativeId,
        authorship: input.authorship,
        rationale: input.rationale,
        acceptedTradeOffs: input.acceptedTradeOffs,
        expectedOutcomes: expected.value,
        reviewTriggers: input.reviewTriggers ?? [],
      });

      const commitment = await store.createCommitment(scope, {
        decisionId: revision.value.decisionId,
        revisionId,
        chosenAlternativeId: input.chosenAlternativeId,
        authorship: input.authorship,
        committedBy: scope.actorId ?? null,
        committedByLabel: input.committedByLabel,
        committedAt,
        summary: input.summary,
        rationale: input.rationale,
        acceptedTradeOffs: input.acceptedTradeOffs,
        expectedOutcomes: expected.value,
        reviewTriggers: input.reviewTriggers ?? [],
        authorityStatus: 'NOT_EVALUATED',
        fingerprint,
        snapshotId: snapshot.value.id,
      });
      if (!commitment.ok) return commitment;

      const sealed = await store.sealRevision(scope, revisionId);
      if (!sealed.ok) return sealed;
      const moved = await store.setDecisionState(scope, revision.value.decisionId, 'COMMITTED');
      if (!moved.ok) return moved;

      for (const intent of input.actionIntents ?? []) {
        const added = await store.addActionIntent(scope, {
          decisionId: revision.value.decisionId,
          commitmentId: commitment.value.id,
          title: intent.title,
          detail: intent.detail ?? '',
          ownerLabel: intent.ownerLabel,
          ownerUserId: intent.ownerUserId ?? null,
          dueDate: intent.dueDate ?? null,
          status: 'INTENDED',
          targetSystem: intent.targetSystem,
          handoffRef: null,
        });
        if (!added.ok) return added;
        await event(scope, revision.value.decisionId, 'ACTION_INTENT_ADDED', {
          actionIntentId: added.value.id,
          title: added.value.title,
          targetSystem: added.value.targetSystem,
        });
      }

      await event(scope, revision.value.decisionId, 'REVISION_SEALED', { revisionId });
      await event(scope, revision.value.decisionId, 'COMMITTED', {
        commitmentId: commitment.value.id,
        chosenAlternativeId: input.chosenAlternativeId,
        chosenLabel: chosen.label,
        authorship: input.authorship,
        committedByLabel: input.committedByLabel,
        fingerprint,
        openChallenges: openChallenges.map((c) => c.id),
        readinessAtCommitment: readiness.state,
      });

      return ok({ commitment: commitment.value, snapshot: snapshot.value });
    },

    async reconsider(scope, decisionId, input: ReconsiderInput) {
      const commitments = await store.listCommitments(scope, decisionId);
      if (!commitments.ok) return commitments;
      if (commitments.value.length === 0) {
        return fail(DecisionErrors.NOT_COMMITTED, 'Nothing has been committed yet, so there is nothing to reconsider.');
      }
      if (input.reason.trim().length < 8) {
        return fail(DecisionErrors.INVALID_INPUT, 'Reconsidering needs a reason: what changed?');
      }
      const last = commitments.value[commitments.value.length - 1];
      const previous = await store.getRevision(scope, last.revisionId);
      if (!previous.ok) return previous;
      if (!previous.value) return fail(DecisionErrors.NOT_FOUND, 'The committed revision could not be read.');

      const at = now();
      const fork = {
        effectiveAsOf: input.fork?.effectiveAsOf ?? previous.value.fork.effectiveAsOf,
        recordedThrough: input.fork?.recordedThrough ?? at,
        policy: input.fork?.policy ?? previous.value.fork.policy,
      };

      const created = await store.createRevision(scope, {
        decisionId,
        revisionNumber: previous.value.revisionNumber + 1,
        state: 'DRAFT',
        reason: 'RECONSIDERED',
        basedOnRevisionId: previous.value.id,
        reconsidersCommitmentId: last.id,
        reconsiderationReason: input.reason,
        fork,
        notes: null,
        createdBy: scope.actorId ?? null,
      });
      if (!created.ok) return created;

      // Carry the framing forward: the alternatives, criteria and assumptions
      // are copied to the NEW revision. The committed ones are untouched.
      const parts = await loadRevisionParts(scope, previous.value.id);
      if (!parts.ok) return parts;

      const idMap = new Map<string, string>();
      for (const a of parts.value.alternatives) {
        let binding: Pick<
          DecisionAlternative,
          'status' | 'scenarioId' | 'scenarioRevisionId' | 'scenarioRunId' | 'unmodelledReason'
        > = {
          status: a.status,
          scenarioId: a.scenarioId,
          scenarioRevisionId: a.scenarioRevisionId,
          scenarioRunId: a.scenarioRunId,
          unmodelledReason: a.unmodelledReason,
        };
        if (input.rebaseScenarios && a.scenarioId) {
          const rebased = await scenarios.rebase(scope, a.scenarioId, fork);
          if (!rebased.ok) return rebased;
          // A rebased revision has not been simulated yet: the alternative is
          // honestly UNMODELLED until someone runs it.
          binding = {
            status: 'UNMODELLED',
            scenarioId: a.scenarioId,
            scenarioRevisionId: rebased.value.id,
            scenarioRunId: null,
            unmodelledReason:
              `Rebased onto the knowledge boundary of ${fork.recordedThrough} and not yet simulated. ` +
              'The committed future remains exactly as it was.',
          };
        }
        const copy = await store.addAlternative(scope, {
          decisionId,
          revisionId: created.value.id,
          label: a.label,
          description: a.description,
          ...binding,
          sort: a.sort,
          createdBy: scope.actorId ?? null,
          metadata: a.metadata,
        });
        if (!copy.ok) return copy;
        idMap.set(a.id, copy.value.id);
      }
      for (const c of parts.value.criteria) {
        const copy = await store.addCriterion(scope, { ...c, revisionId: created.value.id, id: undefined } as never);
        if (!copy.ok) return copy;
        idMap.set(c.id, copy.value.id);
      }
      for (const a of parts.value.assumptions) {
        const copy = await store.addAssumption(scope, {
          ...a,
          revisionId: created.value.id,
          alternativeIds: a.alternativeIds.map((x) => idMap.get(x) ?? x),
          outcome: 'PENDING',
          outcomeNote: null,
          id: undefined,
        } as never);
        if (!copy.ok) return copy;
      }

      await store.setDecisionState(scope, decisionId, 'COMMITTED');
      await event(scope, decisionId, 'RECONSIDERED', {
        revisionId: created.value.id,
        reconsidersCommitmentId: last.id,
        reason: input.reason,
        rebased: input.rebaseScenarios === true,
        recordedThrough: fork.recordedThrough,
      });
      return created;
    },

    // -------------------------------------------------------- outcome review
    async recordOutcomeReview(scope, commitmentId, input) {
      const commitment = await store.getCommitment(scope, commitmentId);
      if (!commitment.ok) return commitment;
      if (!commitment.value) return fail(DecisionErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);

      const variances: OutcomeVariance[] = [];
      for (const actual of input.actuals) {
        const expected =
          commitment.value.expectedOutcomes.find(
            (e) => e.label === actual.label || (actual.metricKey && e.metricKey === actual.metricKey),
          ) ?? null;
        const variance =
          expected?.expectedValue && actual.actual
            ? canonicalNumeric(decToString(subtract(decimal(actual.actual), decimal(expected.expectedValue))))
            : null;
        variances.push({
          label: actual.label,
          metricKey: actual.metricKey ?? expected?.metricKey ?? null,
          nodeId: expected?.nodeId ?? null,
          expected: expected?.expectedValue ?? null,
          actual: actual.actual,
          variance,
          unit: expected?.unit ?? null,
          currency: expected?.currency ?? null,
          note: actual.note ?? (expected ? null : 'no expected value was recorded for this'),
        });
      }

      const assumptionResults = [];
      for (const r of input.assumptionResults ?? []) {
        const updated = await store.setAssumptionOutcome(scope, r.assumptionId, r.outcome, r.note ?? null);
        if (!updated.ok) return updated;
        assumptionResults.push({
          assumptionId: r.assumptionId,
          statement: updated.value.statement,
          outcome: r.outcome,
          evidenceId: r.evidenceId ?? null,
          note: r.note ?? null,
        });
      }

      const review = await store.recordOutcomeReview(scope, {
        decisionId: commitment.value.decisionId,
        commitmentId,
        reviewedAt: now(),
        reviewedByLabel: input.reviewedByLabel,
        variances,
        assumptionResults,
        notes: input.notes ?? '',
        statement:
          'Expected against actual, and how the assumptions turned out. This is not a verdict on the ' +
          'decision: a well-reasoned decision can produce a poor outcome, and a careless one can get ' +
          'lucky. HELM keeps the two apart.',
      });
      if (!review.ok) return review;
      await event(scope, commitment.value.decisionId, 'OUTCOME_REVIEWED', {
        commitmentId,
        variances: variances.length,
        assumptionResults: assumptionResults.length,
      });
      return review;
    },

    async setActionIntentStatus(scope, commitmentId, actionIntentId, status, note) {
      const commitment = await store.getCommitment(scope, commitmentId);
      if (!commitment.ok) return commitment;
      if (!commitment.value) return fail(DecisionErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
      const intents = await store.listActionIntents(scope, commitmentId);
      if (!intents.ok) return intents;
      const before = intents.value.find((i) => i.id === actionIntentId);
      if (!before) return fail(DecisionErrors.NOT_FOUND, `Action intent ${actionIntentId} is not part of that commitment.`);
      if (before.status === status) return ok(before);
      if (before.status === 'DONE' || before.status === 'CANCELLED') {
        return fail(DecisionErrors.INVALID_TRANSITION, `The action intent is already ${before.status}; its history is not rewritten.`);
      }
      const moved = await store.setActionIntentStatus(scope, actionIntentId, status);
      if (!moved.ok) return moved;
      await event(scope, commitment.value.decisionId, 'ACTION_INTENT_STATUS_CHANGED', {
        actionIntentId,
        commitmentId,
        from: before.status,
        to: status,
        note: note ?? null,
      });
      return moved;
    },

    // ------------------------------------------------------------ read side
    async getCommitmentSnapshot(scope, commitmentId) {
      const c = await store.getCommitment(scope, commitmentId);
      if (!c.ok) return c;
      if (!c.value) return fail(DecisionErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
      const s = await store.getSnapshot(scope, c.value.snapshotId);
      if (!s.ok) return s;
      if (!s.value) return fail(DecisionErrors.NOT_FOUND, 'The commitment snapshot could not be read.');
      return ok(s.value);
    },

    async explainDecision(scope, decisionId): Promise<Result<DecisionExplanation>> {
      const decision = await store.getDecision(scope, decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(DecisionErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
      const commitments = await store.listCommitments(scope, decisionId);
      if (!commitments.ok) return commitments;
      if (commitments.value.length === 0) {
        return fail(
          DecisionErrors.NOT_COMMITTED,
          'Nothing has been committed on this decision, so there is no choice to explain yet.',
        );
      }
      const commitment = commitments.value[commitments.value.length - 1];
      const snapshot = await store.getSnapshot(scope, commitment.snapshotId);
      if (!snapshot.ok) return snapshot;
      if (!snapshot.value) return fail(DecisionErrors.NOT_FOUND, 'The commitment snapshot could not be read.');

      const parts = await loadRevisionParts(scope, commitment.revisionId);
      if (!parts.ok) return parts;
      const chosen = parts.value.alternatives.find((a) => a.id === commitment.chosenAlternativeId);
      if (!chosen) return fail(DecisionErrors.NOT_FOUND, 'The chosen alternative could not be read.');

      // The lineage of every expected outcome, through the scenario runtime and
      // from there into calculation traces and source observations.
      const valueLineage: ScenarioExplanation[] = [];
      for (const e of commitment.expectedOutcomes) {
        if (!e.nodeId || !chosen.scenarioRunId) continue;
        const l = await scenarios.explain(scope, chosen.scenarioRunId, e.nodeId, e.period ?? undefined);
        if (l.ok) valueLineage.push(l.value);
      }

      const after = parts.value.evidence.filter(
        (e) => new Date(e.recordedAt).getTime() > new Date(commitment.committedAt).getTime(),
      );

      return ok({
        decision: decision.value,
        commitment,
        snapshot: snapshot.value,
        chosen,
        rejected: parts.value.alternatives.filter((a) => a.id !== chosen.id),
        rationale: commitment.rationale,
        acceptedTradeOffs: commitment.acceptedTradeOffs,
        criterionEvaluations: snapshot.value.criterionEvaluations,
        assumptions: parts.value.assumptions,
        challenges: parts.value.challenges,
        evidence: parts.value.evidence.filter((e) => !after.includes(e)),
        valueLineage,
        evidenceAfterCommitment: after,
        statement: DECISION_STATEMENT,
      });
    },

    async committedEvent(scope, commitmentId): Promise<Result<DecisionCommittedEvent>> {
      const commitment = await store.getCommitment(scope, commitmentId);
      if (!commitment.ok) return commitment;
      if (!commitment.value) return fail(DecisionErrors.NOT_FOUND, `Commitment ${commitmentId} not found.`);
      const decision = await store.getDecision(scope, commitment.value.decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(DecisionErrors.NOT_FOUND, 'Decision not found.');
      const alternatives = await store.listAlternatives(scope, commitment.value.revisionId);
      if (!alternatives.ok) return alternatives;
      const chosen = alternatives.value.find((a) => a.id === commitment.value!.chosenAlternativeId);
      const intents = await store.listActionIntents(scope, commitmentId);
      if (!intents.ok) return intents;
      const snapshot = await store.getSnapshot(scope, commitment.value.snapshotId);
      const key = snapshot.ok
        ? (snapshot.value?.alternatives.find((a) => a.alternativeId === chosen?.id)?.scenarioKey ?? null)
        : null;
      return ok({
        type: 'DecisionCommitted',
        orgId: scope.orgId,
        decisionId: decision.value.id,
        managementQuestion: decision.value.managementQuestion,
        commitmentId,
        commitmentFingerprint: commitment.value.fingerprint,
        chosenAlternative: { id: chosen?.id ?? '', label: chosen?.label ?? '', scenarioKey: key },
        committedAt: commitment.value.committedAt,
        committedByLabel: commitment.value.committedByLabel,
        actionIntents: intents.value,
        targetSystems: [...new Set(intents.value.map((i) => i.targetSystem))].sort(),
      });
    },

    async getWorkspace(scope, decisionId, revisionId): Promise<Result<DecisionWorkspace>> {
      const decision = await store.getDecision(scope, decisionId);
      if (!decision.ok) return decision;
      if (!decision.value) return fail(DecisionErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
      const revisions = await store.listRevisions(scope, decisionId);
      if (!revisions.ok) return revisions;
      const chosenRevision = revisionId
        ? revisions.value.find((r) => r.id === revisionId)
        : (revisions.value.find((r) => r.state === 'DRAFT') ?? revisions.value[revisions.value.length - 1]);
      if (!chosenRevision) return fail(DecisionErrors.NOT_FOUND, 'The decision has no revision.');

      const loaded = await evaluationsFor(scope, chosenRevision.id);
      if (!loaded.ok) return loaded;
      const comparison = await comparisonFor(scope, loaded.value.states);
      const tradeOffs =
        loaded.value.parts.alternatives.length > 0
          ? buildTradeOffSpace({
              decisionId,
              revisionId: chosenRevision.id,
              criteria: loaded.value.parts.criteria,
              alternatives: loaded.value.states,
              evaluations: loaded.value.evaluations,
              comparison,
              referenceAlternativeId: null,
              completenessOf: (a) => loaded.value.states.find((s) => s.alternative.id === a.id)?.state?.completeness ?? null,
            })
          : null;
      const readiness = evaluateReadiness({
        decisionId,
        revisionId: chosenRevision.id,
        managementQuestion: decision.value.managementQuestion,
        hasOwner: decision.value.owner !== null,
        alternatives: loaded.value.states,
        criteria: loaded.value.parts.criteria,
        assessments: loaded.value.parts.assessments,
        assumptions: loaded.value.parts.assumptions,
        challenges: loaded.value.parts.challenges,
        evidence: loaded.value.parts.evidence,
        evaluations: loaded.value.evaluations,
        completenessOf,
        now: now(),
      });
      const commitment = await store.getCommitmentForRevision(scope, chosenRevision.id);
      if (!commitment.ok) return commitment;
      const snapshot = commitment.value ? await store.getSnapshot(scope, commitment.value.snapshotId) : null;
      const intents = commitment.value ? await store.listActionIntents(scope, commitment.value.id) : null;
      const timeline = await store.listEvents(scope, decisionId);
      if (!timeline.ok) return timeline;
      const reviews = await store.listOutcomeReviews(scope, decisionId);
      if (!reviews.ok) return reviews;

      return ok({
        decision: decision.value,
        revision: chosenRevision,
        revisions: revisions.value,
        alternatives: loaded.value.parts.alternatives,
        criteria: loaded.value.parts.criteria,
        assessments: loaded.value.parts.assessments,
        assumptions: loaded.value.parts.assumptions,
        challenges: loaded.value.parts.challenges,
        evidence: loaded.value.parts.evidence,
        evaluations: loaded.value.evaluations,
        tradeOffs,
        readiness,
        weighting: loaded.value.parts.weighting,
        commitment: commitment.value,
        snapshot: snapshot && snapshot.ok ? snapshot.value : null,
        actionIntents: intents && intents.ok ? intents.value : [],
        timeline: timeline.value,
        outcomeReviews: reviews.value,
      });
    },

    async getDecision(scope, id) {
      return store.getDecision(scope, id);
    },
    async listDecisions(scope) {
      return store.listDecisions(scope);
    },
    async listRevisions(scope, decisionId) {
      return store.listRevisions(scope, decisionId);
    },
    async timeline(scope, decisionId) {
      return store.listEvents(scope, decisionId);
    },
  };

  // ------------------------------------------------------------- internals

  /** Resolves a scenario to its latest completed simulation, or refuses. */
  async function resolveBinding(
    scope: Scope,
    scenarioId: string,
    runId?: string,
  ): Promise<
    Result<{
      status: 'MODELLED';
      scenarioId: string;
      scenarioRevisionId: string;
      scenarioRunId: string;
      unmodelledReason: null;
    }>
  > {
    const scenario = await scenarios.getScenario(scope, scenarioId);
    if (!scenario.ok) return scenario;
    if (!scenario.value) {
      return fail(
        DecisionErrors.SCENARIO_NOT_FOUND,
        `Scenario ${scenarioId} is not in this organization.`,
      );
    }
    const runs = await scenarios.listRuns(scope, { scenarioId });
    if (!runs.ok) return runs;
    const completed = runs.value.filter((r: ScenarioRun) => r.status !== 'RUNNING');
    const run = runId ? completed.find((r) => r.id === runId) : completed[completed.length - 1];
    if (!run) {
      return fail(
        DecisionErrors.SCENARIO_NOT_COMPLETED,
        `Scenario "${scenario.value.key}" has no completed simulation to bind to. Simulate it first — an alternative with no computed future is UNMODELLED, not an alternative with zeros.`,
      );
    }
    return ok({
      status: 'MODELLED',
      scenarioId,
      scenarioRevisionId: run.revisionId!,
      scenarioRunId: run.id,
      unmodelledReason: null,
    });
  }

  async function findCriterion(scope: Scope, criterionId: string) {
    const decisions = await store.listDecisions(scope);
    if (!decisions.ok) return decisions;
    for (const d of decisions.value) {
      const revisions = await store.listRevisions(scope, d.id);
      if (!revisions.ok) return revisions;
      for (const r of revisions.value) {
        const criteria = await store.listCriteria(scope, r.id);
        if (!criteria.ok) return criteria;
        const found = criteria.value.find((c) => c.id === criterionId);
        if (found) return ok(found);
      }
    }
    return fail(DecisionErrors.NOT_FOUND, `Criterion ${criterionId} not found.`);
  }

  /** Reads each expected outcome's value out of the chosen future state. */
  async function resolveExpectedOutcomes(
    scope: Scope,
    chosen: DecisionAlternative,
    wanted: NonNullable<CommitInput['expectedOutcomes']>,
  ): Promise<Result<ExpectedOutcome[]>> {
    const out: ExpectedOutcome[] = [];
    const state =
      chosen.scenarioRunId !== null ? await scenarios.getFutureState(scope, chosen.scenarioRunId) : null;
    for (const w of wanted) {
      if (w.kind === 'QUALITATIVE' || !w.metricKey) {
        out.push({
          label: w.label,
          kind: 'QUALITATIVE',
          nodeId: null,
          metricKey: w.metricKey ?? null,
          period: null,
          expectedValue: null,
          unit: null,
          currency: null,
          statement: w.statement ?? null,
        });
        continue;
      }
      if (!state || !state.ok) {
        return fail(
          DecisionErrors.ALTERNATIVE_UNMODELLED,
          `"${w.label}" expects a modelled value, but ${chosen.label} has no future state to read it from.`,
        );
      }
      const candidates = state.value.values.filter((v) => v.metricKey === w.metricKey);
      const value =
        (w.subjectHint ? candidates.find((v) => v.nodeLabel.includes(w.subjectHint!)) : undefined) ?? candidates[0];
      if (!value) {
        return fail(
          DecisionErrors.INVALID_INPUT,
          `"${w.label}" expects ${w.metricKey}, which the chosen future state does not model.`,
        );
      }
      out.push({
        label: w.label,
        kind: 'MODELLED',
        nodeId: value.nodeId,
        metricKey: value.metricKey,
        period: value.period,
        expectedValue: value.value,
        unit: value.unit,
        currency: value.currency,
        statement: value.value === null ? `${value.origin}${value.reason ? `: ${value.reason}` : ''}` : null,
      });
    }
    return ok(out);
  }

  /**
   * Builds the evidence manifest. `persist` distinguishes `prepareCommitment`
   * (a preview, stored nowhere) from `commit` (frozen for good).
   */
  async function buildSnapshot(
    scope: Scope,
    revisionId: string,
    chosenAlternativeId: string,
    persist: boolean,
  ): Promise<Result<CommitmentSnapshot>> {
    const revision = await store.getRevision(scope, revisionId);
    if (!revision.ok) return revision;
    if (!revision.value) return fail(DecisionErrors.NOT_FOUND, `Decision revision ${revisionId} not found.`);
    const loaded = await evaluationsFor(scope, revisionId);
    if (!loaded.ok) return loaded;

    const alternatives: CommitmentSnapshot['alternatives'][number][] = [];
    let modelRef: CommitmentSnapshot['modelRef'] = null;
    for (const { alternative, state } of loaded.value.states) {
      const scenario = alternative.scenarioId ? await scenarios.getScenario(scope, alternative.scenarioId) : null;
      alternatives.push({
        alternativeId: alternative.id,
        label: alternative.label,
        status: alternative.status,
        scenarioId: alternative.scenarioId,
        scenarioKey: scenario && scenario.ok ? (scenario.value?.key ?? null) : null,
        scenarioRevisionId: alternative.scenarioRevisionId,
        scenarioRunId: alternative.scenarioRunId,
        scenarioFingerprint: state?.run.fingerprint ?? null,
        completeness: state?.completeness ?? null,
        chosen: alternative.id === chosenAlternativeId,
      });
      if (!modelRef && state) modelRef = state.run.modelRef;
    }

    const fingerprint = snapshotFingerprint({
      orgId: scope.orgId,
      decisionId: revision.value.decisionId,
      revisionId,
      fork: revision.value.fork,
      modelRef,
      alternatives,
      criteria: loaded.value.parts.criteria,
      assumptions: loaded.value.parts.assumptions,
      challenges: loaded.value.parts.challenges,
      evidence: loaded.value.parts.evidence,
    });

    const draft: Omit<CommitmentSnapshot, 'id' | 'orgId'> = {
      decisionId: revision.value.decisionId,
      revisionId,
      capturedAt: now(),
      fork: revision.value.fork,
      modelRef,
      alternatives,
      criterionIds: loaded.value.parts.criteria.map((c) => c.id),
      assumptionIds: loaded.value.parts.assumptions.map((a) => a.id),
      challengeIds: loaded.value.parts.challenges.map((c) => c.id),
      evidenceIds: loaded.value.parts.evidence.map((e) => e.id),
      criterionEvaluations: loaded.value.evaluations as readonly CriterionEvaluation[],
      openChallenges: loaded.value.parts.challenges.filter((c) => c.status === 'OPEN').map((c) => c.id),
      fingerprint,
    };
    if (!persist) return ok({ ...draft, id: 'preview', orgId: scope.orgId });
    return store.createSnapshot(scope, draft);
  }
}

/** Convenience: the absolute size of a variance, exact. */
export function varianceMagnitude(expected: string, actual: string): string {
  return canonicalNumeric(decToString(abs(subtract(decimal(actual), decimal(expected)))));
}
