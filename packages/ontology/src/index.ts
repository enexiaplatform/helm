/**
 * @helm/ontology — the semantic tier.
 *
 * Entity and relationship *types* are registry data (ADR-0006); this package
 * holds their shape, their validation rules, and HELM's shipped seed taxonomy.
 */

export * from './types.ts';
export * from './seed.ts';
export * from './registry.ts';
