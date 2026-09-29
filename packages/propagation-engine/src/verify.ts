/**
 * Trace verification — re-deriving a recorded run from its own trace.
 *
 * A calculation run is written by whoever executed it. In demo mode that is
 * the browser, and in cloud mode today it is still the client: a scenario run
 * stored in the database is a claim that the governed formulas, applied to
 * these recorded inputs, produced these outputs. This module checks that claim
 * without trusting it:
 *
 *   1. every CALCULATED / UNCHANGED step is recomputed with the REGISTERED
 *      calculation of the recorded key and version, from the traced inputs,
 *      and normalized exactly as the engine normalizes — the result must equal
 *      the recorded output, digit for digit;
 *   2. every input bound to a RUN OUTPUT must equal the raw output of the step
 *      in the same run that produced that observation;
 *   3. every input bound to a SOURCE OBSERVATION must equal the observation
 *      stored under that id, and the observation must have been recorded
 *      inside the run's knowledge boundary;
 *   4. every input that names a scenario override is returned for the caller to
 *      check against the sealed revision (the engine knows nothing of
 *      scenarios; the authority server does).
 *
 * A forged output, an edited input or a formula the registry does not know is
 * a PROBLEM, stated. Nothing is repaired and nothing is guessed. It is pure
 * over its inputs apart from the observation lookup it is given.
 */

import {
  canonicalNumeric,
} from './selection.ts';
import {
  decimal,
  normalize,
  overrideFromMetadata,
  policyFor,
  quantity,
  type EntityId,
  type Quantity,
  type Result,
  type Scope,
} from '@helm/shared';
import type { ValueMetricDefinition, ValueObservation } from '@helm/value-graph';
import { calculationRef, type CalculationRun, type CalculationStep, type OverrideTrace, type ResolvedInputs } from './types.ts';
import type { CalculationRegistry } from './registry.ts';

export type TraceVerificationInput = {
  readonly scope: Scope;
  readonly run: CalculationRun;
  readonly steps: readonly CalculationStep[];
  readonly registry: CalculationRegistry;
  readonly metricOf: (metricKey: string) => ValueMetricDefinition | null;
  readonly subjectOf: (nodeId: string) => EntityId | null;
  readonly observationOf: (observationId: string) => Promise<ValueObservation | null>;
};

export type TraceVerification = {
  readonly runId: string;
  readonly verified: boolean;
  readonly checkedSteps: number;
  readonly checkedInputs: number;
  /** Inputs that came from a scenario override — the caller checks them against the revision. */
  readonly overrides: readonly { readonly stepId: string; readonly input: string; readonly nodeId: string; readonly value: string; readonly override: OverrideTrace }[];
  readonly problems: readonly string[];
};

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && canonicalNumeric(a) === canonicalNumeric(b);

const exactOf = (o: ValueObservation): string => canonicalNumeric(String(o.numericValue ?? 0));

