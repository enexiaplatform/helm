/**
 * @helm/counterfactual-runtime — the Counterfactual Engine.
 *
 * What might have happened under a different intervention, GIVEN what actually
 * happened: an ex-post question anchored to the historical decision boundary,
 * answered in two retrospective lenses that are never blended (as known then,
 * with hindsight), estimated by the executable model and labelled as such,
 * with causal support judged separately from the Causal Graph and the actual
 * world laid beside the alternatives in layers that are never collapsed.
 *
 *     Scenario ≠ Counterfactual · AS_KNOWN_THEN ≠ WITH_HINDSIGHT
 *     Decision Process Quality ≠ Outcome Quality
 */

export * from './types.ts';
export * from './port.ts';
export {
  COUNTERFACTUAL_METHOD_NOTE,
  NOT_REPRESENTED,
  IMPORTANT_NOT_A_VERDICT,
  LENS_NEVER_BLENDED,
  variableBindsTo,
  classesOf,
  causalSupportLevel,
  pairNote,
  uncertaintyOf,
  readingStatement,
  differenceOf,
  worldFingerprint,
  comparisonFingerprint,
} from './policy.ts';
export type { UncertaintyInput } from './policy.ts';
export { createCounterfactualRuntime } from './runtime.ts';
export type { CounterfactualRuntimeOptions, CounterfactualSources } from './runtime.ts';
export { createInMemoryCounterfactualStore } from './inMemoryStore.ts';
export type { InMemoryCounterfactualStoreOptions } from './inMemoryStore.ts';
export { runMeridianCounterfactualStory, DEMO_COUNTERFACTUAL_LABEL, MERIDIAN_COUNTERFACTUAL_TIMES } from './meridianCounterfactual.ts';
export type { MeridianCounterfactualDeps, MeridianCounterfactualStory } from './meridianCounterfactual.ts';
