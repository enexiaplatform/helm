/**
 * Reading the persistent world — observation selection, input fingerprints, and
 * the truth-layer reader.
 *
 * Separated from the engine because three different callers need exactly the
 * same answer to "which observation is this?": the engine resolving an input,
 * the freshness check re-resolving it, and a reader asking what Finance said
 * versus what the model computed. If each had its own copy of the rule, they
 * would drift, and a freshness check that disagreed with the run it was checking
 * would report staleness that was never there.
 */

import {
  CalculationErrors,
  policyOrder,
  type ObservationPolicy,
  type TracedInput,
} from './types.ts';
import {
  decimal,
  describeInterval,
  fail,
  intervalIs,
  ok,
  periodKey,
  subtract,
  toString as decToString,
  type EntityId,
  type Period,
  type Result,
  type Scope,
} from '@helm/shared';
import type { ObservationType, ValueGraph, ValueObservation } from '@helm/value-graph';

/**
 * The two lenses a read looks through. See `CalculationRunContext`.
 *
 *   effectiveAsOf     business/effective time being modelled
 *   recordedThrough   the knowledge cutoff: nothing recorded after it is seen
 */
export type Lens = { readonly effectiveAsOf: Date; readonly recordedThrough: Date };

/**
 * Chooses ONE observation, by an explicit type order and then by time. Never
 * "the latest" (§5): an actual, a forecast and a target are different kinds of
 * claim, and the caller says which it wants.
 *
 * PERIOD IDENTITY (ADR-0020). A claim about a period is a claim about THAT
 * period. When the caller names a period, only a period claim about exactly
 * that interval answers; a point-in-time claim answers "as of" the effective
 * lens, which is the carry-forward an input declares by asking for the
 * `current` horizon. When the caller names no period and the candidates speak
 * to several, the read refuses rather than guessing — the old rule answered
 * with whichever period started last, so a node holding Q4 and Q1 forecasts
 * gave next year's number to every question about this quarter.
 */
