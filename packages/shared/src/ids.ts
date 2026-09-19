/**
 * Branded identifier types.
 *
 * These are `string` at runtime and distinct at compile time, so passing an
 * `EntityId` where a `RelationshipId` is expected is a type error rather than a
 * bug discovered in production. The kernel deals in many ids that all look
 * alike; this is the cheapest defence available.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, 'OrgId'>;
export type OrgUnitId = Brand<string, 'OrgUnitId'>;
export type UserId = Brand<string, 'UserId'>;

export type EntityId = Brand<string, 'EntityId'>;
export type EntityTypeId = Brand<string, 'EntityTypeId'>;
export type RelationshipId = Brand<string, 'RelationshipId'>;
export type RelationshipTypeId = Brand<string, 'RelationshipTypeId'>;
export type ProvenanceId = Brand<string, 'ProvenanceId'>;
export type IngestionEventId = Brand<string, 'IngestionEventId'>;
export type AliasId = Brand<string, 'AliasId'>;

/** Reserved for Phase 2+; declared here so the vocabulary stays in one place. */
export type ScenarioId = Brand<string, 'ScenarioId'>;
export type ValueNodeId = Brand<string, 'ValueNodeId'>;

/**
 * Casts at the boundary where an untyped string (a database row, a URL segment)
 * becomes a typed id. Deliberately explicit: each call is a place where the
 * type system is being told something it cannot check.
 */
export const asOrgId = (v: string): OrgId => v as OrgId;
export const asOrgUnitId = (v: string): OrgUnitId => v as OrgUnitId;
export const asUserId = (v: string): UserId => v as UserId;
export const asEntityId = (v: string): EntityId => v as EntityId;
export const asEntityTypeId = (v: string): EntityTypeId => v as EntityTypeId;
export const asRelationshipId = (v: string): RelationshipId => v as RelationshipId;
export const asRelationshipTypeId = (v: string): RelationshipTypeId =>
  v as RelationshipTypeId;
export const asProvenanceId = (v: string): ProvenanceId => v as ProvenanceId;
export const asIngestionEventId = (v: string): IngestionEventId => v as IngestionEventId;
export const asAliasId = (v: string): AliasId => v as AliasId;
export const asScenarioId = (v: string): ScenarioId => v as ScenarioId;
