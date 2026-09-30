/**
 * The pattern policy — `helm-genome-pattern@1` (ADR-0028 §6) — and the
 * observation of a pattern's characteristic in an episode's own records.
 *
 * Two commitments shape it:
 *
 *   1. A pattern is a description of RECURRENCE, so counting is inherent — but
 *      the thresholds are stated, named and versioned, only COMPARABLE episodes
 *      count, every status carries the limitation that episodes are the ones
 *      RECORDED, and one case is labelled weak, never a pattern.
 *   2. HELM verifies, it does not discover. Because a pattern's conditions and
 *      characteristic are structured, HELM can classify any episode against it
 *      from its own records; a person's link must AGREE with that
 *      classification. HELM never links an episode itself, and never records
 *      support for an episode its own records contradict.
 *
 * No probability, no score, and nothing about a person.
 */

import type { DecisionAssumption, DecisionChallenge, DecisionOutcomeReview, DecisionAlternative } from '@helm/decision-runtime';
import type { Classification, ConditionFeature, PatternCharacteristic, PatternConditions, PatternStatus, SituationFeatures } from './types.ts';

export const GENOME_PATTERN_POLICY = 'helm-genome-pattern@1';
export const RECURRING_MIN_SUPPORTING = 2;
export const SUPPORTED_MIN_SUPPORTING = 3;
export const SUPPORTED_MIN_DISTINCT_CONTEXTS = 2;

export type LinkedEpisode = {
  readonly episodeId: string;
  readonly decisionId: string;
  /** Distinguishes contexts: the sorted anchor entities the episode was about. */
  readonly contextKey: string;
};

export type PatternCoverage = {
  /** Recorded episodes in the pattern's scope that satisfy its conditions. */
  readonly matching: number;
  readonly linked: number;
  /** Matching episodes nobody has linked yet — the pattern has not been reviewed against them. */
  readonly unlinkedMatching: readonly string[];
};

export type PatternDecision = {
  readonly status: PatternStatus;
  readonly reasons: readonly string[];
  readonly weak: boolean;
};

/**
 * First match wins:
 *
 *   retired                                                  → RETIRED
 *   any linked CONTRADICTORY episode                         → CONTESTED
 *   ≥ 3 supporting (distinct decisions), ≥ 2 contexts        → SUPPORTED
 *   ≥ 2 supporting (distinct decisions)                      → RECURRING
 *   otherwise (one case, or none)                            → EMERGING (weak)
 */
export function decidePattern(input: {
  supporting: readonly LinkedEpisode[];
  contradictory: readonly LinkedEpisode[];
  contextual: number;
  retired: { retired: boolean; reason: string | null };
  coverage: PatternCoverage;
}): PatternDecision {
  const decisions = new Set(input.supporting.map((e) => e.decisionId));
  const contexts = new Set(input.supporting.map((e) => e.contextKey));
  const s = decisions.size;
  const c = new Set(input.contradictory.map((e) => e.decisionId)).size;
  const coverage =
    `${input.coverage.linked} of ${input.coverage.matching} recorded episode(s) that match the conditions are linked` +
    (input.coverage.unlinkedMatching.length > 0 ? `; ${input.coverage.unlinkedMatching.length} matching episode(s) have not been reviewed against this pattern.` : '.');
  if (input.retired.retired) {
    return { status: 'RETIRED', weak: false, reasons: [`Retired: ${input.retired.reason ?? 'no reason given'}.`] };
  }
  if (c > 0) {
    return {
      status: 'CONTESTED',
      weak: false,
      reasons: [
        `${s} supporting and ${c} contradictory episode(s) in the pattern's scope: the characteristic held in some comparable situations and not in others.`,
        'A contradictory episode does not vanish under a majority; the pattern is a description of what recurred, not of what must.',
        coverage,
      ],
    };
  }
  if (s >= SUPPORTED_MIN_SUPPORTING && contexts.size >= SUPPORTED_MIN_DISTINCT_CONTEXTS) {
    return {
      status: 'SUPPORTED',
      weak: false,
      reasons: [`${s} supporting episodes of distinct decisions across ${contexts.size} contexts, none contradictory. Recurrence, not proof.`, coverage],
    };
  }
  if (s >= RECURRING_MIN_SUPPORTING) {
    return {
      status: 'RECURRING',
      weak: false,
      reasons: [
        `${s} supporting episodes of distinct decisions, none contradictory.` +
          (s >= SUPPORTED_MIN_SUPPORTING ? ` They share ${contexts.size} context, so it is not yet SUPPORTED.` : ` SUPPORTED needs ${SUPPORTED_MIN_SUPPORTING} across ${SUPPORTED_MIN_DISTINCT_CONTEXTS} contexts.`),
        coverage,
      ],
    };
  }
  return {
    status: 'EMERGING',
    weak: true,
    reasons: [
      s === 1 ? 'One supporting episode. One case is a hint, not a pattern; it is labelled weak.' : 'No supporting episode yet: the pattern is a hypothesis.',
      coverage,
    ],
  };
}

// ---------------------------------------------------------------- observation

/** The records an observation reads: process facts at the commitment and outcome reviews known at a lens. */
export type ObservableFacts = {
  readonly committedAt: string;
  readonly assumptions: readonly Pick<DecisionAssumption, 'id' | 'criticality' | 'owner'>[];
  readonly challenges: readonly Pick<DecisionChallenge, 'id' | 'status' | 'resolvedAt'>[];
  readonly alternatives: readonly Pick<DecisionAlternative, 'id' | 'status'>[];
  readonly reviews: readonly DecisionOutcomeReview[];
};

