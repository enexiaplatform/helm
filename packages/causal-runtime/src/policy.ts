/**
 * The evidence policy — `helm-causal-evidence@1` (ADR-0027).
 *
 * Deterministic and explainable. It answers one question: given the evidence
 * linked to a claim and known at a lens, what may HELM say about the claim?
 *
 * Three commitments shape it:
 *
 *   1. Evidence types are NOT equal. Each has a CEILING — the most it can
 *      establish however confidently it is graded. Management judgement is
 *      LOW; an uncontrolled intervention or a documented mechanism is MEDIUM;
 *      only a controlled or natural experiment can be HIGH. Citing a
 *      correlation caps evidence at LOW.
 *   2. COUNT NEVER DECIDES. Any number of LOW supports never makes a claim
 *      SUPPORTED; one HIGH support can. Contradiction is weighed by its
 *      strength, not outvoted.
 *   3. ORDER ELIMINATES, IT DOES NOT PROVE. Evidence that shows the candidate
 *      cause AFTER the effect cannot support the claim — it counts against
 *      it (TEMPORAL_CONFLICT). The right order proves nothing on its own.
 *
 * There is no score, no averaging and no probability.
 */

import type {
  CausalEvidence,
  ClaimStatus,
  ConfidenceLevel,
  EvidenceAssessment,
  EvidenceLink,
  EvidenceType,
  StrengthLevel,
  TemporalOrder,
} from './types.ts';

export const CAUSAL_EVIDENCE_POLICY = 'helm-causal-evidence@1';

/** The evidence hierarchy: the highest strength each type can carry (ADR-0027 §2). */
export const EVIDENCE_CEILING: Readonly<Record<EvidenceType, StrengthLevel>> = {
  CONTROLLED_EXPERIMENT: 'HIGH',
  NATURAL_EXPERIMENT: 'HIGH',
  INTERVENTION: 'MEDIUM',
  LONGITUDINAL_OBSERVATION: 'MEDIUM',
  REPEATED_PATTERN: 'MEDIUM',
  STATISTICAL_ANALYSIS: 'MEDIUM',
  PROCESS_MECHANISM: 'MEDIUM',
  EXTERNAL_RESEARCH: 'MEDIUM',
  CONTRADICTORY_CASE: 'MEDIUM',
  MANAGEMENT_EXPERTISE: 'LOW',
};

/** Why each ceiling is where it is — shown next to every assessment. */
export const EVIDENCE_CEILING_REASON: Readonly<Record<EvidenceType, string>> = {
  CONTROLLED_EXPERIMENT: 'a controlled comparison separates the cause from everything else that changed',
  NATURAL_EXPERIMENT: 'a comparable untreated group stands in for the counterfactual',
  INTERVENTION: 'a deliberate change was made, but nothing else was held constant',
  LONGITUDINAL_OBSERVATION: 'the same population followed over time; confounders are not controlled',
  REPEATED_PATTERN: 'a pattern seen repeatedly; observational, so it cannot exclude a common cause',
  STATISTICAL_ANALYSIS: 'a reported statistical result; its method and limitations bound it',
  PROCESS_MECHANISM: 'documents how the effect is produced in this case, not how often or how much',
  EXTERNAL_RESEARCH: 'evidence from elsewhere; its validity in this scope is unknown',
  CONTRADICTORY_CASE: 'a documented case that went the other way; one case',
  MANAGEMENT_EXPERTISE: 'a person\'s judgement, not a measurement',
};

const RANK: Readonly<Record<StrengthLevel, number>> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
export const atLeast = (s: StrengthLevel, floor: StrengthLevel): boolean => RANK[s] >= RANK[floor];
const minStrength = (a: StrengthLevel, b: StrengthLevel): StrengthLevel => (RANK[a] <= RANK[b] ? a : b);

/** The strength the policy lets a piece of evidence carry. */
export function effectiveStrength(e: CausalEvidence): { ceiling: StrengthLevel; strength: StrengthLevel; note: string } {
  let ceiling = EVIDENCE_CEILING[e.type];
  let note = `${e.type} is capped at ${ceiling}: ${EVIDENCE_CEILING_REASON[e.type]}.`;
  if (e.correlationFindingId !== null && ceiling !== 'LOW') {
    ceiling = 'LOW';
    note = `It cites a correlation finding, so it is capped at LOW: correlation does not establish influence.`;
  }
  const strength = minStrength(e.assessedStrength, ceiling);
  if (strength !== e.assessedStrength) note += ` Assessed ${e.assessedStrength}; counted as ${strength}.`;
  return { ceiling, strength, note };
}

/** Temporal precedence, where the evidence states both times. */
export function temporalOrderOf(e: CausalEvidence): TemporalOrder {
  if (!e.causeObservedAt || !e.effectObservedAt) return 'NOT_STATED';
  const c = Date.parse(e.causeObservedAt);
  const f = Date.parse(e.effectObservedAt);
  if (c > f) return 'TEMPORAL_CONFLICT';
  if (c === f) return 'SIMULTANEOUS';
  return 'CAUSE_PRECEDES_EFFECT';
}

