# ADR-0006: Ontology types are registry data, not enums

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

The brief is unambiguous (§2.1): "Do not hard-code every future entity. The
ontology must be extensible."

The existing codebase does the opposite, consistently. `decisionTypes`,
`costObjectKinds`, `orgUnitTypes` and `signalSeverities` are `as const` TypeScript
arrays, each mirrored by a SQL `CHECK` constraint:

```ts
export const costObjectKinds = ['company','business_unit','brand','product',
  'customer','channel','territory','project'] as const;
```

```sql
kind text NOT NULL CHECK (kind IN ('company','business_unit','brand', …))
```

Adding `ProductionLine` therefore requires a code change, a migration, and a
deploy — three coordinated steps for what should be an act of configuration. For
a fixed vocabulary this is excellent practice: the types are exhaustive, the
compiler checks every switch, and the database rejects bad data. For an
*enterprise ontology* it is a structural mistake, because the whole premise is
that each enterprise models itself differently.

## Problem

How are entity and relationship types represented so an enterprise extends its
model without a code change, while HELM keeps type safety where the kernel
genuinely depends on specific types?

## Options considered

1. **Keep TS unions + CHECK constraints.** Maximum compile-time safety; every
   extension is a deploy. Directly contradicts §2.1.
2. **Fully dynamic, no typing.** Types are strings validated only at runtime.
   Maximum flexibility; the kernel loses all compile-time guarantees, including
   for the handful of types its logic genuinely depends on (`Opportunity`,
   `Product`, `EnterpriseValue`).
3. **Registry tables + runtime validation + a typed core subset.** Types live in
   `helm_entity_types` / `helm_relationship_types` with JSON Schema for
   attributes. The seed taxonomy ships as rows. A small set of *core* type codes
   that kernel logic references is additionally exported as typed constants.
4. **Registry plus code generation.** Generate TS types from registry rows at
   build time. Full safety and flexibility — but a per-tenant ontology cannot be
   compiled into a shared build, which makes this incoherent for a multi-tenant
   product.

## Decision

**Option 3.**

```sql
helm_entity_types(code PK, domain, parent_code, attribute_schema jsonb,
                  version, is_core, org_id NULL)
helm_relationship_types(code PK, category, from_domain_constraint,
                        to_domain_constraint, is_directed, carries_weight,
                        version, is_core, org_id NULL)
```

- `org_id IS NULL` = a HELM-shipped type available to every organization.
  `org_id` set = a tenant's own extension. One registry, two scopes.
- `attribute_schema` is JSON Schema, validated by `OntologyRegistry.validateEntity`
  on write. Structure is enforced without a column per attribute.
- `parent_code` gives single inheritance, so a rule written for `Customer` applies
  to `Account`. Traversal filters resolve through ancestry.
- **A narrow `CoreEntityType` union is exported** for the types kernel logic
  actually names — `Opportunity`, `Product`, `InventoryPosition`, `Role`,
  `Objective`, `Decision`, `EnterpriseValue`. Core types are `is_core = true`,
  cannot be deleted, and are the only ones the kernel may reference by literal.
- No `CHECK (type_code IN …)`. Referential integrity comes from a foreign key to
  the registry, which is where the vocabulary lives.

The design principle: **the kernel depends on a small, stable core; everything
else is data.** A propagation calculation may say "this applies to entities of
type `Product`" because `Product` is core. Nothing in the kernel may hard-code a
tenant's `ColdChainLane`.

### What stays an enum

Not everything should become data. Kernel *state machines* keep their TypeScript
unions, because they are exhaustive by design and their code branches on every
case:

- `DecisionStatus` — a status HELM has no transition logic for is a bug, not an
  extension.
- `SignalSeverity`, `OrgRole`, `EconomicsKind`, `FinancialLineKind` — same
  reasoning.

`decisionTypes` and `costObjectKinds` **do** become registry-backed: they are
domain vocabulary, and their current `as const` form is exactly the rigidity this
ADR removes.

## Consequences

**Good.** An enterprise extends its ontology with inserts. Tenant-specific types
coexist with shipped ones. Attribute validation is declarative. Type versioning
allows schema evolution with stored-result provenance. The kernel keeps compile
safety where it has logic.

**Bad.** Compile-time exhaustiveness is lost for registry-backed types; a typo in
a type code becomes a runtime `Result.error` instead of a build failure. Validation
cost moves to runtime. Code reading a dynamic ontology is less obvious than code
reading an enum.

**Risk — ontology sprawl.** Tenants create near-duplicate types
(`Customer`/`Client`/`Buyer`) and the graph fragments. Mitigation: the seed
taxonomy is opinionated, core types cannot be redefined, and the ontology explorer
surfaces low-use types for consolidation.

**Risk — the "core subset" grows until it is the whole ontology.** Mitigation:
adding a core type requires an ADR.

## Migration implications

- Phase 1 creates both registry tables and seeds them from
  [ontology.md](../domain/ontology.md) as `is_core` where appropriate.
- Existing `helm_cost_objects.kind` and `helm_decisions.decision_type` keep their
  `CHECK` constraints in Phase 1 and are converted to registry references in
  Phase 2, when entity projection makes the registry authoritative. All `helm_*`
  tables are empty, so no data migration is involved.
- `verify:ontology-core` asserts that no kernel package references a
  non-core type code as a string literal.