export type Observation = { readonly result: 'EXHIBITS' | 'DOES_NOT_EXHIBIT' | 'NOT_OBSERVABLE'; readonly detail: string };

const signOf = (canonical: string): -1 | 0 | 1 => {
  const t = canonical.trim();
  if (/^-?0+(\.0+)?$/.test(t)) return 0;
  return t.startsWith('-') ? -1 : 1;
};

export function observeCharacteristic(ch: PatternCharacteristic, f: ObservableFacts): Observation {
  const latest = [...f.reviews].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt)).pop();
  switch (ch.kind) {
    case 'OUTCOME_VS_EXPECTATION': {
      const v = latest?.variances.find((x) => x.metricKey === ch.metricKey);
      if (!latest) return { result: 'NOT_OBSERVABLE', detail: 'No outcome review has been recorded yet.' };
      if (!v || v.variance === null) return { result: 'NOT_OBSERVABLE', detail: `The outcome review states no variance for ${ch.metricKey}.` };
      const sign = signOf(v.variance);
      const actual = sign < 0 ? 'ACTUAL_BELOW_EXPECTED' : sign > 0 ? 'ACTUAL_ABOVE_EXPECTED' : 'ACTUAL_EQUALS_EXPECTED';
      const shown = `${ch.metricKey}: expected ${v.expected}, actual ${v.actual}, variance ${v.variance}`;
      return actual === ch.direction ? { result: 'EXHIBITS', detail: shown } : { result: 'DOES_NOT_EXHIBIT', detail: shown };
    }
    case 'ASSUMPTION_OUTCOME': {
      if (!latest || latest.assumptionResults.length === 0) return { result: 'NOT_OBSERVABLE', detail: 'No assumption has been reviewed yet.' };
      const byId = new Map(f.assumptions.map((a) => [a.id, a]));
      const hits = latest.assumptionResults.filter(
        (r) => r.outcome === ch.outcome && (ch.criticality === 'ANY' || byId.get(r.assumptionId)?.criticality === ch.criticality),
      );
      const shown = `${latest.assumptionResults.length} assumption(s) reviewed, ${hits.length} ${ch.outcome} of ${ch.criticality} criticality`;
      return hits.length > 0 ? { result: 'EXHIBITS', detail: shown } : { result: 'DOES_NOT_EXHIBIT', detail: shown };
    }
    case 'PROCESS_FEATURE': {
      if (ch.feature === 'CRITICAL_ASSUMPTION_UNOWNED') {
        const n = f.assumptions.filter((a) => a.criticality === 'CRITICAL' && a.owner === null).length;
        return { result: n > 0 ? 'EXHIBITS' : 'DOES_NOT_EXHIBIT', detail: `${n} critical assumption(s) had no owner at commitment` };
      }
      if (ch.feature === 'CHALLENGE_OPEN_AT_COMMITMENT') {
        const n = f.challenges.filter((c) => c.resolvedAt === null || c.resolvedAt > f.committedAt).length;
        return { result: n > 0 ? 'EXHIBITS' : 'DOES_NOT_EXHIBIT', detail: `${n} challenge(s) were unresolved at commitment` };
      }
      const n = f.alternatives.filter((a) => a.status === 'UNMODELLED').length;
      return { result: n > 0 ? 'EXHIBITS' : 'DOES_NOT_EXHIBIT', detail: `${n} alternative(s) were considered without a simulated future` };
    }
  }
}

// ---------------------------------------------------------------- conditions

const conditionValues = (features: SituationFeatures, name: ConditionFeature): readonly string[] => features.values[name];

/** Every stated condition must hold; each holds if the episode shares any of its listed values. */
export function conditionsHold(conditions: PatternConditions, features: SituationFeatures): { holds: boolean; failed: readonly string[] } {
  const failed: string[] = [];
  for (const [name, wanted] of Object.entries(conditions) as [ConditionFeature, readonly string[]][]) {
    if (!wanted || wanted.length === 0) continue;
    if (features.notStated.includes(name)) {
      failed.push(`${name} is not stated for this episode`);
      continue;
    }
    if (!conditionValues(features, name).some((v) => wanted.includes(v))) {
      failed.push(`${name} is [${conditionValues(features, name).join(', ') || '—'}], the pattern needs one of [${wanted.join(', ')}]`);
    }
  }
  return { holds: failed.length === 0, failed };
}

/** A link's stance must agree with what HELM's own records say (ADR-0028 §5). */
export function stanceAgrees(stance: 'SUPPORTING_EPISODE' | 'CONTRADICTORY_EPISODE' | 'CONTEXTUAL_EPISODE', observed: Classification): { ok: boolean; message: string } {
  if (stance === 'CONTEXTUAL_EPISODE') return { ok: true, message: '' };
  if (stance === 'SUPPORTING_EPISODE') {
    return observed === 'SUPPORTS'
      ? { ok: true, message: '' }
      : {
          ok: false,
          message:
            observed === 'CONTRADICTS'
              ? "The episode's own records show the opposite of the characteristic; it cannot be linked as supporting."
              : observed === 'OUT_OF_SCOPE'
                ? "The episode is outside the pattern's scope or conditions; link it as contextual."
                : 'The episode has no observable outcome for this characteristic yet; link it as contextual.',
        };
  }
  return observed === 'CONTRADICTS'
    ? { ok: true, message: '' }
    : {
        ok: false,
        message:
          observed === 'SUPPORTS'
            ? "The episode's own records show the characteristic; it cannot be linked as contradictory."
            : observed === 'OUT_OF_SCOPE'
              ? "The episode is outside the pattern's scope or conditions; a case outside it contradicts nothing. Link it as contextual."
              : 'The episode has no observable outcome for this characteristic yet; link it as contextual.',
      };
}