export function assess(link: EvidenceLink, evidence: CausalEvidence): EvidenceAssessment {
  const { ceiling, strength, note } = effectiveStrength(evidence);
  const temporal = temporalOrderOf(evidence);
  let countedAs: EvidenceAssessment['countedAs'] =
    link.stance === 'SUPPORTS' ? 'SUPPORT' : link.stance === 'CHALLENGES' ? 'CHALLENGE' : link.stance === 'CONTRADICTS' ? 'CONTRADICTION' : 'CONTEXT';
  let extra: string | null = null;
  if (temporal === 'TEMPORAL_CONFLICT' && countedAs === 'SUPPORT') {
    countedAs = 'CHALLENGE';
    extra =
      `TEMPORAL_CONFLICT: the candidate cause was observed (${evidence.causeObservedAt}) after the effect ` +
      `(${evidence.effectObservedAt}). A cause cannot follow its effect, so this evidence counts against the claim, not for it.`;
  } else if (temporal === 'CAUSE_PRECEDES_EFFECT' && countedAs === 'SUPPORT') {
    extra = 'The cause precedes the effect. That rules out an impossible order; it does not show influence.';
  }
  return { link, evidence, ceiling, strength, strengthNote: note, temporal, countedAs, note: extra };
}

const strongest = (xs: readonly EvidenceAssessment[]): StrengthLevel | null =>
  xs.reduce<StrengthLevel | null>((best, a) => (best === null || RANK[a.strength] > RANK[best] ? a.strength : best), null);

/**
 * The status rules, first match wins (ADR-0027 §3):
 *
 *   retired                                                   → RETIRED
 *   HIGH contradiction, no HIGH support                       → REFUTED
 *   material (≥ MEDIUM) challenge and material support        → CONTESTED
 *   material challenge, no material support                   → WEAKENED
 *   one HIGH support, or ≥ 2 MEDIUM supports of ≥ 2 types     → SUPPORTED
 *   some support and some (LOW) challenge                     → UNRESOLVED
 *   some support only                                         → HYPOTHESIS (weakly supported)
 *   only LOW challenge, or only context                       → UNRESOLVED
 *   nothing                                                   → HYPOTHESIS
 */
export function decide(
  assessments: readonly EvidenceAssessment[],
  retired: { retired: boolean; reason: string | null },
): { status: ClaimStatus; confidence: ConfidenceLevel; reasons: string[] } {
  const supports = assessments.filter((a) => a.countedAs === 'SUPPORT');
  const against = assessments.filter((a) => a.countedAs === 'CHALLENGE' || a.countedAs === 'CONTRADICTION');
  const contradictions = assessments.filter((a) => a.countedAs === 'CONTRADICTION');
  const context = assessments.filter((a) => a.countedAs === 'CONTEXT');
  const maxSupport = strongest(supports);
  const maxAgainst = strongest(against);
  const maxContradiction = strongest(contradictions);
  const conflicts = assessments.filter((a) => a.temporal === 'TEMPORAL_CONFLICT').length;
  const reasons: string[] = [];
  if (conflicts > 0) reasons.push(`${conflicts} piece(s) of evidence put the cause after the effect (TEMPORAL_CONFLICT).`);

  if (retired.retired) {
    return { status: 'RETIRED', confidence: 'NONE', reasons: [`Retired: ${retired.reason ?? 'no reason given'}.`, ...reasons] };
  }
  if (maxContradiction === 'HIGH' && maxSupport !== 'HIGH') {
    return { status: 'REFUTED', confidence: 'NONE', reasons: [...reasons, 'HIGH-strength evidence contradicts the claim and no evidence of equal strength supports it.'] };
  }
  const materialSupport = maxSupport !== null && atLeast(maxSupport, 'MEDIUM');
  const materialAgainst = maxAgainst !== null && atLeast(maxAgainst, 'MEDIUM');
  if (materialAgainst && materialSupport) {
    return {
      status: 'CONTESTED',
      confidence: 'LOW',
      reasons: [...reasons, `Credible evidence points both ways: strongest support ${maxSupport}, strongest challenge ${maxAgainst}. Neither is outvoted by counting.`],
    };
  }
  if (materialAgainst) {
    return {
      status: 'WEAKENED',
      confidence: supports.length > 0 ? 'LOW' : 'NONE',
      reasons: [...reasons, `${maxAgainst} evidence challenges the claim and no evidence of at least MEDIUM strength supports it.`],
    };
  }
  const mediumTypes = new Set(supports.filter((a) => atLeast(a.strength, 'MEDIUM')).map((a) => a.evidence.type));
  if (maxSupport === 'HIGH' || mediumTypes.size >= 2) {
    const lowAgainst = against.length;
    reasons.push(
      maxSupport === 'HIGH'
        ? 'Supported by HIGH-strength evidence.'
        : `Supported by MEDIUM-strength evidence of ${mediumTypes.size} independent kinds (${[...mediumTypes].sort().join(', ')}).`,
    );
    if (lowAgainst > 0) reasons.push(`${lowAgainst} LOW-strength challenge(s) noted; none is material.`);
    return { status: 'SUPPORTED', confidence: maxSupport === 'HIGH' && against.length === 0 ? 'HIGH' : 'MODERATE', reasons };
  }
  if (supports.length > 0 && against.length > 0) {
    return {
      status: 'UNRESOLVED',
      confidence: 'LOW',
      reasons: [...reasons, `Weak evidence points both ways (strongest support ${maxSupport}, strongest challenge ${maxAgainst}); HELM does not know yet.`],
    };
  }
  if (supports.length > 0) {
    const n = supports.length;
    return {
      status: 'HYPOTHESIS',
      confidence: 'LOW',
      reasons: [
        ...reasons,
        `Weakly supported: ${n} supporting item(s), strongest ${maxSupport}. ` +
          'SUPPORTED needs one HIGH item or MEDIUM items of two independent kinds — more of the same does not add up.',
      ],
    };
  }
  if (against.length > 0 || context.length > 0) {
    return { status: 'UNRESOLVED', confidence: 'NONE', reasons: [...reasons, 'Evidence has been examined and none of it supports the claim; HELM does not know yet.'] };
  }
  return { status: 'HYPOTHESIS', confidence: 'NONE', reasons: ['No evidence yet. The claim is a hypothesis.'] };
}
