/**
 * @helm/value-graph — how the enterprise creates, consumes, constrains and
 * destroys value.
 *
 * The ontology holds nouns; this holds quantities (ADR-0015). It represents
 * value structure and records observations. It does not calculate: propagation
 * is Phase 3, and verify:value-graph asserts the absence.
 */

export * from './types.ts';
export * from './seed.ts';
export * from './registry.ts';
export * from './port.ts';
export { createInMemoryValueGraph } from './inMemory.ts';
export type { InMemoryValueGraphOptions } from './inMemory.ts';
export {
  buildCanonicalValueChain,
  canonicalValueNodeSpecs,
  canonicalValueLinkSpecs,
} from './canonicalValueChain.ts';
export type { CanonicalValueChain } from './canonicalValueChain.ts';
export {
  buildCanonicalScenarioExtension,
  canonicalScenarioExtensionNodes,
} from './canonicalScenarioExtension.ts';
export type { CanonicalScenarioExtension } from './canonicalScenarioExtension.ts';
