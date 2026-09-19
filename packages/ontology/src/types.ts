/**
 * Ontology types — the semantic tier's vocabulary.
 *
 * Entity and relationship *types* are registry data (ADR-0006), so an
 * enterprise extends its model by inserting rows, not by editing this file.
 * What lives here is the shape of a type, not the list of them.
 */

import type {
  AliasId,
  Confidence,
  EntityId,
  EntityTypeId,
  InlineProvenance,
  OrgId,
  RelationshipId,
  RelationshipTypeId,
  SourceSystem,
  UserId,
  ValidTime,
  RecordTime,
} from '@helm/shared';

// ------------------------------------------------------------------ registry

/**
 * Categories group types for scoping, visibility and relationship constraints.
 * Fixed in code because kernel logic branches on them; the *types* inside each
 * category are open.
 */
export const entityCategories = [
  'organization',
  'commercial',
  'operations',
  'finance',
  'resource',
  'management',
  'market',
  'risk',
  'value',
] as const;
export type EntityCategory = (typeof entityCategories)[number];

export const typeStatuses = ['draft', 'active', 'deprecated'] as const;
export type TypeStatus = (typeof typeStatuses)[number];

export type EntityTypeDef = {
  id: EntityTypeId;
  /** null = shipped by HELM, available to every organization. */
  orgId: OrgId | null;
  /** Stable semantic key, PascalCase: 'Opportunity'. */
  key: string;
  name: string;
  description: string | null;
  category: EntityCategory;
  /** Single inheritance. 'Account' -> 'Customer'. */
  parentTypeId: EntityTypeId | null;
  /** JSON Schema for `Entity.attributes`. */
  attributeSchema: JsonSchema;
  version: number;
  status: TypeStatus;
  /** System types cannot be deleted or redefined by a tenant. */
  isSystem: boolean;
};

export const relationshipCategories = [
  'structural',
  'commercial',
  'operational',
  'financial',
  'management',
] as const;
export type RelationshipCategory = (typeof relationshipCategories)[number];

export type RelationshipTypeDef = {
  id: RelationshipTypeId;
  orgId: OrgId | null;
  /** Stable semantic key, SCREAMING_SNAKE: 'BELONGS_TO'. */
  key: string;
  name: string;
  description: string | null;
  category: RelationshipCategory;
  isDirected: boolean;
  carriesWeight: boolean;
  /** Allowed source categories. null = unconstrained. */
  sourceCategories: readonly EntityCategory[] | null;
  targetCategories: readonly EntityCategory[] | null;
  /** Display inverse, e.g. OWNS <-> OWNED_BY. Not a stored reverse edge. */
  inverseKey: string | null;
  version: number;
  status: TypeStatus;
  isSystem: boolean;
};

/**
 * A deliberately small JSON Schema subset — enough to validate flat attribute
 * bags, small enough to implement without a dependency. Extend when a real
 * attribute needs more, not before.
 */
export type JsonSchema = {
  type?: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
};

// ------------------------------------------------------------------ entities

export const entityStatuses = ['active', 'retired', 'merged'] as const;
export type EntityStatus = (typeof entityStatuses)[number];

export type Entity = {
  id: EntityId;
  orgId: OrgId;
  entityTypeId: EntityTypeId;
  /** Denormalised for readability; always matches entityTypeId. */
  entityTypeKey: string;
  /** Namespaced semantic identity, unique per (org, type). */
  canonicalKey: string;
  name: string;
  description: string | null;

  /** Inline provenance fast path (ADR-0013). */
  sourceSystem: SourceSystem;
  sourceEntityType: string | null;
  sourceEntityId: string | null;

  /** Valid time — when this is true in the world (ADR-0014). */
  validFrom: ValidTime;
  validTo: ValidTime | null;
  observedAt: ValidTime | null;

  /** Record time — when HELM learned it. */
  ingestedAt: RecordTime;
  updatedAt: RecordTime;
  version: number;

  confidence: Confidence | null;
  attributes: Readonly<Record<string, unknown>>;
  status: EntityStatus;
  /** Set when identity resolution folds this into another entity. */
  mergedIntoId: EntityId | null;
  createdBy: UserId | null;
};

