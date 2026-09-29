/**
 * The causal graph beside the twin, the decisions and the scenarios
 * (ADR-0026 §8). Read-only in every direction.
 *
 * The central separation, for any twin difference:
 *
 *   OBSERVED DIFFERENCE      what the twin recorded, two snapshots apart
 *   MODEL EXPLANATION        which model inputs moved — arithmetic dependency
 *   CAUSAL INVESTIGATION     why those inputs moved in the world — claims and
 *                            their evidence, or "unresolved"
 *
 * The model explanation is never offered as a cause, and a causal candidate is
 * listed only if a person proposed it for the question or authored a claim
 * about that very variable. Nothing here proposes a cause.
 */

import { ok, type Result, type Scope } from '@helm/shared';
import type { DecisionAssumption } from '@helm/decision-runtime';
import type { AttributionNode, TwinRuntime } from '@helm/twin-runtime';
import type { CausalGraph, ClaimView, ModelDependency, QuestionInvestigation } from './port.ts';
import type { CausalLens, CausalVariable, KernelRef } from './types.ts';

export const CAUSAL_ATTENTION_RULES_VERSION = 'helm-causal-attention@1';

export const DEPENDENCY_IS_NOT_CAUSALITY =
  'The model dependency explains the arithmetic of the difference. It is not itself evidence of why the ' +
  'input moved in the world: causal explanations are claims, judged only by their own evidence.';

export type MovedInput = {
  readonly input: string;
  readonly metricKey: string;
  readonly nodeId: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeSource: string;
  readonly afterSource: string;
};

export type CausalInvestigationOfInput = {
  readonly moved: MovedInput;
  readonly variable: CausalVariable | null;
  readonly questions: readonly QuestionInvestigation[];
  /** Claims whose effect is this variable, when no question has been asked. */
  readonly claims: readonly ClaimView[];
  readonly state: 'NO_CAUSAL_KNOWLEDGE' | 'OPEN' | 'UNRESOLVED' | 'SUPPORTED_EXPLANATION_EXISTS';
  readonly statement: string;
};

export type TwinCausalExplanation = {
  readonly observed: {
    readonly label: string;
    readonly from: string | null;
    readonly to: string | null;
    readonly delta: string | null;
    readonly unit: string | null;
    readonly fromSnapshotId: string;
    readonly toSnapshotId: string;
  };
  readonly model: {
    readonly statement: string;
    readonly movedInputs: readonly MovedInput[];
    readonly disclaimer: string;
  };
  readonly causal: readonly CausalInvestigationOfInput[];
  /** Causal claims about the observed metric itself, each beside its model dependency (if any). */
  readonly claimsAboutObserved: readonly { readonly view: ClaimView; readonly modelDependency: ModelDependency | null }[];
  readonly important: string;
};

