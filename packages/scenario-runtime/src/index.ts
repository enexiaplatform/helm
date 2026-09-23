/**
 * @helm/scenario-runtime — branching enterprise future states.
 *
 * Creates, simulates, compares and preserves isolated, reproducible,
 * explainable futures over the propagation engine, without mutating the
 * baseline and without choosing between them.
 */

export * from './types.ts';
export * from './port.ts';
export { createScenarioRuntime } from './runtime.ts';
export type { ScenarioRuntimeOptions } from './runtime.ts';
export { createInMemoryScenarioStore } from './inMemoryStore.ts';
export type { InMemoryScenarioStoreOptions } from './inMemoryStore.ts';
export { scenarioFingerprint } from './fingerprint.ts';
export { effectiveOverrides, toOverlay, appliesTo } from './overlay.ts';
export type { RevisionLink } from './overlay.ts';
export { evaluateConstraints, constraintSubjects } from './constraints.ts';
export { compareStates, interpret, COMPARISON_STATEMENT } from './comparison.ts';
export type { ComparedState } from './comparison.ts';
export {
  Q4_2026,
  Q1_2027,
  buildMeridianScenarios,
  meridianCanonicalScenarios,
  meridianConstraintsV1,
  meridianStateFrame,
} from './meridianScenarios.ts';
export type { CanonicalOverrideSpec, CanonicalScenarioSpec } from './meridianScenarios.ts';
