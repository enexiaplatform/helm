/**
 * The counterfactual policy (ADR-0029): pure rules, so every statement HELM
 * makes about a world can be tested without a runtime.
 *
 *   - what causal support a set of moved-input → compared-metric pairs adds up to;
 *   - what uncertainty an estimate must list (a list, never a number);
 *   - how a reading is worded — under a model, on stated assumptions, estimated;
 *   - the two differences a comparison may compute, and only those.
 *
 * Nothing here scores, ranks, weighs, totals or predicts. A causal support
 * level is a statement about EVIDENCE, and the estimate stays a model result
 * whatever it says.
 */

import { decimal, fnv1a64, subtract, toString as decimalToString } from '@helm/shared';
import type { CausalVariable } from '@helm/causal-runtime';
import { sensitivityOfMetric, type SensitivityClass } from '@helm/twin-runtime';
import type {
  CausalSupportLevel,
  CounterfactualWorld,
  HindsightInput,
  MovedInput,
  PairState,
  PairSupport,
  RetrospectiveLens,
} from './types.ts';

export const COUNTERFACTUAL_METHOD_NOTE =
  'MODEL_COUNTERFACTUAL: the executable value model\'s arithmetic over the anchor state and the intervention. It is not causal truth, and it has not been validated against an intervention.';

export const NOT_REPRESENTED =
  'What the model does not represent is not in the estimate: customer response, supplier behaviour and second-order effects beyond the calculations it registers.';

export const IMPORTANT_NOT_A_VERDICT =
  'A difference between what happened and what an alternative might have produced is not a judgement of the decision. Decision Process Quality ≠ Outcome Quality: management decided under the knowledge it had, and a counterfactual world is an estimate, not what would have happened.';

export const LENS_NEVER_BLENDED =
  'AS_KNOWN_THEN and WITH_HINDSIGHT answer different questions and are shown apart. Hindsight brings information learned later; it never brings the state the actual decision produced.';

// ---------------------------------------------------------------- variables

/** Does this causal variable denote this metric (and, when it names value nodes, this node)? */
export const variableBindsTo = (v: CausalVariable, metricKey: string, nodeId: string | null): boolean =>
  v.kind === 'METRIC' &&
  v.metricKey === metricKey &&
  (nodeId === null || !v.refs.some((r) => r.kind === 'VALUE_NODE') || v.refs.some((r) => r.kind === 'VALUE_NODE' && r.id === nodeId));

/** The classes a case carries: those of the metrics it compares. */
export function classesOf(metricKeys: readonly string[]): SensitivityClass[] {
  const out = new Set<SensitivityClass>(['GENERAL_MANAGEMENT']);
  for (const m of metricKeys) out.add(sensitivityOfMetric(m));
  return [...out].sort();
}

// ---------------------------------------------------------------- causal support

/**
 * Adds up pairs. SUPPORTED_PATH means an applicable path whose every claim is
 * SUPPORTED at the world's lens. Nothing is multiplied or weighted.
 */
export function causalSupportLevel(pairs: readonly Pick<PairSupport, 'state'>[]): { level: CausalSupportLevel; statement: string } {
  const states = pairs.map((p) => p.state);
  const supported = states.filter((s) => s === 'SUPPORTED_PATH').length;
  const contested = states.filter((s) => s === 'CONTESTED_PATH').length;
  if (pairs.length === 0) {
    return { level: 'MODEL_ONLY', statement: 'The intervention moves no input the model exposes, so there is no link to assess. The estimate is the model\'s alone.' };
  }
  if (supported === pairs.length) {
    return {
      level: 'CAUSALLY_SUPPORTED',
      statement:
        `Every link from what the intervention moves to what is compared has an applicable claim SUPPORTED by its evidence at this lens. ` +
        'That is evidence for the links, not identification of the effect: the value stays a model result.',
    };
  }
  if (supported > 0) {
    return {
      level: 'PARTIALLY_SUPPORTED',
      statement: `${supported} of ${pairs.length} links have an applicable SUPPORTED claim at this lens; the rest rest on the model's arithmetic alone.`,
    };
  }
  if (contested > 0) {
    return {
      level: 'CONTESTED',
      statement: `No link is supported, and ${contested} of ${pairs.length} rest on a claim that is contested, weakened or refuted at this lens.`,
    };
  }
  return {
    level: 'MODEL_ONLY',
    statement: 'No applicable, SUPPORTED causal claim links what the intervention moves to what is compared at this lens. The estimate is the executable model\'s arithmetic, labelled MODEL_COUNTERFACTUAL — not a causal finding.',
  };
}

export const pairNote = (state: PairState, fromLabel: string, toLabel: string): string => {
  switch (state) {
    case 'SUPPORTED_PATH':
      return `${fromLabel} → ${toLabel}: a path of SUPPORTED, applicable claims exists at this lens.`;
    case 'UNSUPPORTED_PATH':
      return `${fromLabel} → ${toLabel}: claims exist, but none of the paths is SUPPORTED at this lens.`;
    case 'CONTESTED_PATH':
      return `${fromLabel} → ${toLabel}: the claims on the path are contested, weakened or refuted at this lens.`;
    case 'OUTSIDE_SCOPE':
      return `${fromLabel} → ${toLabel}: a supported path exists but it does not apply to this case's whole scope.`;
    case 'NO_PATH':
      return `${fromLabel} → ${toLabel}: both are known to the causal graph, but no claim connects them at this lens.`;
    case 'NO_CAUSAL_KNOWLEDGE':
      return `${fromLabel} → ${toLabel}: the causal graph holds no variable for one of them at this lens. HELM does not infer a cause from the model.`;
  }
};

