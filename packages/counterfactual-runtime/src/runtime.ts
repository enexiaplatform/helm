/**
 * The CounterfactualRuntime (ADR-0029).
 *
 * Every read takes a lens. What comes back is reconstructed from the records
 * KNOWN at its knowledge boundary: a world estimated later does not exist
 * earlier, a review counts only from the moment it was recorded, and causal
 * support is read from the Causal Graph AT THE WORLD'S OWN LENS — so a claim
 * recorded after the decision supports the hindsight world and does not exist
 * for the world as known then.
 *
 * What this runtime never does:
 *   - start from today's enterprise: every case anchors to a snapshot known at
 *     or before the decision boundary, and worlds read the decision's own fork;
 *   - blend the two retrospective lenses, or let hindsight bring in the state
 *     the actual decision produced;
 *   - estimate what the model cannot compute, or call a model result causal;
 *   - propose an intervention, rank alternatives, score regret or judge the decision;
 *   - change a decision, commitment, outcome review, observation, causal claim
 *     or authority rule. The only thing it writes below itself is a scenario
 *     labelled as counterfactual — a new child of the alternative's scenario or
 *     a new root, never a rebase or a new revision of the alternative's own.
 */

import { fail, ok, hasRole, samePeriod, type Clock, type Period, type Result, type Scope } from '@helm/shared';
import type { Decision, DecisionAlternative, DecisionCommitment, DecisionOutcomeReview, DecisionStore } from '@helm/decision-runtime';
import { canSeeDecision, type OrgUnit } from '@helm/authority-runtime';
import type { CausalGraph } from '@helm/causal-runtime';
import type { FutureState, FutureStateValue, OverrideInput, ScenarioRuntime } from '@helm/scenario-runtime';
import { isCleared, sensitivityClasses as knownClasses, type TwinRuntime, type TwinViewer } from '@helm/twin-runtime';
import {
  IMPORTANT_NOT_A_VERDICT,
  LENS_NEVER_BLENDED,
  causalSupportLevel,
  classesOf,
  comparisonFingerprint,
  differenceOf,
  pairNote,
  readingStatement,
  uncertaintyOf,
  variableBindsTo,
  worldFingerprint,
} from './policy.ts';
import type {
  CaseView,
  ComparedRow,
  CounterfactualComparison,
  CounterfactualRuntime,
  CounterfactualStore,
  CounterfactualVisibilityFacts,
  EstimateInput,
  OpenCaseInput,
  ProjectedCounterfactuals,
  RecordReviewInput,
  WorldView,
} from './port.ts';
import {
  CounterfactualErrors,
  type CausalSupport,
  type ComparedMetric,
  type ComparisonCell,
  type CounterfactualCase,
  type CounterfactualLens,
  type CounterfactualScope,
  type CounterfactualWorld,
  type HindsightInput,
  type HindsightInputSpec,
  type MovedInput,
  type PairSupport,
  type RetrospectiveLens,
  type WorldAssumption,
  type WorldConstraint,
  type WorldReading,
} from './types.ts';

export type CounterfactualSources = {
  decisions: DecisionStore;
  scenarios: ScenarioRuntime;
  twin: TwinRuntime;
  causal: CausalGraph;
};

export type CounterfactualRuntimeOptions = { store: CounterfactualStore; sources: CounterfactualSources; clock: Clock };

const ms = (t: string) => Date.parse(t);
const invalid = (msg: string) => fail(CounterfactualErrors.INVALID, msg);
const known = <T extends { recordedAt: string }>(xs: readonly T[], T: number): T[] => xs.filter((x) => ms(x.recordedAt) <= T);
const MIN_EXOGENEITY = 12;

type Facts = {
  decision: Decision;
  commitment: DecisionCommitment;
  alternatives: readonly DecisionAlternative[];
  chosen: DecisionAlternative | null;
  reviews: readonly DecisionOutcomeReview[];
};

/** The knowledge boundary management decided under: the commitment. */
function boundaryOf(decision: Decision, commitment: DecisionCommitment): CounterfactualLens {
  const T = commitment.committedAt;
  const E = ms(decision.fork.effectiveAsOf) < ms(T) ? decision.fork.effectiveAsOf : T;
  return { effectiveAsOf: E, recordedThrough: T };
}

function validScope(s: CounterfactualScope | undefined): string | null {
  if (!s) return 'A case states its scope.';
  if (s.kind === 'ANCHORED') {
    if (!Array.isArray(s.anchors) || s.anchors.length === 0) return 'A case is anchored on at least one entity; nothing is global by default.';
    if (s.anchors.some((a) => !a.entityId || !a.label?.trim())) return 'Every scope anchor names an entity and a label.';
    return null;
  }
  if (s.kind === 'ENTERPRISE_WIDE') return (s.justification ?? '').trim().length >= MIN_EXOGENEITY ? null : 'An enterprise-wide case states why in a sentence.';
  return 'Unknown scope kind.';
}