export async function selectObservation(
  valueGraph: ValueGraph,
  scope: Scope,
  nodeId: string,
  order: readonly ObservationType[],
  lens: Lens,
  scenarioEntityId: EntityId | null,
  period: Period | null = null,
): Promise<Result<ValueObservation | null>> {
  // A scenario read sees scenario values AND reality; any other read sees only
  // reality, so a scenario can never leak into a baseline number.
  const scenarioArg = order.includes('SCENARIO') ? undefined : null;
  const all = await valueGraph.getObservations(scope, {
    nodeId,
    scenarioEntityId: scenarioArg,
    limit: 200,
  });
  if (!all.ok) return all;

  const effectiveCutoff = lens.effectiveAsOf.getTime();
  const knowledgeCutoff = lens.recordedThrough.getTime();
  const ms = (t: string): number => new Date(t).getTime();

  /**
   * Was this claim KNOWN when the read's boundary was set? RECORD time only.
   *
   * Not `observedAt`: a source can assert something at 09:00 that HELM does not
   * learn until 20:16, and a run that started at 20:15 could not have known it.
   * Record time is the only honest answer to "what was HELM allowed to know",
   * and it is what makes the boundary reproducible on replay.
   */
  const knownBy = (o: ValueObservation): number => ms(o.recordedAt);

  /**
   * Which claim SPEAKS TO the latest moment. A point-in-time observation anchors
   * on `effectiveAt`, a period one on `periodStart`. Only ever compared between
   * claims about the SAME period (or between point claims): period filtering
   * happens first, so this can no longer pick the furthest-out forecast.
   */
  const validAt = (o: ValueObservation): number =>
    ms(o.effectiveAt ?? o.periodStart ?? o.observedAt ?? o.recordedAt);
  const isPeriodClaim = (o: ValueObservation): boolean => o.periodStart !== null;
  const intervalKey = (o: ValueObservation): string => `${o.periodStart}|${o.periodEnd}`;

  // Period claims that were eligible in every other respect but are about a
  // different period. Reported, so a reader learns the data is about the wrong
  // quarter instead of hunting for data that is not missing.
  const wrongPeriod: ValueObservation[] = [];

  for (const type of order) {
    let candidates = all.value.filter((o) => o.observationType === type);
    if (type === 'SCENARIO') {
      candidates = candidates.filter((o) => o.scenarioEntityId === scenarioEntityId);
    } else {
      candidates = candidates.filter((o) => o.scenarioEntityId === null);
    }
    // KNOWLEDGE BOUNDARY: nothing recorded after the cutoff enters the read.
    candidates = candidates.filter((o) => knownBy(o) <= knowledgeCutoff);
    // EFFECTIVE BOUNDARY: a point-in-time fact cannot describe the modelled
    // instant if it only becomes true later. Period claims are exempt — being
    // about a future period is the entire point of a forecast.
    candidates = candidates.filter(
      (o) => o.effectiveAt === null || ms(o.effectiveAt) <= effectiveCutoff,
    );
    if (candidates.length === 0) continue;

    // PERIOD BOUNDARY.
    const periodic = candidates.filter(isPeriodClaim);
    const points = candidates.filter((o) => !isPeriodClaim(o));
    if (period) {
      const matching = periodic.filter((o) => intervalIs(period, o.periodStart, o.periodEnd));
      if (matching.length > 0) {
        candidates = matching;
      } else if (points.length > 0) {
        candidates = points;
      } else {
        wrongPeriod.push(...periodic);
        continue;
      }
    } else {
      const intervals = new Set(periodic.map(intervalKey));
      if (intervals.size > 1) {
        return fail(
          CalculationErrors.AMBIGUOUS_PERIOD,
          `Value node ${nodeId} has ${type} observations for ${intervals.size} different ` +
            `periods (${[...new Set(periodic.map((o) => describeInterval(o.periodStart, o.periodEnd)))].join(', ')}) ` +
            'and the read did not say which period it is about. HELM will not pick one.',
          {
            nodeId,
            observationType: type,
            periods: [...new Set(periodic.map((o) => describeInterval(o.periodStart, o.periodEnd)))],
          },
        );
      }
    }

    const bestValid = Math.max(...candidates.map(validAt));
    let winners = candidates.filter((o) => validAt(o) === bestValid);

    // Same kind of claim, same valid time: the more recently RECORDED belief
    // supersedes. That is what record time is for — not an arbitrary pick.
    if (winners.length > 1) {
      const bestRecord = Math.max(...winners.map((o) => ms(o.recordedAt)));
      winners = winners.filter((o) => ms(o.recordedAt) === bestRecord);
    }

    if (winners.length > 1) {
      // Identical in valid time AND record time. Nothing distinguishes them, so
      // choosing would make the result unexplainable.
      return fail(
        CalculationErrors.AMBIGUOUS_INPUT,
        `Value node ${nodeId} has ${winners.length} ${type} observations with the same ` +
          'valid time and the same record time. HELM will not pick one arbitrarily.',
        { nodeId, observationType: type, candidates: winners.map((w) => w.id) },
      );
    }
    return ok(winners[0]);
  }

  if (period && wrongPeriod.length > 0) {
    const found = [...new Set(wrongPeriod.map((o) => describeInterval(o.periodStart, o.periodEnd)))];
    return fail(
      CalculationErrors.TIME_CONTEXT_MISMATCH,
      `Value node ${nodeId} has claims for ${found.join(', ')} but none for ${periodKey(period)}. ` +
        'A claim about one period does not answer a question about another.',
      { nodeId, requiredPeriod: periodKey(period), foundPeriods: found },
    );
  }
  return ok(null);
}

// ------------------------------------------------------------- fingerprints

/**
 * The canonical text of a numeric value.
 *
 * `0.7`, `0.70` and `0.700` are one number, and a fingerprint that treated them
 * as three would report a value as stale because somebody's export added a
 * trailing zero. Parsing through Decimal and printing back gives one spelling
 * per number: no trailing zeros, no leading `+`, `-0` folded to `0`.
 */
export function canonicalNumeric(value: string): string {
  try {
    const text = decToString(decimal(value));
    return text === '-0' ? '0' : text;
  } catch {
    // Not a number at all. Returned as-is so a fingerprint still distinguishes
    // it, rather than collapsing every unparseable value to one bucket.
    return value;
  }
}

