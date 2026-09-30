/**
 * @helm/integration-runtime — the Integration Fabric.
 *
 * Connect the enterprise without replacing what runs it. A source system owns
 * its facts; HELM references, canonicalizes, models and interprets them.
 *
 *   SourceAdapter → IdentityMapper → IngestionPipeline → (ontology, value graph)
 *   SyncCheckpoint · SchemaDriftDetector · WritebackGateway (DRY_RUN)
 *
 *     Source Truth ≠ Model Truth · a name is not an identity
 *     Commitment → Action Intent → governed write request — and v1 sends nothing
 */

export * from './types.ts';
export * from './port.ts';
export { detectDrift } from './drift.ts';
export { createIdentityMapper } from './identity.ts';
export type { IdentityMapper, AliasKind } from './identity.ts';
export { createIngestionPipeline } from './pipeline.ts';
export type { IngestionPipeline, IngestionPipelineDeps, RunOptions } from './pipeline.ts';
export { createMemoireAdapter, createFixtureMemoireReader, MEMOIRE_CONNECTOR, MEMOIRE_OPPORTUNITY_CONTRACT } from './memoire.ts';
export type { MemoireReader, MemoireOpportunityRow, MemoireCursor } from './memoire.ts';
export { sourceAndModel } from './truth.ts';
export type { SourceAndModel, TruthReading } from './truth.ts';
export { createWritebackGateway, createMemoireWritebackAdapter } from './writeback.ts';
export type { WritebackGateway, WritebackGatewayDeps, DispatchInput, DispatchResult } from './writeback.ts';
export { createInMemoryIntegrationStore } from './inMemoryStore.ts';
export type { InMemoryIntegrationStoreOptions } from './inMemoryStore.ts';