/** What a caller supplies; the store assigns id, version and record times. */
export type EntityInput = {
  entityTypeKey: string;
  canonicalKey: string;
  name: string;
  description?: string | null;
  sourceSystem: SourceSystem;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  validFrom?: ValidTime;
  validTo?: ValidTime | null;
  observedAt?: ValidTime | null;
  confidence?: Confidence | null;
  attributes?: Record<string, unknown>;
  createdBy?: UserId | null;
};

export type EntityPatch = Partial<
  Pick<
    EntityInput,
    | 'name'
    | 'description'
    | 'validFrom'
    | 'validTo'
    | 'observedAt'
    | 'confidence'
    | 'attributes'
    | 'sourceEntityId'
    | 'sourceEntityType'
  >
> & { status?: EntityStatus };

export const versionChangeKinds = [
  'created',
  'updated',
  'validity_closed',
  'retired',
  'merged',
] as const;
export type VersionChangeKind = (typeof versionChangeKinds)[number];

/** One link in the record-time chain (ADR-0014). Append-only. */
export type EntityVersion = {
  entityId: EntityId;
  orgId: OrgId;
  version: number;
  changeKind: VersionChangeKind;
  snapshot: Entity;
  validFrom: ValidTime;
  validTo: ValidTime | null;
  observedAt: ValidTime | null;
  recordedFrom: RecordTime;
  recordedTo: RecordTime | null;
  changedBy: UserId | null;
};

// ------------------------------------------------------------- relationships

export type Relationship = {
  id: RelationshipId;
  orgId: OrgId;
  relationshipTypeId: RelationshipTypeId;
  relationshipTypeKey: string;
  sourceEntityId: EntityId;
  targetEntityId: EntityId;
  weight: number | null;
  confidence: Confidence | null;

  validFrom: ValidTime;
  validTo: ValidTime | null;
  observedAt: ValidTime | null;
  ingestedAt: RecordTime;
  updatedAt: RecordTime;

  sourceSystem: SourceSystem;
  sourceObjectType: string | null;
  sourceObjectId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdBy: UserId | null;
};

export type RelationshipInput = {
  relationshipTypeKey: string;
  sourceEntityId: EntityId;
  targetEntityId: EntityId;
  weight?: number | null;
  confidence?: Confidence | null;
  validFrom?: ValidTime;
  validTo?: ValidTime | null;
  observedAt?: ValidTime | null;
  sourceSystem: SourceSystem;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: UserId | null;
};

// ------------------------------------------------------------------- aliases

export const aliasKinds = [
  'source_id',
  'code',
  'name',
  'tax_id',
  'email',
  'domain',
] as const;
export type AliasKind = (typeof aliasKinds)[number];

export const matchMethods = [
  'exact',
  'manual',
  'deterministic',
  'probabilistic',
] as const;
export type MatchMethod = (typeof matchMethods)[number];

/** The structural hook for future entity resolution — see identity-resolution.md. */
export type EntityAlias = {
  id: AliasId;
  orgId: OrgId;
  entityId: EntityId;
  system: SourceSystem;
  aliasKind: AliasKind;
  aliasValue: string;
  /** Casefolded/trimmed, for matching. */
  normalizedValue: string;
  matchMethod: MatchMethod;
  confidence: Confidence | null;
  evidence: Record<string, unknown> | null;
  validFrom: ValidTime;
  validTo: ValidTime | null;
  createdBy: UserId | null;
};

export type EntityAliasInput = Omit<
  EntityAlias,
  'id' | 'orgId' | 'normalizedValue' | 'validFrom' | 'validTo'
> & {
  validFrom?: ValidTime;
  validTo?: ValidTime | null;
};

export type { InlineProvenance };
