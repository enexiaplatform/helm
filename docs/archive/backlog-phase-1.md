# Phase 1 Backlog — Enterprise Ontology

> **Archive.** This describes the pre-kernel application, which has been retired: the engines, pages and tables it discusses were replaced by the layers in [the architecture](../architecture/helm-architecture.md). It is kept as history and is not a description of HELM today.

**Objective.** Give HELM a semantic spine: entities and relationships that are
org-scoped, temporal, provenance-bearing, confidence-carrying, and extensible
without a migration — reachable only through a port with two working adapters.

**Why first.** Propagation needs a value graph; a value graph needs an ontology.
Nothing above Phase 1 can be built honestly before it exists.

**Prerequisite (blocking).** Version control. See task 0.

Design references: [../domain/ontology.md](../domain/ontology.md) ·
[../architecture/domain-model.md](../architecture/domain-model.md) ·
[../architecture/kernel-interfaces.md](../architecture/kernel-interfaces.md) ·
[ADR-0002](../adr/0002-pnpm-turborepo-monorepo.md) ·
[ADR-0004](../adr/0004-graph-abstraction-layer.md) ·
[ADR-0005](../adr/0005-namespace-all-helm-tables.md) ·
[ADR-0006](../adr/0006-data-driven-ontology.md) ·
[ADR-0007](../adr/0007-value-graph-projection.md)

---

## 0. Version control — BLOCKING

**0.1** `git init`; confirm `.gitignore` covers `node_modules`, `dist`, `.env`,
`*.log`. Baseline commit of the current green state **before** any restructuring.

**0.2** Create a working branch for the Phase 1 work rather than committing the
restructure to the default branch.

> Nothing else in this backlog starts until 0.1 is done. Restructuring a
> 7,300-line codebase that shares a production database, with no ability to
> revert, is not an acceptable risk.

---

## 1. Workspace skeleton

**1.1** `pnpm-workspace.yaml` with `apps/*`, `packages/*`, `connectors/*`,
`services/*`.

**1.2** `turbo.json` with `build`, `test`, `lint`, `typecheck` pipelines and
correct `dependsOn` ordering.

**1.3** Root `package.json`: workspace scripts, `packageManager` pinned to
pnpm 10.30.3, root devDependencies (typescript, vitest, eslint, turbo).

**1.4** Migrate `package-lock.json` → `pnpm-lock.yaml`. Remove the npm lockfile.

**1.5** Shared base configs: `tsconfig.base.json` (strict, `erasableSyntaxOnly`,
matching the current app settings), shared eslint config, `vitest.workspace.ts`.

**1.6** Confirm the existing app still builds and its 40 tests still pass with
nothing moved.

**Gate.** `pnpm install && pnpm build && pnpm test && pnpm lint` green, app
unmoved.

---

## 2. `packages/shared`

**2.1** Branded id types: `OrgId`, `OrgUnitId`, `UserId`, `EntityId`,
`RelationshipId`, `ScenarioId`, `ValueNodeId`.

**2.2** `Result<T, E>` + `HelmError` with a documented error-code taxonomy
(`ontology.unknown_type`, `graph.depth_exceeded`, `authority.insufficient`, …).

**2.3** `Money`, `Currency`, `Horizon`, `Confidence`, `Provenance`, temporal
helpers (`isCurrentAt`, `overlaps`, `closeValidity`).

**2.4** `Clock` and `IdGen` ports + `systemClock` / `uuidIdGen` implementations
(the only place kernel code gets time or randomness).

