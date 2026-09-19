/**
 * The ontology registry — validation and inheritance over registry data.
 *
 * Pure: it holds type definitions in memory and answers questions about them.
 * Loading them from Postgres or from the seed is somebody else's job.
 */

import {
  ErrorCodes,
  fail,
  ok,
  type Result,
  asEntityTypeId,
  asRelationshipTypeId,
} from '@helm/shared';
import type {
  EntityCategory,
  EntityInput,
  EntityTypeDef,
  JsonSchema,
  JsonSchemaProperty,
  RelationshipInput,
  RelationshipTypeDef,
} from './types.ts';
import { seedEntityTypes, seedRelationshipTypes } from './seed.ts';

export interface OntologyRegistry {
  entityType(key: string): EntityTypeDef | null;
  relationshipType(key: string): RelationshipTypeDef | null;
  allEntityTypes(): readonly EntityTypeDef[];
  allRelationshipTypes(): readonly RelationshipTypeDef[];
  /** True when `key` is `ancestorKey` or inherits from it. */
  isA(key: string, ancestorKey: string): boolean;
  /** Type chain from `key` up to its root, inclusive. */
  ancestry(key: string): readonly string[];
  /** Effective category, resolved through inheritance. */
  categoryOf(key: string): EntityCategory | null;
  validateEntity(input: EntityInput): Result<EntityInput>;
  /**
   * Relationship endpoints must satisfy the type's category constraints, so
   * the endpoints' types are needed — not just their ids.
   */
  validateRelationship(
    input: RelationshipInput,
    sourceType: string,
    targetType: string,
  ): Result<RelationshipInput>;
}

// ------------------------------------------------------------- JSON Schema

/**
 * A deliberately small validator for the JsonSchema subset in types.ts.
 * Attribute bags are flat; when one genuinely is not, extend this rather than
 * reaching for a dependency the kernel would then carry forever.
 */
function validateAgainstSchema(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
): string[] {
  const problems: string[] = [];

  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) {
      problems.push(`${path}.${key} is required`);
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        problems.push(`${path}.${key} is not an allowed attribute`);
      }
      continue;
    }
    if (raw === null || raw === undefined) continue;
    problems.push(...validateProperty(prop, raw, `${path}.${key}`));
  }

  return problems;
}

function validateProperty(
  prop: JsonSchemaProperty,
  raw: unknown,
  path: string,
): string[] {
  const problems: string[] = [];
  const actual = Array.isArray(raw) ? 'array' : typeof raw;

  const typeOk =
    (prop.type === 'integer' && typeof raw === 'number' && Number.isInteger(raw)) ||
    (prop.type === 'number' && typeof raw === 'number') ||
    (prop.type === 'string' && typeof raw === 'string') ||
    (prop.type === 'boolean' && typeof raw === 'boolean') ||
    (prop.type === 'array' && Array.isArray(raw)) ||
    (prop.type === 'object' && actual === 'object' && !Array.isArray(raw));

  if (!typeOk) {
    problems.push(`${path} expected ${prop.type}, got ${actual}`);
    return problems;
  }

  if (prop.enum && !prop.enum.includes(raw as string | number)) {
    problems.push(`${path} must be one of ${prop.enum.join(' | ')}, got ${String(raw)}`);
  }
  if (typeof raw === 'number') {
    if (prop.minimum !== undefined && raw < prop.minimum) {
      problems.push(`${path} must be >= ${prop.minimum}, got ${raw}`);
    }
    if (prop.maximum !== undefined && raw > prop.maximum) {
      problems.push(`${path} must be <= ${prop.maximum}, got ${raw}`);
    }
  }
  if (prop.type === 'array' && prop.items && Array.isArray(raw)) {
    raw.forEach((item, i) => {
      const t = typeof item;
      const itemOk =
        (prop.items!.type === 'integer' && t === 'number' && Number.isInteger(item)) ||
        (prop.items!.type !== 'integer' && t === prop.items!.type);
      if (!itemOk) problems.push(`${path}[${i}] expected ${prop.items!.type}, got ${t}`);
    });
  }

  return problems;
}

// -------------------------------------------------------- canonical key rule

/**
 * `<namespace>:<kind>:<ref>` — see identity-resolution.md §2. Enforced here so
 * a namespaceless key cannot enter the graph and collide once a second source
 * system arrives.
 */
const CANONICAL_KEY = /^[a-z0-9_]+:[a-z0-9_]+:[^\s:][^\s]*$/i;

export function isValidCanonicalKey(key: string): boolean {
  return CANONICAL_KEY.test(key) && key.length <= 300;
}

export function canonicalKey(namespace: string, kind: string, ref: string): string {
  return `${namespace}:${kind}:${ref}`;
}

export function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ------------------------------------------------------------------ registry

