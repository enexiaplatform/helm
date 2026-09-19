/**
 * @helm/graph-store — the single seam between the kernel and any database.
 *
 * The Postgres adapter is exported from './postgres' rather than here, so a
 * consumer that only needs the port and the in-memory adapter never pulls in a
 * database client. `verify:architecture` relies on that separation.
 */

export * from './port.ts';
export { createInMemoryGraphStore } from './inMemory.ts';
export { buildCanonicalScenario, canonicalEntitySpecs, canonicalRelationshipSpecs } from './canonicalScenario.ts';
export type { CanonicalGraph } from './canonicalScenario.ts';
export type { InMemoryGraphStoreOptions } from './inMemory.ts';
