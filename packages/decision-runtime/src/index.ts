/**
 * @helm/decision-runtime — management decision infrastructure.
 *
 * What management is deciding, which futures were considered, what evidence
 * and assumptions supported each, what trade-offs were accepted, and what
 * commitment was made — preserved with the complete information state it was
 * made under. It records decisions; it does not make them.
 */

export * from './types.ts';
export * from './port.ts';
export { createDecisionRuntime, DECISION_STATEMENT, varianceMagnitude } from './runtime.ts';
export type { DecisionRuntimeOptions } from './runtime.ts';
export { createInMemoryDecisionStore } from './inMemoryStore.ts';
export type { InMemoryDecisionStoreOptions } from './inMemoryStore.ts';
export { snapshotFingerprint, commitmentFingerprint } from './fingerprint.ts';
export { evaluateCriteria, weightedView, pickCriterionValue, WEIGHTED_VIEW_STATEMENT } from './criteria.ts';
export type { AlternativeState } from './criteria.ts';
export { buildTradeOffSpace, statedDominance, TRADE_OFF_STATEMENT } from './tradeoff.ts';
export { evaluateReadiness, READINESS_STATEMENT } from './readiness.ts';
export { buildMeridianDecision, MERIDIAN_MANAGEMENT_QUESTION } from './meridianDecision.ts';
export type { MeridianDecisionResult } from './meridianDecision.ts';