export function createRegistry(
  entityTypes: readonly EntityTypeDef[],
  relationshipTypes: readonly RelationshipTypeDef[],
): OntologyRegistry {
  const entityByKey = new Map(entityTypes.map((t) => [t.key, t]));
  const entityById = new Map(entityTypes.map((t) => [t.id, t]));
  const relByKey = new Map(relationshipTypes.map((t) => [t.key, t]));

  const ancestryCache = new Map<string, readonly string[]>();

  function ancestry(key: string): readonly string[] {
    const cached = ancestryCache.get(key);
    if (cached) return cached;

    const chain: string[] = [];
    const seen = new Set<string>();
    let current = entityByKey.get(key) ?? null;
    while (current) {
      if (seen.has(current.key)) break; // cycle guard; surfaced by validateOntology
      seen.add(current.key);
      chain.push(current.key);
      current = current.parentTypeId ? (entityById.get(current.parentTypeId) ?? null) : null;
    }
    ancestryCache.set(key, chain);
    return chain;
  }

  function categoryOf(key: string): EntityCategory | null {
    return entityByKey.get(key)?.category ?? null;
  }

  function categoryMatches(
    allowed: readonly EntityCategory[] | null,
    typeKey: string,
  ): boolean {
    if (allowed === null) return true;
    // Inheritance-aware: an Account satisfies a constraint written for Customer's
    // category, because it *is* one.
    return ancestry(typeKey).some((k) => {
      const c = categoryOf(k);
      return c !== null && allowed.includes(c);
    });
  }

  return {
    entityType: (key) => entityByKey.get(key) ?? null,
    relationshipType: (key) => relByKey.get(key) ?? null,
    allEntityTypes: () => entityTypes,
    allRelationshipTypes: () => relationshipTypes,
    ancestry,
    categoryOf,

    isA(key, ancestorKey) {
      return ancestry(key).includes(ancestorKey);
    },

    validateEntity(input) {
      const def = entityByKey.get(input.entityTypeKey);
      if (!def) {
        return fail(
          ErrorCodes.ONTOLOGY_UNKNOWN_ENTITY_TYPE,
          `Unknown entity type "${input.entityTypeKey}". Register it in helm_entity_types first.`,
          { entityTypeKey: input.entityTypeKey },
        );
      }
      if (def.status === 'deprecated') {
        return fail(
          ErrorCodes.ONTOLOGY_INACTIVE_TYPE,
          `Entity type "${def.key}" is deprecated and cannot take new entities.`,
          { entityTypeKey: def.key },
        );
      }
      if (!isValidCanonicalKey(input.canonicalKey)) {
        return fail(
          ErrorCodes.ONTOLOGY_INVALID_CANONICAL_KEY,
          `Canonical key "${input.canonicalKey}" must be "<namespace>:<kind>:<ref>".`,
          { canonicalKey: input.canonicalKey },
        );
      }
      if (!input.name || input.name.trim().length === 0) {
        return fail(ErrorCodes.ONTOLOGY_INVALID_ATTRIBUTES, 'Entity name is required.');
      }
      if (
        input.confidence !== undefined &&
        input.confidence !== null &&
        (input.confidence < 0 || input.confidence > 1)
      ) {
        return fail(
          ErrorCodes.ONTOLOGY_INVALID_ATTRIBUTES,
          `Confidence must be between 0 and 1, got ${input.confidence}.`,
        );
      }

      // Attributes are validated against the whole inherited chain, so a rule
      // written for Customer also constrains Account.
      const problems: string[] = [];
      for (const typeKey of ancestry(input.entityTypeKey)) {
        const t = entityByKey.get(typeKey);
        if (t) problems.push(...validateAgainstSchema(t.attributeSchema, input.attributes ?? {}, 'attributes'));
      }
      if (problems.length > 0) {
        return fail(
          ErrorCodes.ONTOLOGY_INVALID_ATTRIBUTES,
          `Invalid attributes for ${def.key}: ${problems.join('; ')}`,
          { problems },
        );
      }

      return ok(input);
    },

    validateRelationship(input, sourceType, targetType) {
      const def = relByKey.get(input.relationshipTypeKey);
      if (!def) {
        return fail(
          ErrorCodes.ONTOLOGY_UNKNOWN_RELATIONSHIP_TYPE,
          `Unknown relationship type "${input.relationshipTypeKey}".`,
          { relationshipTypeKey: input.relationshipTypeKey },
        );
      }
      if (def.status === 'deprecated') {
        return fail(
          ErrorCodes.ONTOLOGY_INACTIVE_TYPE,
          `Relationship type "${def.key}" is deprecated.`,
        );
      }
      if (input.sourceEntityId === input.targetEntityId) {
        return fail(
          ErrorCodes.GRAPH_SELF_REFERENCE,
          `A ${def.key} relationship cannot connect an entity to itself.`,
        );
      }
      if (!categoryMatches(def.sourceCategories, sourceType)) {
        return fail(
          ErrorCodes.ONTOLOGY_DOMAIN_CONSTRAINT,
          `${def.key} cannot start at a ${sourceType} (allowed source categories: ` +
            `${def.sourceCategories?.join(', ')}).`,
          { relationshipTypeKey: def.key, sourceType },
        );
      }
      if (!categoryMatches(def.targetCategories, targetType)) {
        return fail(
          ErrorCodes.ONTOLOGY_DOMAIN_CONSTRAINT,
          `${def.key} cannot end at a ${targetType} (allowed target categories: ` +
            `${def.targetCategories?.join(', ')}).`,
          { relationshipTypeKey: def.key, targetType },
        );
      }
      if (
        input.confidence !== undefined &&
        input.confidence !== null &&
        (input.confidence < 0 || input.confidence > 1)
      ) {
        return fail(
          ErrorCodes.ONTOLOGY_INVALID_ATTRIBUTES,
          `Confidence must be between 0 and 1, got ${input.confidence}.`,
        );
      }
      if (input.weight != null && !def.carriesWeight) {
        return fail(
          ErrorCodes.ONTOLOGY_INVALID_ATTRIBUTES,
          `Relationship type ${def.key} does not carry a weight.`,
          { relationshipTypeKey: def.key },
        );
      }

      return ok(input);
    },
  };
}