**2.5** `Scope` type per
[security-model.md §4.1](../architecture/security-model.md#41-five-dimensional-scope).

**2.6** Unit tests for temporal helpers and `Result` combinators.

**Gate.** No dependencies beyond TypeScript. 100% coverage of temporal logic.

---

## 3. `packages/ontology`

**3.1** Type definitions: `EntityTypeDef`, `RelationshipTypeDef`, `Entity`,
`Relationship`, `EntityInput`, `RelationshipInput`.

**3.2** `OntologyRegistry` implementation: `entityType`, `relationshipType`,
`isA` (resolving `parent_code` ancestry), `validateEntity`,
`validateRelationship`.

**3.3** JSON Schema validation of `attributes` against
`EntityTypeDef.attributeSchema`. Minimal dependency-light validator, or a single
small vetted library.

**3.4** Relationship domain-constraint enforcement: reject endpoints violating
`from_domain_constraint` / `to_domain_constraint`.

**3.5** `CoreEntityType` union + `coreEntityTypes` constant per
[ADR-0006](../adr/0006-data-driven-ontology.md). Core types only.

**3.6** Natural-key helpers: `naturalKeyFor(sourceSystem, kind, ref)` producing
`memoire:opp:123`, `helm:inv:SKU-X@WH1`.

**3.7** Seed ontology as data: all entity types, relationship types and value
metrics from [ontology.md](../domain/ontology.md), exported as a typed seed
module so the same definitions feed both the migration and `InMemoryGraphStore`.

**3.8** Unit tests: inheritance resolution, attribute validation success and
failure, domain-constraint rejection, natural-key idempotency.

**Gate.** Zero I/O. Seed loads into both adapters identically.

---

## 4. Migration — ontology tables

**4.1** `supabase/migrations/<ts>_helm_ontology.sql`, strictly additive:

```
helm_entity_types(code PK, domain, parent_code FK, attribute_schema jsonb,
                  version, is_core, org_id NULL FK, created_at, updated_at)
helm_relationship_types(code PK, category, from_domain_constraint,
                        to_domain_constraint, is_directed, carries_weight,
                        version, is_core, org_id NULL FK, …)
helm_entities(id PK, org_id FK, type_code FK, natural_key, name,
              attributes jsonb, source_system, source_ref, observed_at,
              valid_from, valid_to NULL, confidence, created_by,
              created_at, updated_at)
helm_relationships(id PK, org_id FK, type_code FK, from_entity_id FK,
                   to_entity_id FK, weight, confidence, lag_days,
                   scenario_id NULL, source_system, source_ref,
                   observed_at, valid_from, valid_to NULL, …)
```

**4.2** Constraints: unique `(org_id, type_code, natural_key)` where
`valid_to IS NULL`; `confidence BETWEEN 0 AND 1`; `valid_to > valid_from`.

**4.3** Traversal indexes, both directions:
`(org_id, from_entity_id, type_code) WHERE valid_to IS NULL`,
`(org_id, to_entity_id, type_code) WHERE valid_to IS NULL`,
`(org_id, type_code, natural_key)`, plus a `scenario_id` partial index.

**4.4** RLS on all four tables, using the existing `is_org_member` /
`has_org_role` helpers. Registry rows with `org_id IS NULL` are readable by any
authenticated user; tenant extensions are org-scoped. `admin` for type changes,
`member`+ for entity writes.

**4.5** `updated_at` triggers via the existing `helm_set_updated_at`.

**4.6** Seed insert of shipped types with `org_id = NULL`, `is_core` set
appropriately. Idempotent (`ON CONFLICT DO NOTHING`).

**4.7** Apply to the shared project; verify Memoire tables are untouched.

**Gate.** `verify:additive-migrations` and `verify:table-namespace` pass. No
Memoire table altered. Migration re-runnable as a no-op.

---

## 5. `packages/graph-store`

**5.1** The `GraphStore` port exactly as specified in
[kernel-interfaces.md §2](../architecture/kernel-interfaces.md#2-graph-store--the-persistence-port).

**5.2** `InMemoryGraphStore`: full contract over plain objects, including
temporal filtering, scenario overlay, and BFS traversal with `maxDepth`.

**5.3** `PostgresGraphStore`: the same contract via Supabase. Recursive CTEs for
`traverse()` and `paths()`; `asOf` and `scenarioId` pushed into SQL, never applied
in JS afterwards.

**5.4** `pathConfidence` computed as the product of edge confidences, identically
in both adapters (shared helper, not duplicated logic).

**5.5** Required `maxDepth`; exceeding it returns
`Result.error('graph.depth_exceeded')` rather than truncating silently.

**5.6** Batch source-reference resolver hooks per
[ADR-0007](../adr/0007-value-graph-projection.md) — one query per source table
per traversal, not per node.

**5.7** **Conformance suite** run against both adapters: entity upsert and
supersede, relationship upsert and supersede, traversal at depth with type
filters, `asOf` historical queries, scenario overlay vs base reality,
`paths()` enumeration and confidence, idempotent re-upsert, depth-limit error.

**5.8** Integration test on a Supabase branch: two orgs, two users, assert org A
sees zero rows of org B — through the real client with a real anon key.

**Gate.** One suite, both adapters, all green. Cross-org isolation proven against
the real database.

---

## 6. Projection and first ingestion

**6.1** Project existing HELM rows into entities: `helm_cost_objects`,
`helm_inventory_items`, `helm_processes`, `org_units` →
`source_system='helm'`, `source_ref` = row id. Reference only; **no values
copied**.

**6.2** Project a Memoire opportunity into an `Opportunity` entity with
`source_system='memoire'`, `source_ref` = opportunity id, `observed_at`,
`confidence` = probability. Reference only.

**6.3** Build the canonical-scenario graph in the demo organization: the entities
and relationships in
[canonical-scenario.md §3](../domain/canonical-scenario.md#3-the-situation-as-a-graph),
including the `competes_with` edge.

**6.4** Idempotency test: run projection twice, assert zero new rows and zero
superseded rows.

**6.5** Temporal test: change an opportunity's probability, assert the prior
entity version is superseded not overwritten, and that `asOf` the earlier
timestamp returns the old value.

**Gate.** Demo org's canonical graph traversable in both adapters. Projection is
idempotent. History is queryable.

---

## 7. Ontology explorer (minimal, read-only)

**7.1** A single console route (`/ontology`) listing entity types by domain with
counts.

**7.2** Entity list per type, with provenance and validity columns visible.

**7.3** Entity detail: attributes, provenance, validity window, confidence, and
its relationships in and out.

**7.4** Depth-limited traversal view from a selected entity (depth ≤ 4).

**7.5** Provenance inspector: source system, source ref, observed at, ingested at.

> Read-only, deliberately. This is an architecture instrument for verifying the
> ontology is real, not a management surface. **No charts.** Management surfaces
> begin at Phase 14, after Phase 6's authority and visibility rules exist.

**Gate.** A reviewer can navigate the canonical scenario graph and inspect any
entity's provenance in the browser.

---

## 8. Architecture contracts

Write and wire into `pnpm check`:

**8.1** `verify:package-boundaries` — dependency direction; no React/Vite/Supabase
/HTTP in kernel packages; no deep imports past a package's `exports`.

**8.2** `verify:kernel-purity` — no `Date.now()`, `Math.random()`,
`crypto.randomUUID()`, `fetch`, or `fs` in a kernel package.

**8.3** `verify:no-ai-in-kernel` — no LLM client imported by a kernel package.

**8.4** `verify:table-namespace` — every table a HELM migration creates is
`helm_*` or on the shared-core allowlist.

**8.5** `verify:org-scope` — every `helm_*` table has `org_id`; every policy
predicate references it.

**8.6** `verify:rls-coverage` — RLS enabled with policies per needed operation.

**8.7** `verify:append-only` — `helm_decision_events` has no UPDATE/DELETE policy.

**8.8** `verify:additive-migrations` — no `DROP`/`ALTER` targeting a Memoire
table.

**8.9** `verify:memoire-boundary` — no kernel package reads a Memoire table.

**8.10** `verify:ontology-core` — no kernel package references a non-core type
code as a string literal.

**8.11** `pnpm check` = `build && typecheck && lint && test && verify:*`.

**Gate.** Every script passes, and each fails correctly when deliberately
violated (test the tests).

---

## 9. Documentation and close-out

**9.1** `docs/architecture/phase-1-implemented.md` — what was built, decisions
taken, deviations from this backlog and why.

**9.2** Update the roadmap's Phase 1 row to done; mark Phase 2 next.

**9.3** New ADRs for any foundational decision taken during implementation that
is not already covered here.

**9.4** Update `README.md`: monorepo layout, `pnpm` commands, ontology explorer.

**9.5** `docs/api/ontology.md` — the public surface of `ontology` and
`graph-store`.

**9.6** Name the remaining technical debt explicitly, including anything this
phase deferred.

---

## Definition of done

Per [roadmap.md §9](../architecture/roadmap.md#9-definition-of-done-every-phase-from-19):

- [ ] `pnpm check` green: build, typecheck, lint, tests, all `verify:*`
- [ ] Both `GraphStore` adapters pass one conformance suite
- [ ] Cross-org isolation proven by integration test against the real database
- [ ] A Memoire opportunity projects into an entity with full provenance
- [ ] Traversal answers "what does this opportunity touch?" to depth 4
- [ ] Re-running ingestion produces no change (idempotent)
- [ ] `asOf` returns the historical graph
- [ ] Ontology extensible by inserting registry rows — no code change, no
      migration
- [ ] Ontology explorer navigable in the browser
- [ ] Existing 40 tests still green; existing app still works
- [ ] Docs updated; remaining debt named

## Out of scope for Phase 1

Value metrics, nodes, links and observations (Phase 2) · any calculation or
propagation (Phase 3) · changes to decisions, scenarios or signals (Phases 4–5) ·
authority redesign (Phase 6) · any new management surface (Phase 14) · any AI
(Phase 11) · real ERP/Finance/SCM connectors (Phase 13) · moving the app into
`apps/` (step 3, Phase 2 — Phase 1 only *adds* packages).

## Known risks

| Risk | Mitigation |
| --- | --- |
| No version control | task 0, blocking |
| npm → pnpm lockfile churn | do it in isolation (1.4) with a green gate before anything moves |
| Recursive CTE complexity | in-memory adapter first, as the reference semantics; CTE must match it |
| Over-modelling the seed ontology | seed only what the canonical scenario needs; types are data, so additions are cheap |
| Scope creep into Phase 2 | explorer is read-only, no charts, no metrics |
| Attribute creep re-introducing duplication | `verify:no-duplicated-fields` lands in Phase 2; review 6.1/6.2 by hand until then |
