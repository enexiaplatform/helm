/**
 * @helm/causal-runtime — the Enterprise Causal Graph.
 *
 * What the enterprise has EVIDENCE to believe influences real-world outcomes:
 * scoped causal claims, the evidence for and against each, an explicit
 * evidence hierarchy and status policy, and a two-time reconstruction of what
 * management believed at any earlier moment — kept apart from the semantic
 * graph, the calculation graph, correlation and coincidence.
 *
 *                 CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP
 */

export * from './types.ts';
export * from './port.ts';
export { CAUSAL_EVIDENCE_POLICY, EVIDENCE_CEILING, EVIDENCE_CEILING_REASON, effectiveStrength, temporalOrderOf, assess, decide, atLeast } from './policy.ts';
export { applicabilityOf } from './scope.ts';
export { createCausalGraph, evaluateAt, claimClasses, referencedDecisions } from './runtime.ts';
export type { CausalGraphOptions } from './runtime.ts';
export { createInMemoryCausalStore } from './inMemoryStore.ts';
export type { InMemoryCausalStoreOptions } from './inMemoryStore.ts';
export {
  explainTwinDifferenceCausally,
  claimsReferencing,
  causalAttention,
  CAUSAL_ATTENTION_RULES_VERSION,
  DEPENDENCY_IS_NOT_CAUSALITY,
} from './integration.ts';
export type { TwinCausalExplanation, CausalInvestigationOfInput, MovedInput, CausalAttention } from './integration.ts';
export { runMeridianCausalStory, DEMO_CAUSAL_LABEL, MERIDIAN_CAUSAL_TIMES } from './meridianCausal.ts';
export type { MeridianCausalDeps, MeridianCausalStory } from './meridianCausal.ts';
