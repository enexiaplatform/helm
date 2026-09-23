/**
 * @helm/propagation-engine — the executable layer over the value graph.
 *
 * Deterministically propagates a change through declared calculation
 * dependencies and explains every derived result.
 */

export * from './types.ts';
export * from './registry.ts';
export * from './dependencyGraph.ts';
export * from './port.ts';
export { createPropagationEngine, ENGINE_VERSION } from './engine.ts';
export type { PropagationEngineOptions } from './engine.ts';
export { createInMemoryCalculationStore } from './inMemoryStore.ts';
export type { InMemoryCalculationStoreOptions } from './inMemoryStore.ts';
export {
  meridianValueModelV1,
  meridianModelKeys,
  meridianModelAssumptions,
} from './meridianValueModelV1.ts';
export {
  meridianValueModelV1_1,
  meridianScenarioCalculations,
  MERIDIAN_MODEL_V1_1,
} from './meridianValueModelV1_1.ts';
export {
  runCalculationConformanceSuite,
  type CalculationAdapterHarness,
} from './conformance.ts';
export {
  canonicalNumeric,
  inputFingerprint,
  readTruthLayers,
  selectObservation,
  type Lens,
  type TruthLayerReading,
} from './selection.ts';