export function createCounterfactualRuntime(opts: CounterfactualRuntimeOptions): CounterfactualRuntime {
  const { store, sources, clock } = opts;
  const { decisions, scenarios, twin, causal } = sources;

  const currentLens = (): CounterfactualLens => {
    const n = clock.now().toISOString();
    return { effectiveAsOf: n, recordedThrough: n };
  };
  const checkLens = (lens: CounterfactualLens | undefined): Result<CounterfactualLens> => {
    const l = lens ?? currentLens();
    if (Number.isNaN(ms(l.effectiveAsOf)) || Number.isNaN(ms(l.recordedThrough))) return invalid('A lens states effectiveAsOf and recordedThrough as instants.');
    if (ms(l.recordedThrough) > clock.now().getTime()) return fail(CounterfactualErrors.KNOWLEDGE_IN_FUTURE, 'A counterfactual cannot know what has not been recorded yet: recordedThrough is in the future.');
    return ok(l);
  };

  // ------------------------------------------------------------ the decision behind a case

  async function factsOf(scope: Scope, decisionId: string, commitmentId?: string | null): Promise<Result<Facts>> {
    const d = await decisions.getDecision(scope, decisionId);
    if (!d.ok) return d;
    if (!d.value) return fail(CounterfactualErrors.NOT_FOUND, `Decision ${decisionId} not found.`);
    const commitments = await decisions.listCommitments(scope, decisionId);
    if (!commitments.ok) return commitments;
    const commitment = commitmentId
      ? commitments.value.find((c) => c.id === commitmentId)
      : [...commitments.value].sort((a, b) => a.committedAt.localeCompare(b.committedAt)).pop();
    if (!commitment) return fail(CounterfactualErrors.NO_COMMITMENT, 'A counterfactual reviews a decision management committed to. This one has no such commitment.');
    const revisions = await decisions.listRevisions(scope, decisionId);
    if (!revisions.ok) return revisions;
    const alternatives: DecisionAlternative[] = [];
    for (const r of revisions.value) {
      const alts = await decisions.listAlternatives(scope, r.id);
      if (!alts.ok) return alts;
      alternatives.push(...alts.value);
    }
    const reviews = await decisions.listOutcomeReviews(scope, decisionId);
    if (!reviews.ok) return reviews;
    return ok({
      decision: d.value,
      commitment,
      alternatives,
      chosen: alternatives.find((a) => a.id === commitment.chosenAlternativeId) ?? null,
      reviews: reviews.value.filter((r) => r.commitmentId === commitment.id),
    });
  }

  // ------------------------------------------------------------ causal support at a world's lens

  async function causalSupportOf(scope: Scope, c: CounterfactualCase, w: CounterfactualWorld): Promise<Result<CausalSupport>> {
    const lens = w.knowledge;
    const vars = await causal.listVariables(scope);
    if (!vars.ok) return vars;
    const contexts = c.scope.kind === 'ANCHORED' ? c.scope.anchors.map((a) => a.entityId) : [];
    const inputs = w.movedInputs.filter((m) => m.source === 'INTERVENTION');
    const seen = new Set<string>();
    const pairs: PairSupport[] = [];
    for (const input of inputs) {
      const causeVar = vars.value.find((v) => variableBindsTo(v, input.metricKey, input.nodeId));
      for (const compared of c.compared) {
        const key = `${input.nodeId}|${compared.metricKey}|${compared.nodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (input.metricKey === compared.metricKey && (compared.nodeId === null || compared.nodeId === input.nodeId)) continue;
        const effectVar = vars.value.find((v) => variableBindsTo(v, compared.metricKey, compared.nodeId));
        const dep = await causal.modelDependency(scope, causeVar?.key ?? input.metricKey, effectVar?.key ?? compared.metricKey);
        const modelDependency = dep.ok && dep.value ? dep.value.statement : null;
        const fromLabel = causeVar?.label ?? input.nodeLabel;
        const toLabel = effectVar?.label ?? compared.label;
        if (!causeVar || !effectVar) {
          pairs.push({ input, compared, state: 'NO_CAUSAL_KNOWLEDGE', claims: [], modelDependency, note: pairNote('NO_CAUSAL_KNOWLEDGE', fromLabel, toLabel) });
          continue;
        }
        const found = await causal.paths(scope, { from: causeVar.key, to: effectVar.key, maxDepth: 4, lens });
        if (!found.ok) return found;
        if (found.value.length === 0) {
          pairs.push({ input, compared, state: 'NO_PATH', claims: [], modelDependency, note: pairNote('NO_PATH', fromLabel, toLabel) });
          continue;
        }
        // Read every claim on every path at the world's lens, and whether it applies to the case.
        type Judged = { path: (typeof found.value)[number]; claims: PairSupport['claims']; allSupported: boolean; allApply: boolean; anyContested: boolean };
        const judged: Judged[] = [];
        for (const path of found.value) {
          const claims: PairSupport['claims'][number][] = [];
          for (const step of path.steps) {
            const view = await causal.getClaim(scope, step.claimId, lens);
            if (!view.ok) return view;
            const app = await causal.applicability(scope, step.claimId, contexts, lens);
            if (!app.ok) return app;
            claims.push({
              claimId: step.claimId,
              statement: view.value.revision.statement,
              status: view.value.evaluation.status,
              confidence: view.value.evaluation.confidence,
              applies: c.scope.kind === 'ANCHORED' ? app.value.verdict === 'APPLIES' : view.value.claim.scope.kind === 'ENTERPRISE_WIDE',
            });
          }
          judged.push({
            path,
            claims,
            allSupported: claims.every((k) => k.status === 'SUPPORTED'),
            allApply: claims.every((k) => k.applies),
            anyContested: claims.some((k) => k.status === 'CONTESTED' || k.status === 'WEAKENED' || k.status === 'REFUTED'),
          });
        }
        const best = judged.find((j) => j.allSupported && j.allApply);
        const outside = judged.find((j) => j.allSupported && !j.allApply);
        const contested = judged.find((j) => j.anyContested);
        const state = best ? 'SUPPORTED_PATH' : outside ? 'OUTSIDE_SCOPE' : contested ? 'CONTESTED_PATH' : 'UNSUPPORTED_PATH';
        const pick = best ?? outside ?? contested ?? judged[0];
        pairs.push({ input, compared, state, claims: pick.claims, modelDependency, note: pairNote(state, fromLabel, toLabel) });
      }
    }
    const level = causalSupportLevel(pairs);
    return ok({ level: level.level, lens, pairs, statement: level.statement });
  }

  async function worldView(scope: Scope, c: CounterfactualCase, w: CounterfactualWorld): Promise<Result<WorldView>> {
    const support = await causalSupportOf(scope, c, w);
    if (!support.ok) return support;
    return ok({ world: w, causal: support.value });
  }

  // ------------------------------------------------------------ views

  async function caseView(scope: Scope, c: CounterfactualCase, lens: CounterfactualLens): Promise<Result<CaseView>> {
    const T = ms(lens.recordedThrough);
    if (ms(c.recordedAt) > T) return fail(CounterfactualErrors.NOT_KNOWN_AT_LENS, `This case was first recorded on ${c.recordedAt}, after the knowledge boundary ${lens.recordedThrough}.`);
    const facts = await factsOf(scope, c.decisionId, c.commitmentId);
    if (!facts.ok) return facts;
    const allWorlds = await store.listWorlds(scope, c.id);
    const allReviews = await store.listReviews(scope, c.id);
    if (!allWorlds.ok) return allWorlds;
    if (!allReviews.ok) return allReviews;
    const worlds = known(allWorlds.value, T).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const reviews = known(allReviews.value, T);
    const latest = (lensKind: RetrospectiveLens) => worlds.filter((w) => w.lens === lensKind).pop() ?? null;
    const then = latest('AS_KNOWN_THEN');
    const hind = latest('WITH_HINDSIGHT');
    const thenView = then ? await worldView(scope, c, then) : null;
    if (thenView && !thenView.ok) return thenView;
    const hindView = hind ? await worldView(scope, c, hind) : null;
    if (hindView && !hindView.ok) return hindView;
    const interventionLabel =
      c.intervention.kind === 'OVERRIDES' ? c.intervention.label : facts.value.alternatives.find((a) => a.id === (c.intervention as { alternativeId: string }).alternativeId)?.label ?? 'an alternative';
    const status: CaseView['status'] = reviews.length > 0 ? 'REVIEWED' : worlds.length > 0 ? 'ESTIMATED' : 'OPEN';
    return ok({
      case: c,
      lens,
      status,
      decisionTitle: facts.value.decision.title,
      chosenLabel: facts.value.chosen?.label ?? null,
      interventionLabel,
      worlds: { asKnownThen: thenView?.ok ? thenView.value : null, withHindsight: hindView?.ok ? hindView.value : null },
      history: worlds,
      reviews,
      statement:
        `${c.title}: ${status}. An ex-post question — what might have happened under "${interventionLabel}" instead of "${facts.value.chosen?.label ?? 'what was chosen'}" — ` +
        'anchored to the decision boundary. It is a model estimate, not a judgement of the decision.',
    });
  }

  // ------------------------------------------------------------ computing a world

  const periodsOf = (c: CounterfactualCase, chosenState: FutureState | null): Period[] => {
    const own = c.compared.map((m) => m.period).filter((p): p is Period => p !== null);
    const uniq: Period[] = [];
    for (const p of own) if (!uniq.some((q) => samePeriod(p, q))) uniq.push(p);
    return uniq.length > 0 ? uniq : [...(chosenState?.run.periods ?? [])];
  };

  const readingsOf = (
    c: CounterfactualCase,
    fs: FutureState,
    lensKind: RetrospectiveLens,
    assumptions: number,
  ): WorldReading[] =>
    c.compared.map((m) => {
      const candidates = fs.values.filter((v) => (m.nodeId ? v.nodeId === m.nodeId : v.metricKey === m.metricKey) && (m.period ? samePeriod(v.period, m.period) : true));
      const v: FutureStateValue | undefined = candidates[0];
      const model = fs.run.modelRef;
      if (!v) {
        return { label: m.label, metricKey: m.metricKey, nodeId: m.nodeId, period: m.period, status: 'UNAVAILABLE', value: null, unit: m.unit, currency: m.currency, origin: null, reason: 'This future state holds no such value.', statement: readingStatement({ label: m.label, value: null, unit: m.unit, currency: m.currency, model, assumptions, lens: lensKind }) };
      }
      const usable = v.value !== null && v.origin !== 'BLOCKED' && v.origin !== 'UNAVAILABLE';
      return {
        label: m.label,
        metricKey: m.metricKey,
        nodeId: m.nodeId ?? v.nodeId,
        period: m.period ?? v.period,
        status: usable ? 'READ' : 'UNAVAILABLE',
        value: usable ? v.value : null,
        unit: v.unit ?? m.unit,
        currency: v.currency ?? m.currency,
        origin: v.origin,
        reason: usable ? null : v.reason ?? 'The model could not compute it.',
        statement: readingStatement({ label: m.label, value: usable ? v.value : null, unit: v.unit ?? m.unit, currency: v.currency ?? m.currency, model, assumptions, lens: lensKind }),
      };
    });

  function movedInputsOf(fs: FutureState, hindsightNodeIds: ReadonlySet<string>): MovedInput[] {
    return fs.values
      .filter((v) => v.origin === 'OVERRIDDEN' && v.override && v.value !== null)
      .map((v) => ({
        nodeId: v.nodeId,
        nodeLabel: v.nodeLabel,
        metricKey: v.metricKey,
        period: v.period,
        source: hindsightNodeIds.has(v.nodeId) ? ('HINDSIGHT' as const) : ('INTERVENTION' as const),
        baselineValue: v.override!.baselineValue,
        value: v.value as string,
        rationale: v.override!.rationale,
        provenanceKind: v.override!.provenanceKind,
        confidence: v.confidence,
      }));
  }

  const assumptionsOf = (moved: readonly MovedInput[]): WorldAssumption[] =>
    moved.map((m) => ({ label: m.nodeLabel, rationale: m.rationale, provenanceKind: m.provenanceKind, confidence: m.confidence }));

  const constraintsOf = (fs: FutureState): WorldConstraint[] =>
    fs.constraints.map((k) => ({ key: k.constraintKey, name: k.name, kind: k.kind, period: k.period, status: k.status, breachAmount: k.breachAmount, unit: k.unit }));

  /**
   * A new scenario, labelled as counterfactual, executed by the scenario runtime
   * as any scenario author would. Its key is unique among this case's scenarios
   * — including any an earlier, refused attempt left behind — and a scenario
   * that fails part-way is archived rather than left as a draft.
   */
  async function computeScenario(
    scope: Scope,
    c: CounterfactualCase,
    lensKind: RetrospectiveLens,
    spec: { parentScenarioId: string | null; fork?: Decision['fork']; periods?: readonly Period[]; overrides: readonly OverrideInput[] },
  ): Promise<Result<FutureState & { scenarioId: string; revisionId: string }>> {
    const tag = lensKind === 'AS_KNOWN_THEN' ? 'then' : 'hind';
    const all = await scenarios.listScenarios(scope);
    if (!all.ok) return all;
    const seq = all.value.filter((x) => x.key.startsWith(`cf-${c.id}-${tag}-`)).length + 1;
    const created = await scenarios.createScenario(scope, {
      key: `cf-${c.id}-${tag}-${seq}`,
      name: `Counterfactual — ${c.title} (${lensKind === 'AS_KNOWN_THEN' ? 'as known then' : 'with hindsight'})`,
      description: 'Computed for a counterfactual case. Never a baseline, never bound to a decision.',
      parentScenarioId: spec.parentScenarioId,
      fork: spec.fork,
      periods: spec.periods,
      metadata: { counterfactual: { caseId: c.id, lens: lensKind, intervention: c.intervention.kind } },
    });
    if (!created.ok) return created;
    const abandon = async <T>(failure: Result<T>): Promise<Result<T>> => {
      await scenarios.archive(scope, created.value.scenario.id);
      return failure;
    };
    for (const o of spec.overrides) {
      const added = await scenarios.addOverride(scope, created.value.revision.id, o);
      if (!added.ok) return abandon(added);
    }
    const executed = await scenarios.execute(scope, created.value.scenario.id);
    if (!executed.ok) return abandon(executed);
    return ok({ ...executed.value.futureState, scenarioId: created.value.scenario.id, revisionId: executed.value.run.revisionId ?? created.value.revision.id });
  }

  function hindsightSpecsValid(specs: readonly HindsightInputSpec[]): string | null {
    for (const h of specs) {
      if (!h.label?.trim()) return 'Every hindsight input has a label.';
      if (!h.source?.ref?.trim()) return `"${h.label}": name the record it was learned from.`;
      if ((h.exogeneity ?? '').trim().length < MIN_EXOGENEITY) {
        return `"${h.label}": state why this is news about the world and not a consequence of the choice (at least ${MIN_EXOGENEITY} characters). A person asserts it; HELM cannot.`;
      }
      if (!h.override?.targetNodeId) return `"${h.label}": a hindsight input is an override of a value node.`;
    }
    return null;
  }

  // ------------------------------------------------------------ the runtime

  const self: CounterfactualRuntime = {
    async openCase(scope, input: OpenCaseInput) {
      if (!hasRole(scope, 'member')) return fail(CounterfactualErrors.FORBIDDEN, 'Opening a counterfactual case needs member access.');
      if (!input.title?.trim() || !input.question?.trim() || !input.authoredByLabel?.trim()) return invalid('A case is titled, asks its question, and names its author.');
      const scopeErr = validScope(input.scope);
      if (scopeErr) return invalid(scopeErr);
      const unknownClass = (input.carriesClasses ?? []).find((k) => !(knownClasses as readonly string[]).includes(k));
      if (unknownClass) return invalid(`Unknown sensitivity class "${unknownClass}".`);
      const facts = await factsOf(scope, input.decisionId, input.commitmentId);
      if (!facts.ok) return facts;
      const { decision, commitment, alternatives } = facts.value;
      const boundary = boundaryOf(decision, commitment);

      // The intervention must be explicit, and different from what was chosen.
      const iv = input.intervention;
      if (iv?.kind === 'CHOOSE_ALTERNATIVE') {
        const alt = alternatives.find((a) => a.id === iv.alternativeId);
        if (!alt) return fail(CounterfactualErrors.NOT_FOUND, 'That alternative is not one this decision recorded.');
        if (alt.id === commitment.chosenAlternativeId) return fail(CounterfactualErrors.NOT_AN_INTERVENTION, 'That is the alternative management chose: an intervention differs from reality.');
      } else if (iv?.kind === 'OVERRIDES') {
        if (!iv.label?.trim() || !Array.isArray(iv.overrides) || iv.overrides.length === 0) return invalid('An OVERRIDES intervention is labelled and states at least one override.');
        if (iv.overrides.some((o) => !o.targetNodeId || !o.rationale?.trim())) return invalid('Every override names a value node and says why.');
      } else {
        return invalid('State the intervention: CHOOSE_ALTERNATIVE or OVERRIDES. HELM never proposes one.');
      }

      // Every counterfactual anchors to a historical state.
      if (!input.anchorSnapshotId) {
        return fail(CounterfactualErrors.UNANCHORED, 'Every counterfactual anchors to a historical state: name the twin snapshot at the decision boundary. Today\'s enterprise state is never an anchor.');
      }
      const snap = await twin.getSnapshot(scope, input.anchorSnapshotId);
      if (!snap.ok) return snap;
      const anchorLens = snap.value.snapshot.spec.lens;
      if (ms(anchorLens.recordedThrough) > ms(boundary.recordedThrough)) {
        return fail(
          CounterfactualErrors.HINDSIGHT_AS_ANCHOR,
          `The snapshot was known only through ${anchorLens.recordedThrough}, after the decision boundary ${boundary.recordedThrough}: it is hindsight, not the state management faced.`,
        );
      }

      const compared: ComparedMetric[] = commitment.expectedOutcomes
        .filter((o) => o.kind === 'MODELLED' && o.metricKey)
        .map((o) => ({ label: o.label, metricKey: o.metricKey as string, nodeId: o.nodeId, period: o.period, unit: o.unit, currency: o.currency }));
      if (compared.length === 0) return fail(CounterfactualErrors.NOTHING_TO_REVIEW, 'The commitment expected no modelled outcome, so there is nothing to compare an alternative against.');

      const inserted = await store.insertCase(scope, {
        decisionId: decision.id,
        commitmentId: commitment.id,
        title: input.title.trim(),
        question: input.question.trim(),
        intervention: iv,
        anchor: { snapshotId: input.anchorSnapshotId, lens: anchorLens },
        boundary,
        compared,
        scope: input.scope,
        sensitivityClasses: [...new Set([...classesOf(compared.map((m) => m.metricKey)), ...(input.carriesClasses ?? [])])].sort() as CounterfactualCase['sensitivityClasses'],
        visibility: input.visibility ?? 'ORG_WIDE',
        grantedUnitIds: [...(input.grantedUnitIds ?? [])],
        authoredBy: scope.actorId ?? null,
        authoredByLabel: input.authoredByLabel.trim(),
      });
      if (!inserted.ok) return inserted;
      return caseView(scope, inserted.value, currentLens());
    },

    async estimate(scope, caseId, input: EstimateInput) {
      if (!hasRole(scope, 'member')) return fail(CounterfactualErrors.FORBIDDEN, 'Estimating a counterfactual world needs member access.');
      if (!input.byLabel?.trim()) return invalid('A world names who asked for it.');
      const cRes = await store.getCase(scope, caseId);
      if (!cRes.ok) return cRes;
      const c = cRes.value;
      if (!c) return fail(CounterfactualErrors.NOT_FOUND, 'No such case in this organization.');
      const facts = await factsOf(scope, c.decisionId, c.commitmentId);
      if (!facts.ok) return facts;
      const { decision, alternatives, chosen, reviews } = facts.value;
      const nowIso = clock.now().toISOString();

      const alt: DecisionAlternative | null = c.intervention.kind === 'CHOOSE_ALTERNATIVE' ? alternatives.find((a) => a.id === (c.intervention as { alternativeId: string }).alternativeId) ?? null : null;
      const altModelled = alt !== null && alt.status === 'MODELLED' && alt.scenarioRunId !== null && alt.scenarioId !== null;
      const chosenState = chosen?.scenarioRunId ? await scenarios.getFutureState(scope, chosen.scenarioRunId) : null;
      const chosenFs = chosenState?.ok ? chosenState.value : null;

      const hindsightInputs: HindsightInput[] = [];
      let fs: (FutureState & { scenarioId?: string; revisionId?: string }) | null = null;
      let origin: CounterfactualWorld['origin'] = null;
      const reasons: string[] = [];
      const knowledge: CounterfactualLens = input.lens === 'AS_KNOWN_THEN' ? c.boundary : { effectiveAsOf: nowIso, recordedThrough: nowIso };

      if (input.lens === 'WITH_HINDSIGHT') {
        const specs = input.hindsight ?? [];
        if (specs.length === 0) {
          return fail(CounterfactualErrors.NO_HINDSIGHT_INPUTS, 'WITH_HINDSIGHT needs at least one fact learned after the decision boundary; without one it would be AS_KNOWN_THEN renamed.');
        }
        const specErr = hindsightSpecsValid(specs);
        if (specErr) return invalid(specErr);
        const chosenNodes = new Set((chosenFs?.values ?? []).filter((v) => v.origin === 'OVERRIDDEN').map((v) => v.nodeId));
        for (const s of specs) {
          let learnedAt: string;
          if (s.source.kind === 'OUTCOME_REVIEW') {
            const review = reviews.find((r) => r.id === s.source.ref);
            if (!review) return fail(CounterfactualErrors.NOT_FOUND, `"${s.label}": no such outcome review on this decision's commitment.`);
            learnedAt = review.reviewedAt;
          } else {
            if (!s.source.learnedAt || Number.isNaN(ms(s.source.learnedAt))) return invalid(`"${s.label}": state when the enterprise learned it.`);
            learnedAt = s.source.learnedAt;
            if (ms(learnedAt) > ms(nowIso)) return invalid(`"${s.label}": it cannot have been learned in the future.`);
          }
          if (ms(learnedAt) <= ms(c.boundary.recordedThrough)) {
            return fail(CounterfactualErrors.NOT_HINDSIGHT, `"${s.label}" was knowable at the decision boundary (${learnedAt}); it belongs in the AS_KNOWN_THEN world, not in hindsight.`);
          }
          if (chosenNodes.has(s.override.targetNodeId)) {
            return fail(
              CounterfactualErrors.HINDSIGHT_IS_CONSEQUENCE,
              `"${s.label}" targets a value the alternative management actually chose set: it is a consequence of the actual choice, not news about the world.`,
            );
          }
          hindsightInputs.push({ label: s.label.trim(), source: { kind: s.source.kind, ref: s.source.ref }, learnedAt, override: s.override, exogeneity: s.exogeneity.trim() });
        }
      }

      // ---- the state
      if (c.intervention.kind === 'CHOOSE_ALTERNATIVE') {
        if (!altModelled) {
          reasons.push(
            alt?.unmodelledReason
              ? `The alternative "${alt.label}" was never modelled: ${alt.unmodelledReason}`
              : `The alternative "${alt?.label ?? 'chosen for the intervention'}" has no simulated future, so there is nothing for the model to estimate.`,
          );
        } else if (input.lens === 'AS_KNOWN_THEN') {
          const bound = await scenarios.getFutureState(scope, alt!.scenarioRunId as string);
          if (!bound.ok) return bound;
          if (ms(bound.value.run.fork.recordedThrough) > ms(c.boundary.recordedThrough)) {
            return fail(
              CounterfactualErrors.HINDSIGHT_IN_AS_KNOWN_THEN,
              `The alternative's run used knowledge recorded through ${bound.value.run.fork.recordedThrough}, after the decision boundary ${c.boundary.recordedThrough}: it cannot be presented as known then.`,
            );
          }
          fs = { ...bound.value, scenarioId: alt!.scenarioId as string, revisionId: alt!.scenarioRevisionId ?? undefined };
          origin = 'BOUND_TO_DECISION';
        } else {
          const built = await computeScenario(scope, c, 'WITH_HINDSIGHT', {
            parentScenarioId: alt!.scenarioId,
            overrides: hindsightInputs.map((h) => h.override),
          });
          if (!built.ok) return built;
          fs = built.value;
          origin = 'COMPUTED_FOR_CASE';
        }
      } else {
        const periods = periodsOf(c, chosenFs);
        if (periods.length === 0) return invalid('HELM cannot tell which periods to simulate: the commitment states none and the chosen alternative has no run.');
        const built = await computeScenario(scope, c, input.lens, {
          parentScenarioId: null,
          fork: decision.fork,
          periods,
          overrides: [...c.intervention.overrides, ...hindsightInputs.map((h) => h.override)],
        });
        if (!built.ok) return built;
        fs = built.value;
        origin = 'COMPUTED_FOR_CASE';
      }

      // ---- the world
      const hindsightNodes = new Set(hindsightInputs.map((h) => h.override.targetNodeId));
      const moved = fs ? movedInputsOf(fs, hindsightNodes) : [];
      const readings: WorldReading[] = fs
        ? readingsOf(c, fs, input.lens, moved.length)
        : c.compared.map((m) => ({
            label: m.label,
            metricKey: m.metricKey,
            nodeId: m.nodeId,
            period: m.period,
            status: 'UNAVAILABLE' as const,
            value: null,
            unit: m.unit,
            currency: m.currency,
            origin: null,
            reason: reasons[0] ?? 'No world could be computed.',
            statement: readingStatement({ label: m.label, value: null, unit: m.unit, currency: m.currency, model: null, assumptions: 0, lens: input.lens }),
          }));
      const classes = classesOf([...c.compared.map((m) => m.metricKey), ...moved.map((m) => m.metricKey)]);
      // A scenario computed for a world that is then refused is archived: nothing is left behind as if it were a reading.
      const refuse = async <T>(failure: Result<T>): Promise<Result<T>> => {
        if (origin === 'COMPUTED_FOR_CASE' && fs?.scenarioId) await scenarios.archive(scope, fs.scenarioId);
        return failure;
      };
      const exceeding = classes.filter((k) => !c.sensitivityClasses.includes(k));
      if (exceeding.length > 0) {
        return refuse(fail(
          CounterfactualErrors.CLASS_EXCEEDS_CASE,
          `The estimate moves inputs of class ${exceeding.join(', ')}, which the case does not carry: it would expose to the case's readers what they may not read. Open a case that declares it (carriesClasses).`,
        ));
      }
      const blocked = readings.filter((r) => r.status === 'UNAVAILABLE' && r.origin === 'BLOCKED').length;
      const unavailable = readings.filter((r) => r.status === 'UNAVAILABLE').length;
      const estimability = fs ? ('ESTIMATED' as const) : ('NOT_ESTIMABLE' as const);
      const model = fs ? { engineVersion: fs.run.modelRef.engineVersion, calculations: [...fs.run.modelRef.calculations] } : null;
      const uncertainty = uncertaintyOf({
        lens: input.lens,
        estimability,
        notEstimableReasons: reasons,
        movedInputs: moved,
        hindsightInputs,
        completeness: fs?.completeness ?? null,
        blockedReadings: blocked,
        unavailableReadings: unavailable - blocked,
      });
      const base = {
        caseId: c.id,
        lens: input.lens,
        method: 'MODEL_COUNTERFACTUAL' as const,
        estimability,
        notEstimableReasons: reasons,
        anchorFork: fs ? { effectiveAsOf: fs.run.fork.effectiveAsOf, recordedThrough: fs.run.fork.recordedThrough, policy: fs.run.fork.policy } : { effectiveAsOf: decision.fork.effectiveAsOf, recordedThrough: decision.fork.recordedThrough, policy: decision.fork.policy },
        knowledge,
        origin,
        scenario: fs ? { scenarioId: fs.scenarioId ?? (fs.scenario?.id as string), revisionId: fs.revisionId ?? fs.run.revisionId, runId: fs.run.id } : null,
        model,
        readings,
        movedInputs: moved,
        assumptions: assumptionsOf(moved),
        constraints: fs ? constraintsOf(fs) : [],
        hindsightInputs,
        uncertainty,
      };
      const statement =
        estimability === 'NOT_ESTIMABLE'
          ? `No counterfactual world could be estimated: ${reasons.join(' ')}`
          : `Under model ${model!.engineVersion} (${model!.calculations.length} calculations) and ${moved.length} stated input(s), the estimated ${input.lens === 'AS_KNOWN_THEN' ? 'world as known then' : 'world with hindsight'} is shown below. It is a model estimate, not what would have happened.`;
      const inserted = await store.insertWorld(scope, {
        ...base,
        statement,
        fingerprint: worldFingerprint(base),
        createdBy: scope.actorId ?? null,
        createdByLabel: input.byLabel.trim(),
      });
      if (!inserted.ok) return refuse(inserted);
      return worldView(scope, c, inserted.value);
    },

    async getCase(scope, id, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const c = await store.getCase(scope, id);
      if (!c.ok) return c;
      if (!c.value) return fail(CounterfactualErrors.NOT_FOUND, 'No such case in this organization.');
      return caseView(scope, c.value, l.value);
    },

    async listCases(scope, filter, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const cs = await store.listCases(scope, filter);
      if (!cs.ok) return cs;
      const out: CaseView[] = [];
      for (const c of known(cs.value, ms(l.value.recordedThrough)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
        const v = await caseView(scope, c, l.value);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return ok(out);
    },

    async compare(scope, caseId, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const cRes = await store.getCase(scope, caseId);
      if (!cRes.ok) return cRes;
      const c = cRes.value;
      if (!c) return fail(CounterfactualErrors.NOT_FOUND, 'No such case in this organization.');
      const view = await caseView(scope, c, l.value);
      if (!view.ok) return view;
      const facts = await factsOf(scope, c.decisionId, c.commitmentId);
      if (!facts.ok) return facts;
      const { commitment, reviews, chosen } = facts.value;
      const T = ms(l.value.recordedThrough);
      const reviewsThen = reviews.filter((r) => ms(r.reviewedAt) <= T).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
      const thenW = view.value.worlds.asKnownThen;
      const hindW = view.value.worlds.withHindsight;

      const cellFromWorld = (w: WorldView | null, m: ComparedMetric, layer: ComparisonCell['layer'], missing: string): ComparisonCell => {
        if (!w) return { layer, status: 'UNAVAILABLE', value: null, unit: m.unit, currency: m.currency, source: 'not estimated', reason: missing, worldId: null };
        const r = w.world.readings.find((x) => x.metricKey === m.metricKey && x.nodeId === (m.nodeId ?? x.nodeId));
        if (!r || r.status !== 'READ') {
          return { layer, status: 'UNAVAILABLE', value: null, unit: m.unit, currency: m.currency, source: `world ${w.world.fingerprint}`, reason: r?.reason ?? w.world.notEstimableReasons[0] ?? 'No such value in the world.', worldId: w.world.id };
        }
        return { layer, status: 'READ', value: r.value, unit: r.unit, currency: r.currency, source: `${w.world.method} · ${w.world.fingerprint}`, reason: null, worldId: w.world.id };
      };

      const rows: ComparedRow[] = c.compared.map((m) => {
        const exp = commitment.expectedOutcomes.find((o) => o.metricKey === m.metricKey && (m.nodeId === null || o.nodeId === m.nodeId));
        const expected: ComparisonCell = exp && exp.expectedValue !== null
          ? { layer: 'EXPECTED_AT_COMMITMENT', status: 'READ', value: exp.expectedValue, unit: exp.unit, currency: exp.currency, source: `commitment ${commitment.id} — frozen at commitment`, reason: null, worldId: null }
          : { layer: 'EXPECTED_AT_COMMITMENT', status: 'UNAVAILABLE', value: null, unit: m.unit, currency: m.currency, source: `commitment ${commitment.id}`, reason: 'The commitment stated no value for this metric.', worldId: null };
        let actual: ComparisonCell = { layer: 'ACTUAL', status: 'UNAVAILABLE', value: null, unit: m.unit, currency: m.currency, source: 'outcome reviews', reason: reviewsThen.length === 0 ? 'No outcome review is known at this lens.' : 'No outcome review recorded this metric.', worldId: null };
        for (const r of [...reviewsThen].reverse()) {
          const v = r.variances.find((x) => x.metricKey === m.metricKey && x.actual !== null);
          if (v) {
            actual = { layer: 'ACTUAL', status: 'READ', value: v.actual, unit: v.unit ?? m.unit, currency: v.currency ?? m.currency, source: `outcome review ${r.reviewedAt.slice(0, 10)} by ${r.reviewedByLabel}`, reason: null, worldId: null };
            break;
          }
        }
        const alternativeThen = cellFromWorld(thenW, m, 'ALTERNATIVE_THEN', 'No AS_KNOWN_THEN world has been estimated at this lens.');
        const alternativeWithHindsight = cellFromWorld(hindW, m, 'ALTERNATIVE_WITH_HINDSIGHT', 'No WITH_HINDSIGHT world has been estimated at this lens.');
        const sameUnit = (a: ComparisonCell, b: ComparisonCell) => a.unit === b.unit && a.currency === b.currency;
        return {
          metric: m,
          expected,
          actual,
          alternativeThen,
          alternativeWithHindsight,
          alternativeThenMinusExpected: sameUnit(alternativeThen, expected) ? differenceOf(alternativeThen.value, expected.value) : null,
          alternativeWithHindsightMinusActual: sameUnit(alternativeWithHindsight, actual) ? differenceOf(alternativeWithHindsight.value, actual.value) : null,
        };
      });
      const modelChangedSinceThen =
        thenW?.world.model && hindW?.world.model
          ? thenW.world.model.engineVersion !== hindW.world.model.engineVersion || JSON.stringify(thenW.world.model.calculations) !== JSON.stringify(hindW.world.model.calculations)
          : null;
      const fingerprint = comparisonFingerprint({
        caseId: c.id,
        worldFingerprints: [thenW?.world.fingerprint ?? null, hindW?.world.fingerprint ?? null],
        rows: rows.map((r) => [r.metric.metricKey, r.expected.value, r.actual.value, r.alternativeThen.value, r.alternativeWithHindsight.value]),
      });
      const cmp: CounterfactualComparison = {
        case: c,
        lens: l.value,
        chosen: { alternativeId: chosen?.id ?? null, label: chosen?.label ?? null },
        intervention: { kind: c.intervention.kind, label: view.value.interventionLabel },
        rows,
        worlds: view.value.worlds,
        modelChangedSinceThen,
        fingerprint,
        statement:
          `Four layers, never collapsed: what the commitment expected, what happened, the alternative as known then, and the alternative with hindsight. ` +
          `Chosen: ${chosen?.label ?? 'not recorded'}. Instead: ${view.value.interventionLabel}.`,
        important: `${IMPORTANT_NOT_A_VERDICT} ${LENS_NEVER_BLENDED}`,
      };
      return ok(cmp);
    },

    async recordReview(scope, caseId, input: RecordReviewInput) {
      if (!hasRole(scope, 'member')) return fail(CounterfactualErrors.FORBIDDEN, 'Recording a review needs member access.');
      if (!input.statement?.trim()) return invalid('A review states its reading.');
      if (!input.limitations?.trim()) return invalid('A review states its limitations: what the comparison does not show. That is not optional.');
      if (!input.reviewedByLabel?.trim()) return invalid('A review names who wrote it.');
      const cmp = await self.compare(scope, caseId);
      if (!cmp.ok) return cmp;
      if (!cmp.value.worlds.asKnownThen && !cmp.value.worlds.withHindsight) {
        return fail(CounterfactualErrors.NOTHING_TO_REVIEW, 'Estimate at least one world before recording a review: there is nothing yet to read.');
      }
      const inserted = await store.insertReview(scope, {
        caseId,
        comparisonFingerprint: cmp.value.fingerprint,
        statement: input.statement.trim(),
        limitations: input.limitations.trim(),
        reviewedBy: scope.actorId ?? null,
        reviewedByLabel: input.reviewedByLabel.trim(),
      });
      if (!inserted.ok) return inserted;
      return self.getCase(scope, caseId);
    },

    async viewAt(scope, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const cases = await self.listCases(scope, undefined, l.value);
      if (!cases.ok) return cases;
      return ok({ lens: l.value, cases: cases.value });
    },

    async projectForViewer(scope, viewer: TwinViewer, units: readonly OrgUnit[], facts: CounterfactualVisibilityFacts, lens) {
      const l = checkLens(lens);
      if (!l.ok) return l;
      const all = await self.listCases(scope, undefined, l.value);
      if (!all.ok) return all;
      const isAdmin = viewer.orgRole === 'admin';
      const at = l.value.recordedThrough;
      const visible = all.value.filter((v) => {
        const c = v.case;
        const unitOk =
          isAdmin ||
          c.visibility === 'ORG_WIDE' ||
          canSeeDecision({ userId: viewer.userId, orgRole: viewer.orgRole, memberUnitIds: viewer.memberUnitIds }, { createdBy: c.authoredBy, grantedUnitIds: c.grantedUnitIds }, units).visible;
        return unitOk && c.sensitivityClasses.every((k) => isCleared(viewer, k, at)) && (isAdmin || facts.decisionVisible(c.decisionId));
      });
      const withheld = all.value.length - visible.length;
      const projected: ProjectedCounterfactuals = {
        cases: visible,
        withheld,
        statement:
          withheld === 0
            ? 'Every counterfactual case known at this lens is visible to you.'
            : `${withheld} counterfactual case(s) withheld: they are restricted to other units, carry a sensitivity class you are not cleared for, or review a decision you cannot see. A case is read whole or not at all.`,
      };
      return ok(projected);
    },
  };
  return self;
}