export async function verifyCalculationTrace(input: TraceVerificationInput): Promise<Result<TraceVerification>> {
  const { run, steps, registry } = input;
  const problems: string[] = [];
  const overrides: TraceVerification['overrides'][number][] = [];
  let checkedSteps = 0;
  let checkedInputs = 0;
  const knowledge = Date.parse(run.context.recordedThrough);

  // Raw output of every step, by the observation it wrote: what a RUN_OUTPUT input must equal.
  const rawByObservation = new Map<string, string>();
  for (const s of steps) {
    if (s.outputObservationId && s.outputValue !== null) rawByObservation.set(s.outputObservationId, s.outputValueRaw ?? s.outputValue);
  }

  for (const step of [...steps].sort((a, b) => a.sequence - b.sequence)) {
    if (step.status !== 'CALCULATED' && step.status !== 'UNCHANGED') continue;
    const where = `${step.calculationKey}@${step.calculationVersion} → ${step.outputMetricKey} (step ${step.sequence})`;
    const calc = registry.get(step.calculationKey, step.calculationVersion);
    if (!calc) {
      problems.push(`${where}: no registered calculation has this key and version.`);
      continue;
    }

    // --- 2, 3, 4: each traced input against where it says it came from ---
    const resolved: Record<string, Quantity> = {};
    let inputsOk = true;
    for (const t of step.inputs) {
      checkedInputs += 1;
      const parts = t.components ?? [
        { nodeId: t.nodeId, observationId: t.observationId, value: t.value, observationType: t.observationType, boundTo: t.boundTo === 'MIXED' ? undefined : t.boundTo, override: t.override },
      ];
      for (const p of parts) {
        if (p.override) {
          overrides.push({ stepId: step.id, input: t.name, nodeId: p.nodeId, value: p.value, override: p.override });
          continue;
        }
        if (p.boundTo === 'RUN_OUTPUT') {
          const raw = rawByObservation.get(p.observationId);
          if (raw === undefined) {
            problems.push(`${where}: input "${t.name}" claims a run output (${p.observationId}) no step of this run produced.`);
            inputsOk = false;
          } else if (!same(raw, p.value)) {
            problems.push(`${where}: input "${t.name}" is ${p.value}, but the step that produced it computed ${raw}.`);
            inputsOk = false;
          }
          continue;
        }
        const o = await input.observationOf(p.observationId);
        if (!o) {
          problems.push(`${where}: input "${t.name}" cites observation ${p.observationId}, which does not exist.`);
          inputsOk = false;
          continue;
        }
        if (o.nodeId !== p.nodeId) {
          problems.push(`${where}: input "${t.name}" cites observation ${p.observationId} of a different value node.`);
          inputsOk = false;
        }
        if (!same(exactOf(o), p.value)) {
          problems.push(`${where}: input "${t.name}" is ${p.value}, but observation ${p.observationId} holds ${exactOf(o)}.`);
          inputsOk = false;
        }
        if (Date.parse(o.recordedAt) > knowledge) {
          problems.push(`${where}: input "${t.name}" uses an observation recorded after the run's knowledge boundary.`);
          inputsOk = false;
        }
      }
      const q = quantity(decimal(t.value), t.unit, t.currency);
      if (!q.ok) {
        problems.push(`${where}: input "${t.name}" is not a valid quantity: ${q.error.message}`);
        inputsOk = false;
        continue;
      }
      resolved[t.name] = q.value;
    }
    if (!inputsOk) continue;

    // --- 1: recompute with the governed formula, normalize as the engine does ---
    const output = calc.compute(
      { scope: input.scope, asOf: new Date(run.context.effectiveAsOf), horizon: run.context.horizon, subjectEntityId: input.subjectOf(step.outputNodeId) },
      resolved as ResolvedInputs,
    );
    if (!output.ok) {
      problems.push(`${where}: the registered formula refuses the traced inputs: ${output.error.message}`);
      continue;
    }
    const metric = input.metricOf(calc.outputMetricKey);
    if (!metric) {
      problems.push(`${where}: output metric ${calc.outputMetricKey} is not registered.`);
      continue;
    }
    const normalized = normalize(output.value.amount, policyFor(output.value.unit, output.value.currency, overrideFromMetadata(metric.metadata)));
    checkedSteps += 1;
    if (!same(normalized.normalizedText, step.outputValue)) {
      problems.push(
        `${where}: recorded ${step.outputValue ?? 'nothing'}, but ${calculationRef(calc)} over the traced inputs gives ${normalized.normalizedText}.`,
      );
    }
    if (output.value.unit !== step.outputUnit || (output.value.currency ?? null) !== (step.outputCurrency ?? null)) {
      problems.push(`${where}: recorded unit ${step.outputUnit} ${step.outputCurrency ?? ''} disagrees with the formula's ${output.value.unit} ${output.value.currency ?? ''}.`);
    }
  }

  return {
    ok: true,
    value: {
      runId: run.id,
      verified: problems.length === 0,
      checkedSteps,
      checkedInputs,
      overrides,
      problems,
    },
  };
}