/**
 * Deterministic fingerprint of one computation: the calculation reference, the
 * horizon, the scenario and the exact inputs — each input by name, the
 * observation it came from, and its CANONICAL value and unit.
 *
 * `effectiveAsOf` and `recordedThrough` are deliberately excluded. They are the
 * lenses that SELECTED the inputs; if the same observations with the same values
 * were selected, the computation was the same. Including them made every derived
 * value permanently stale the moment the clock moved.
 */
export function inputFingerprint(
  calculationRef: string,
  context: { horizon: string; scenario: string; period?: Period | null },
  inputs: readonly Pick<TracedInput, 'name' | 'observationId' | 'value' | 'unit' | 'currency'>[],
): string {
  const canonical = [
    calculationRef,
    context.horizon,
    context.scenario,
    // Appended only when stated, so every fingerprint recorded before period
    // identity existed is still reproduced exactly.
    ...(context.period ? [`period=${periodKey(context.period)}`] : []),
    ...[...inputs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (i) =>
          `${i.name}=${i.observationId}:${canonicalNumeric(i.value)}${i.unit}${i.currency ?? ''}`,
      ),
  ].join('|');

  // FNV-1a: small, dependency-free, and stable across runtimes. A fingerprint
  // detects change; it is not a security boundary.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, '0')}_${canonical.length}`;
}

// ------------------------------------------------------------- truth layers

export type TruthLayerReading = {
  readonly nodeId: string;
  /** What the business says, under the requested source policy. */
  readonly source: {
    readonly policy: ObservationPolicy;
    readonly observation: ValueObservation | null;
    readonly value: string | null;
  };
  /** What a HELM model computed, from persisted DERIVED observations. */
  readonly model: {
    readonly observation: ValueObservation | null;
    readonly value: string | null;
    readonly calculation: string | null;
  };
  /**
   * model − source, when both exist and share a unit and currency. Null rather
   * than a guess when they cannot be compared — a variance across two
   * currencies would need an FX rate HELM does not have.
   */
  readonly variance: string | null;
  readonly unit: string | null;
  readonly currency: string | null;
};

/** Exact value of an observation: the stored exact string, else its number. */
function exactOf(o: ValueObservation): string {
  const exact = o.metadata?.exactValue;
  if (typeof exact === 'string') return canonicalNumeric(exact);
  return canonicalNumeric(String(o.numericValue ?? 0));
}

/**
 * Business truth and model truth, side by side, never merged.
 *
 * This exists to make one statement possible that the earlier baseline policy
 * made impossible:
 *
 *     Official forecast   5.00B
 *     HELM model output   4.70B
 *     Variance           -0.30B
 *
 * Neither number is promoted over the other. The reader decides what the gap
 * means; HELM's job is to show that there is one and where each side came from.
 */
export async function readTruthLayers(
  valueGraph: ValueGraph,
  scope: Scope,
  nodeId: string,
  lens: Lens,
  sourcePolicy: ObservationPolicy = 'SOURCE_TRUTH',
  period: Period | null = null,
): Promise<Result<TruthLayerReading>> {
  if (sourcePolicy === 'MODEL_OUTPUT') {
    return fail(
      CalculationErrors.INVALID_ASSUMPTION,
      'The source side of a truth-layer reading cannot be MODEL_OUTPUT — that ' +
        'would compare the model with itself.',
    );
  }

  const source = await selectObservation(
    valueGraph,
    scope,
    nodeId,
    policyOrder[sourcePolicy],
    lens,
    null,
    period,
  );
  if (!source.ok) return source;
  const model = await selectObservation(
    valueGraph,
    scope,
    nodeId,
    policyOrder.MODEL_OUTPUT,
    lens,
    null,
    period,
  );
  if (!model.ok) return model;

  const s = source.value;
  const m = model.value;
  const comparable =
    s !== null && m !== null && s.unitType === m.unitType && s.currency === m.currency;

  const variance = comparable
    ? canonicalNumeric(decToString(subtract(decimal(exactOf(m)), decimal(exactOf(s)))))
    : null;

  const calc = m?.metadata?.derivedByCalculation;
  return ok({
    nodeId,
    source: { policy: sourcePolicy, observation: s, value: s ? exactOf(s) : null },
    model: {
      observation: m,
      value: m ? exactOf(m) : null,
      calculation: typeof calc === 'string' ? calc : null,
    },
    variance,
    unit: (s ?? m)?.unitType ?? null,
    currency: (s ?? m)?.currency ?? null,
  });
}