function movedInputs(nodes: readonly AttributionNode[]): MovedInput[] {
  const out: MovedInput[] = [];
  const walk = (n: AttributionNode) => {
    if (n.before !== n.after) {
      out.push({ input: n.input, metricKey: n.metricKey, nodeId: n.nodeId, before: n.before, after: n.after, beforeSource: n.beforeSource, afterSource: n.afterSource });
    }
    n.changedBecause.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

const bindsTo = (v: CausalVariable, metricKey: string, nodeId: string | null): boolean =>
  v.kind === 'METRIC' &&
  v.metricKey === metricKey &&
  (nodeId === null || !v.refs.some((r) => r.kind === 'VALUE_NODE') || v.refs.some((r) => r.kind === 'VALUE_NODE' && r.id === nodeId));

export async function explainTwinDifferenceCausally(
  deps: { twin: TwinRuntime; causal: CausalGraph },
  scope: Scope,
  input: { fromId: string; toId: string; itemKey: string; toItemKey?: string; lens?: CausalLens },
): Promise<Result<TwinCausalExplanation>> {
  const ex = await deps.twin.explainDifference(scope, input.fromId, input.toId, input.itemKey, input.toItemKey);
  if (!ex.ok) return ex;
  const vars = await deps.causal.listVariables(scope);
  if (!vars.ok) return vars;
  const questions = await deps.causal.listQuestions(scope);
  if (!questions.ok) return questions;
  const moved = movedInputs(ex.value.attribution);

  const causal: CausalInvestigationOfInput[] = [];
  for (const m of moved) {
    const variable = vars.value.find((v) => bindsTo(v, m.metricKey, m.nodeId)) ?? null;
    if (!variable) {
      causal.push({
        moved: m,
        variable: null,
        questions: [],
        claims: [],
        state: 'NO_CAUSAL_KNOWLEDGE',
        statement: `HELM holds no causal variable, question or claim about ${m.input}. It does not infer a cause from the model or from what moved at the same time.`,
      });
      continue;
    }
    const investigations: QuestionInvestigation[] = [];
    for (const q of questions.value.filter((x) => x.target.variableKey === variable.key)) {
      const inv = await deps.causal.investigate(scope, q.id, input.lens);
      if (inv.ok) investigations.push(inv.value);
    }
    const claims = await deps.causal.getCauses(scope, variable.key, input.lens);
    if (!claims.ok) return claims;
    const state: CausalInvestigationOfInput['state'] =
      investigations.some((i) => i.status === 'SUPPORTED_EXPLANATION_EXISTS') || claims.value.some((c) => c.evaluation.status === 'SUPPORTED')
        ? 'SUPPORTED_EXPLANATION_EXISTS'
        : investigations.length > 0 || claims.value.length > 0
          ? investigations.some((i) => i.status === 'OPEN') && claims.value.length === 0
            ? 'OPEN'
            : 'UNRESOLVED'
          : 'NO_CAUSAL_KNOWLEDGE';
    causal.push({
      moved: m,
      variable,
      questions: investigations,
      claims: claims.value,
      state,
      statement:
        state === 'NO_CAUSAL_KNOWLEDGE'
          ? `No causal claim about ${variable.label} exists. HELM does not know why it moved.`
          : state === 'SUPPORTED_EXPLANATION_EXISTS'
            ? `At least one explanation of the change in ${variable.label} is SUPPORTED by its evidence. How much of the change it explains is not quantified.`
            : `Explanations of the change in ${variable.label} have been proposed; none is SUPPORTED. The cause is UNRESOLVED.`,
    });
  }

  // Claims about the observed metric itself, with the model dependency shown apart.
  const observedMetric = (ex.value.to.item?.state?.metricKey ?? ex.value.from.item?.state?.metricKey ?? null) as string | null;
  const claimsAboutObserved: { view: ClaimView; modelDependency: ModelDependency | null }[] = [];
  const observedVar = observedMetric ? vars.value.find((v) => v.kind === 'METRIC' && v.metricKey === observedMetric) : undefined;
  if (observedVar) {
    const onIt = await deps.causal.getCauses(scope, observedVar.key, input.lens);
    if (!onIt.ok) return onIt;
    for (const v of onIt.value) {
      const dep = await deps.causal.modelDependency(scope, v.claim.causeKey, v.claim.effectKey);
      claimsAboutObserved.push({ view: v, modelDependency: dep.ok ? dep.value : null });
    }
  }

  return ok({
    observed: {
      label: ex.value.to.item?.label ?? ex.value.from.item?.label ?? ex.value.itemKey,
      from: (ex.value.from.item?.state?.value as string | undefined) ?? null,
      to: (ex.value.to.item?.state?.value as string | undefined) ?? null,
      delta: ex.value.delta,
      unit: ex.value.deltaUnit,
      fromSnapshotId: input.fromId,
      toSnapshotId: input.toId,
    },
    model: { statement: ex.value.statement, movedInputs: moved, disclaimer: ex.value.disclaimer },
    causal,
    claimsAboutObserved,
    important: DEPENDENCY_IS_NOT_CAUSALITY,
  });
}

// ---------------------------------------------------------------- decisions and scenarios

export type CausalContext = {
  readonly ref: KernelRef;
  readonly claims: readonly ClaimView[];
};

/**
 * Claims that name a decision, one of its assumptions, or a scenario. The
 * decision and scenario runtimes are not touched: the claim holds the reference.
 */
export async function claimsReferencing(
  causal: CausalGraph,
  scope: Scope,
  target: { kind: 'DECISION' | 'SCENARIO' | 'ASSUMPTION'; id: string },
  lens?: CausalLens,
): Promise<Result<readonly ClaimView[]>> {
  const all = await causal.listClaims(scope, { lens });
  if (!all.ok) return all;
  return ok(
    all.value.filter((v) =>
      v.revision.links.some(
        (l) => (l.kind === target.kind && l.id === target.id) || (target.kind === 'DECISION' && l.kind === 'ASSUMPTION' && l.pin === target.id),
      ),
    ),
  );
}

export type CausalAttention = {
  readonly rule: string;
  readonly condition: 'CRITICAL_CAUSAL_ASSUMPTION_CONTESTED' | 'DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED' | 'TEMPORAL_CONFLICT_IN_EVIDENCE';
  readonly statement: string;
  readonly claimId: string;
  readonly refs: readonly KernelRef[];
};

/**
 * Named conditions over causal claims — never a score, never an ordering by
 * importance. A decision's assumption resting on a contested or unsupported
 * causal belief is worth a look; the list says which, and why.
 */
export function causalAttention(views: readonly ClaimView[], assumptions: readonly DecisionAssumption[]): CausalAttention[] {
  const out: CausalAttention[] = [];
  for (const v of views) {
    const linked = v.revision.links.filter((l) => l.kind === 'ASSUMPTION').map((l) => assumptions.find((a) => a.id === l.id)).filter((a): a is DecisionAssumption => !!a);
    const s = v.evaluation.status;
    for (const a of linked) {
      if (a.criticality === 'CRITICAL' && (s === 'CONTESTED' || s === 'WEAKENED' || s === 'REFUTED')) {
        out.push({
          rule: `CRITICAL_CAUSAL_ASSUMPTION_CONTESTED@1`,
          condition: 'CRITICAL_CAUSAL_ASSUMPTION_CONTESTED',
          statement: `A critical assumption ("${a.statement}") rests on a causal belief that is ${s}: ${v.revision.statement}`,
          claimId: v.claim.id,
          refs: [{ kind: 'ASSUMPTION', id: a.id, pin: a.decisionId, label: a.statement }],
        });
      }
      if (s === 'HYPOTHESIS' || s === 'UNRESOLVED') {
        out.push({
          rule: `DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED@1`,
          condition: 'DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED',
          statement: `The assumption "${a.statement}" rests on a causal belief that is only a ${s.toLowerCase()}: ${v.revision.statement}`,
          claimId: v.claim.id,
          refs: [{ kind: 'ASSUMPTION', id: a.id, pin: a.decisionId, label: a.statement }],
        });
      }
    }
    if (v.evaluation.temporalConflicts > 0) {
      out.push({
        rule: 'TEMPORAL_CONFLICT_IN_EVIDENCE@1',
        condition: 'TEMPORAL_CONFLICT_IN_EVIDENCE',
        statement: `Evidence linked to "${v.revision.statement}" puts the cause after the effect; it cannot support the claim.`,
        claimId: v.claim.id,
        refs: [],
      });
    }
  }
  return out.sort((a, b) => a.condition.localeCompare(b.condition) || a.claimId.localeCompare(b.claimId));
}