// ---------------------------------------------------------------- uncertainty

export type UncertaintyInput = {
  readonly lens: RetrospectiveLens;
  readonly estimability: 'ESTIMATED' | 'NOT_ESTIMABLE';
  readonly notEstimableReasons: readonly string[];
  readonly movedInputs: readonly MovedInput[];
  readonly hindsightInputs: readonly HindsightInput[];
  readonly completeness: string | null;
  readonly blockedReadings: number;
  readonly unavailableReadings: number;
};

/** What remains uncertain, in words. A list, never an interval or a probability. */
export function uncertaintyOf(i: UncertaintyInput): string[] {
  if (i.estimability === 'NOT_ESTIMABLE') {
    return [...i.notEstimableReasons, 'HELM does not invent a future for something the model does not represent.'];
  }
  const out: string[] = [COUNTERFACTUAL_METHOD_NOTE];
  const confidences = i.movedInputs.filter((m) => m.confidence !== null).map((m) => ({ label: m.nodeLabel, c: m.confidence as number }));
  if (confidences.length > 0) {
    const weakest = confidences.reduce((a, b) => (b.c < a.c ? b : a));
    out.push(`The estimate rests on ${i.movedInputs.length} stated input(s); the least confident is ${weakest.label} at ${weakest.c}. Confidences are shown, never multiplied.`);
  } else if (i.movedInputs.length > 0) {
    out.push(`The estimate rests on ${i.movedInputs.length} stated input(s) with no stated confidence.`);
  }
  if (i.movedInputs.some((m) => m.provenanceKind === 'MANAGEMENT_ASSUMPTION')) {
    out.push('Some inputs are management assumptions, not measurements.');
  }
  if (i.lens === 'WITH_HINDSIGHT') {
    out.push(
      `${i.hindsightInputs.length} fact(s) learned after the decision boundary were added. Each is a person's statement that it does not depend on which alternative was chosen; HELM cannot verify that.`,
    );
  }
  if (i.completeness && i.completeness !== 'COMPLETE') out.push(`The simulation was ${i.completeness}: not every value could be computed.`);
  if (i.blockedReadings > 0) out.push(`${i.blockedReadings} compared value(s) are BLOCKED by the model and are shown as unavailable, not estimated.`);
  else if (i.unavailableReadings > 0) out.push(`${i.unavailableReadings} compared value(s) do not exist in this world and are shown as unavailable.`);
  out.push(NOT_REPRESENTED);
  return out;
}

// ---------------------------------------------------------------- wording

/** "Under model …, and the N assumptions listed, the estimated counterfactual value of X is …" */
export function readingStatement(args: {
  label: string;
  value: string | null;
  unit: string | null;
  currency: string | null;
  model: { engineVersion: string; calculations: readonly string[] } | null;
  assumptions: number;
  lens: RetrospectiveLens;
}): string {
  if (args.value === null) return `${args.label}: not available in this counterfactual world; HELM does not estimate what the model does not compute.`;
  const model = args.model ? `model ${args.model.engineVersion} (${args.model.calculations.length} calculations)` : 'the model';
  const unit = args.currency ? ` ${args.currency}` : args.unit ? ` ${args.unit}` : '';
  const lens = args.lens === 'AS_KNOWN_THEN' ? 'as known then' : 'with hindsight';
  return `Under ${model}, and the ${args.assumptions} stated assumption(s) listed, the estimated counterfactual value of ${args.label} is ${args.value}${unit} (${lens}) — a model estimate, not what would have happened.`;
}

// ---------------------------------------------------------------- differences

/**
 * `minuend − subtrahend` as an exact decimal string, or null when either side
 * was not read. Only two differences exist in a comparison, each between
 * layers of the same kind; this is the arithmetic, not the policy.
 */
export function differenceOf(minuend: string | null, subtrahend: string | null): string | null {
  if (minuend === null || subtrahend === null) return null;
  try {
    return decimalToString(subtract(decimal(minuend), decimal(subtrahend)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- fingerprints

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val));

export function worldFingerprint(w: Pick<CounterfactualWorld, 'caseId' | 'lens' | 'method' | 'estimability' | 'scenario' | 'model' | 'readings' | 'movedInputs' | 'hindsightInputs' | 'anchorFork' | 'knowledge'>): string {
  return `cfw_${fnv1a64(
    canonical({
      c: w.caseId,
      l: w.lens,
      m: w.method,
      e: w.estimability,
      s: w.scenario,
      model: w.model,
      r: w.readings.map((r) => [r.metricKey, r.nodeId, r.status, r.value]),
      i: w.movedInputs.map((i) => [i.nodeId, i.source, i.value]),
      h: w.hindsightInputs.map((h) => [h.label, h.learnedAt, h.override.targetNodeId, String(h.override.value)]),
      f: w.anchorFork,
      k: w.knowledge,
    }),
  )}`;
}

/**
 * What a review is a review OF: the case, the worlds and the cells — never the instant it was read, so the same
 * comparison read on two days has one fingerprint, and a new world or a corrected reading has another.
 */
export function comparisonFingerprint(parts: { caseId: string; worldFingerprints: readonly (string | null)[]; rows: readonly (readonly (string | null)[])[] }): string {
  return `cfc_${fnv1a64(canonical(parts))}`;
}
