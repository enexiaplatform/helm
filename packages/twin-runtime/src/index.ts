/**
 * @helm/twin-runtime — the Management Digital Twin.
 *
 * A temporally versioned management representation of the enterprise: what
 * existed and how it was connected, what value state existed, what management
 * knew, which futures it considered, which it committed to, what authority
 * governed it, and what changed afterwards — composed from the kernels that
 * own each of those, under an explicit two-time lens, fingerprinted, and never
 * rewritten.
 */

export * from './types.ts';
export * from './port.ts';
export { createTwinRuntime } from './runtime.ts';
export type { TwinRuntimeOptions } from './runtime.ts';
export { createInMemoryTwinStore, checkSnapshot } from './inMemoryStore.ts';
export type { InMemoryTwinStoreOptions } from './inMemoryStore.ts';
export { composeSnapshot, modelIdentity, defaultPeriods, COMPOSER_VERSION } from './compose.ts';
export type { TwinSources, Composition } from './compose.ts';
export { snapshotFingerprint, canonicalJson, itemFingerprintLine } from './fingerprint.ts';
export { compareComposed } from './delta.ts';
export { trajectoryOf } from './trajectory.ts';
export { createExplainer } from './explain.ts';
export { readStructure, classificationOf, ACCOUNT_CLASSES } from './structure.ts';
export type { StructureView, AccountClass } from './structure.ts';
export { decisionStateAt, OPEN_DECISION_STATES } from './management.ts';
export { snapshotAttention, attentionItem, MATERIALITY_V1, ATTENTION_RULES_VERSION, isMaterial, isDeterioration } from './attention.ts';
export {
  METRIC_SENSITIVITY,
  SENSITIVITY_ORDER,
  sensitivityOfMetric,
  containerSensitivity,
  isCleared,
  canSeeSnapshot,
  canSeeScenario,
  projectForViewer,
} from './sensitivity.ts';
export type { SensitivityClearance, TwinViewer, ProjectedSnapshot, ScenarioVisibilityFacts } from './sensitivity.ts';
export { createManagementApi } from './managementApi.ts';
export type { ManagementApi } from './managementApi.ts';
export {
  runMeridianTwinStory,
  DEMO_TWIN_LABEL,
  MERIDIAN_TWIN_SUCCESSOR,
  MERIDIAN_TWIN_TIMES,
  TWIN_PERIODS,
  Q4_ACTUAL_FULFILMENT_COST,
  Q4_ACTUAL_GM_PCT,
} from './meridianTwin.ts';
export type { MeridianTwinDeps, MeridianTwinStory } from './meridianTwin.ts';
