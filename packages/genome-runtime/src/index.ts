/**
 * @helm/genome-runtime — the Management Genome.
 *
 * Organizational memory of how the enterprise meets situations: forms beliefs,
 * decides, accepts trade-offs and obtains outcomes. Episodes reference the
 * immutable artifacts of one management experience; patterns are checkable
 * hypotheses over them; lessons are authored and inert. Decision process and
 * outcome stay apart, and no person is rated.
 *
 *          Decision Process Quality ≠ Outcome Quality
 */

export * from './types.ts';
export * from './port.ts';
export {
  GENOME_PATTERN_POLICY,
  RECURRING_MIN_SUPPORTING,
  SUPPORTED_MIN_SUPPORTING,
  SUPPORTED_MIN_DISTINCT_CONTEXTS,
  decidePattern,
  observeCharacteristic,
  conditionsHold,
  stanceAgrees,
} from './policy.ts';
export type { LinkedEpisode, PatternCoverage, PatternDecision, ObservableFacts, Observation } from './policy.ts';
export { deriveSituation, agreements, boundaryOf, classesOf, structureAt } from './situation.ts';
export type { GenomeSources, DerivedSituation } from './situation.ts';
export { createManagementGenome } from './runtime.ts';
export type { ManagementGenomeOptions } from './runtime.ts';
export { createInMemoryGenomeStore } from './inMemoryStore.ts';
export type { InMemoryGenomeStoreOptions } from './inMemoryStore.ts';
export { runMeridianGenomeStory, DEMO_GENOME_LABEL, MERIDIAN_GENOME_TIMES } from './meridianGenome.ts';
export type { MeridianGenomeDeps, MeridianGenomeStory } from './meridianGenome.ts';