// -------------------------------------------------------- seed → definitions

/**
 * Turns the seed data into registry definitions. Ids are derived
 * deterministically from the key, so the in-memory store and the database
 * agree without coordinating — which is what lets the conformance suite run
 * the same fixtures against both adapters.
 */
export function seedTypeId(kind: 'entity' | 'relationship', key: string): string {
  // A stable namespaced UUIDv5-like value would need a hash dependency; a
  // deterministic synthetic id is sufficient and stays readable in fixtures.
  return `${kind === 'entity' ? 'et' : 'rt'}_${key.toLowerCase()}`;
}

export function buildSeedRegistry(): OntologyRegistry {
  const entityTypes: EntityTypeDef[] = seedEntityTypes.map((t) => ({
    id: asEntityTypeId(seedTypeId('entity', t.key)),
    orgId: null,
    key: t.key,
    name: t.name,
    description: t.description,
    category: t.category,
    parentTypeId: t.parentKey ? asEntityTypeId(seedTypeId('entity', t.parentKey)) : null,
    attributeSchema: t.attributeSchema,
    version: 1,
    status: t.status ?? 'active',
    isSystem: true,
  }));

  const relationshipTypes: RelationshipTypeDef[] = seedRelationshipTypes.map((t) => ({
    id: asRelationshipTypeId(seedTypeId('relationship', t.key)),
    orgId: null,
    key: t.key,
    name: t.name,
    description: t.description,
    category: t.category,
    isDirected: t.isDirected,
    carriesWeight: t.carriesWeight,
    sourceCategories: t.sourceCategories,
    targetCategories: t.targetCategories,
    inverseKey: t.inverseKey,
    version: 1,
    status: 'active',
    isSystem: true,
  }));

  return createRegistry(entityTypes, relationshipTypes);
}

// ------------------------------------------------------- ontology self-check

export type OntologyProblem = { kind: string; detail: string };

/**
 * Structural integrity of the ontology itself — run by `verify:ontology`.
 * A broken ontology is worse than a missing one: it validates bad data.
 */
export function validateOntology(registry: OntologyRegistry): OntologyProblem[] {
  const problems: OntologyProblem[] = [];
  const entityTypes = registry.allEntityTypes();
  const relTypes = registry.allRelationshipTypes();

  const seenEntityKeys = new Set<string>();
  for (const t of entityTypes) {
    if (seenEntityKeys.has(t.key)) {
      problems.push({ kind: 'duplicate_entity_type', detail: t.key });
    }
    seenEntityKeys.add(t.key);

    if (t.parentTypeId) {
      const parent = entityTypes.find((p) => p.id === t.parentTypeId);
      if (!parent) {
        problems.push({
          kind: 'dangling_parent',
          detail: `${t.key} -> ${String(t.parentTypeId)}`,
        });
      }
    }

    // Cycle detection: ancestry() breaks on a cycle, so a chain that fails to
    // reach a root indicates one.
    const chain = registry.ancestry(t.key);
    if (chain.length > 0 && chain[0] !== t.key) {
      problems.push({ kind: 'broken_ancestry', detail: t.key });
    }
    const last = chain[chain.length - 1];
    const lastDef = last ? entityTypes.find((e) => e.key === last) : undefined;
    if (lastDef?.parentTypeId) {
      problems.push({ kind: 'cyclic_inheritance', detail: chain.join(' -> ') });
    }
  }

  const seenRelKeys = new Set<string>();
  for (const t of relTypes) {
    if (seenRelKeys.has(t.key)) {
      problems.push({ kind: 'duplicate_relationship_type', detail: t.key });
    }
    seenRelKeys.add(t.key);

    if (t.inverseKey) {
      const inverse = relTypes.find((r) => r.key === t.inverseKey);
      if (!inverse) {
        problems.push({
          kind: 'dangling_inverse',
          detail: `${t.key} -> ${t.inverseKey}`,
        });
      } else if (inverse.inverseKey !== t.key) {
        problems.push({
          kind: 'asymmetric_inverse',
          detail: `${t.key} <-> ${inverse.key}`,
        });
      }
    }

    // A weightless type that something tries to weight is a silent data loss.
    if (!t.carriesWeight && t.category === 'financial' && t.key === 'CONTRIBUTES_TO') {
      problems.push({ kind: 'value_edge_without_weight', detail: t.key });
    }
  }

  return problems;
}
