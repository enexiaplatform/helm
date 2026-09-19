# Phase 1 — Enterprise Ontology (implemented record)

What was built, the decisions taken during implementation, the deviations from
the plan and why, and the debt that remains. Written as a record, like
[implemented-mvp.md](implemented-mvp.md), not as a plan.

**Delivered 2026-09-19.** Branch `phase-1-enterprise-ontology`, baseline commit
`4fe5387`.

## 1. What exists now

### Packages (npm workspaces, consumed from source)

| Package | Contents |
| --- | --- |
| `@helm/shared` | branded ids, `Result`/`HelmError` + error-code taxonomy, `Scope`, valid/record time primitives, `Clock`/`IdGen` ports, provenance vocabulary |
| `@helm/ontology` | entity/relationship type defs, `OntologyRegistry` (inheritance, JSON-Schema attribute validation, category constraints), canonical-key rules, the seed taxonomy, `validateOntology` self-check |
| `@helm/graph-store` | the `GraphStore` port, `InMemoryGraphStore`, `PostgresGraphStore`, the shared conformance suite, and the canonical scenario builder |

### Database — 8 new tables, all `helm_*`, all additive

```
helm_entity_types         registry: key, category, parent, attribute JSON Schema,
                          version, status, is_system, nullable org_id
helm_relationship_types   registry: key, category, directedness, weight support,
                          category constraints, inverse key
helm_entities             stable id, canonical key, inline provenance,
                          valid time + record time, confidence, attributes
helm_entity_versions      append-only record-time chain (immutability trigger)
helm_relationships        typed, weighted, confidence-bearing, temporal edges
helm_entity_aliases       external identifiers -> one entity, with match_method
helm_provenance           polymorphic: ingested | seeded | derived | calculated |
                          human_assumption | inferred
helm_ingestion_events     batches, so provenance groups by connector run
```

Plus one RPC, `helm_write_entity` (SECURITY INVOKER), and a unique index making
aliases idempotent.

Seeded: **43 entity types, 34 relationship types**, all `org_id IS NULL`,
`is_system = true`.

### Application

One new route, `/ontology` — the Ontology Explorer. Read-only, no charts. It
exists to let a reviewer confirm the kernel is real, and nothing else.
`src/services/ontologyGraph.ts` is the single place that chooses an adapter, so
no page imports one.

## 2. Decisions taken during implementation

### 2.1 Entity identity is stable; history is a separate chain

`helm_entities.id` does not change across versions, and `helm_entity_versions`
holds the record-time chain. The alternative — a new row per version — would
have forced every relationship to be rewritten whenever an entity changed,
turning a single attribute update into graph-wide write amplification.

Consequence: relationships use a real foreign key, and superseding an entity
never orphans an edge. Recorded in [ADR-0014](../adr/0014-bitemporal-lite.md).

### 2.2 Registry ids are readable text, not uuids

`et_opportunity`, `rt_belongs_to`. The registry is small and fixed; a readable
deterministic id makes fixtures, debugging, and — most importantly —
cross-adapter equivalence straightforward, because the in-memory store and the
database agree on type ids without coordinating.

### 2.3 One RPC for the entity write path

The REST client cannot open a transaction, so writing an entity and closing its
previous version as two calls could leave history half-written. `helm_write_entity`
does both in one statement batch. It is `SECURITY INVOKER`, so the caller's RLS
applies unchanged — atomicity, never privilege escalation.

### 2.4 `includeInactive` without `asOf` is an archival query

Found by the conformance suite: retiring an entity closes its validity window, so
a current-time filter would make retired entities permanently unreachable. The
rule is now explicit in the port and asserted for both adapters.

### 2.5 Aliases are idempotent

Found by `verify:graph`: re-running the canonical build duplicated alias rows, so
one entity resolved twice from one identifier. Fixed in both adapters and backed
by a partial unique index. A conformance test now locks it in.

## 3. Deviations from the Phase 1 plan

### 3.1 npm workspaces, not pnpm + Turborepo — and `node --test`, not Vitest

Per the phase instruction to keep the existing package manager unless it
materially blocks the architecture. It does not: npm workspaces give per-package
manifests, explicit `exports`, declared dependencies and workspace linking, which
is everything the kernel boundary needs. Recorded, with revival triggers, in
[ADR-0012](../adr/0012-defer-pnpm-turborepo-and-vitest.md).

### 3.2 Traversal is batched BFS, not a recursive CTE

[ADR-0004](../adr/0004-graph-abstraction-layer.md) anticipated recursive CTEs.
The adapter instead does level-by-level BFS with **one batched query per level**,
so round trips are bounded by `maxDepth` (≤12), not by node count.

Why: it keeps the Postgres traversal semantics structurally identical to the
in-memory reference, which is what makes cross-adapter equivalence checkable
rather than hoped for. A recursive CTE would reimplement undirected-edge
handling, valid-time filtering and path-confidence in SQL, where any divergence
is far harder to see.

**Trigger to revisit:** measured traversal latency at realistic depth and
breadth. The change is confined to the adapter and needs no port change.

### 3.3 The full TS conformance suite has not been run against Postgres

This is the significant gap, and it is a constraint rather than an omission.
Running it needs an authenticated session, and creating auth accounts or
authenticating with passwords is outside what I will do. So:

- `packages/graph-store/test/postgres.conformance.test.mjs` is **written and
  wired**, and skips with instructions until credentials are supplied.
- The Postgres write path was instead verified **server-side** with 13 assertions
  against the live database (create / idempotent no-op / supersede / version
  chain closure / snapshot retention / constraint enforcement), all passing, all
  test rows removed afterwards.
- RLS isolation was proven **server-side** with 11 assertions under simulated JWT
  claims for two principals (see §5).

To close it, supply the env vars in that file's header **against a Supabase
branch, not production**, and run `npm test`.

### 3.4 `helm_org_settings.org_id` uses PRIMARY KEY rather than NOT NULL

Pre-existing from Phase 0; PRIMARY KEY implies NOT NULL, so the invariant holds.
`verify:schema` accepts either form.

## 4. Test results

```
npm run typecheck   clean
npm run lint        clean
npm test            127 tests, 126 pass, 1 skipped (Postgres conformance), 0 fail
npm run build       clean (5.3s)
npm run verify      5/5 contracts pass
```

Breakdown: 40 pre-existing engine/state-machine tests (unchanged, still green),
44 shared + ontology unit tests, 29 GraphStore conformance tests, 13 canonical
scenario tests, 1 skipped.

| Contract | Asserts |
| --- | --- |
| `verify:architecture` | dependency direction, kernel purity, no AI in kernel, no deep imports, no logic in components |
| `verify:schema` | namespace, org scoping, RLS enabled, policy coverage, append-only, bitemporal columns, no destructive DDL |
| `verify:ontology` | ontology integrity, naming, causal types absent, canonical coverage, migration matches seed |
| `verify:graph` | canonical graph, idempotency, bounded traversal, confidence decay, provenance coverage, record-time history, tenant isolation |
| `verify:memoire-boundary` | no kernel/app access to Memoire tables outside the bridge, no writes beyond `commercial_events`, no migration touching Memoire |

Each was negative-tested: a deliberately injected violation of every rule class
was confirmed to fail the script before being reverted.

## 5. Security verification

Executed against the live shared database with simulated JWT claims for two
existing principals, then fully cleaned up. All 11 assertions passed:

1. A member reads their own organization's entities
2. …and reads **zero** of another organization's, by filter
3. …and cannot read a foreign entity by id
4. …nor its relationships
5. …nor its entity versions
6. …nor its provenance
7. An alias value present in **both** organizations resolves to only one
8. A write into a foreign organization is refused
9. A version snapshot cannot be mutated (immutability trigger fires)
10. Provenance cannot be deleted (no DELETE policy)
11. The shipped ontology (43 types) is readable by any authenticated user

Supabase security advisors report **no new findings**. The five pre-existing
`SECURITY DEFINER` warnings are the Phase 0 org helpers, which must be callable
in policy context by design.

## 6. Memoire integrity

Row counts before and after every migration and test, unchanged:

| Table | Rows |
| --- | --- |
| `accounts` | 1,106 |
| `opportunities` | 127 |
| `stakeholders` | 1,752 |
| `commercial_events` | 13 |

No Memoire table, policy, index, trigger or function was altered or dropped.
`public.entities` and `public.relationships` — Memoire's own capture tables —
remain untouched and separate from `helm_entities` / `helm_relationships`.

## 7. Technical debt introduced

| Debt | Why it exists | When it should be paid |
| --- | --- | --- |
| Postgres conformance not executed | needs authenticated test credentials | as soon as a Supabase branch + token are available |
| Traversal is BFS, not a recursive CTE | semantic parity preferred over round-trip count | when traversal latency is measured and matters |
| Valid-time filtering is partly client-side in the Postgres adapter | keeps semantics identical to the in-memory reference | with the CTE work, pushing predicates into SQL |
| `SupabaseLike` uses `any` on two lines | a fluent builder cannot be typed structurally | if supabase-js exposes a usable builder type |
| No record-time *traversal* | only `getEntityHistory` per entity; the data exists | Phase 10, for counterfactuals |
| Existing tables not yet projected as entities | `helm_cost_objects` etc. still live outside the graph | Phase 2, with the value graph |
| 3 npm audit advisories | pre-existing (react-router, js-yaml via eslint) | on the next dependency refresh |
| Line-ending normalization | no `.gitattributes`; deliberately excluded from the baseline commit | next housekeeping commit |
| Unit-level and functional RLS | Phase 1 wall is the organization only | Phase 6 — **gates the GM Cockpit** |

## 8. What Phase 1 proves, and what it does not

**Proves.** HELM can represent an enterprise as a connected semantic system: a
commercial opportunity reaches enterprise value through the operational and
financial chain along **nine distinct routes**, each with a computed confidence;
two opportunities contend for one inventory position and the competition is
modelled explicitly; one management entity resolves from three different source
systems' identifiers; every fact carries where it came from, when the source
asserted it, and when HELM learned it — separately.

**Does not prove.** Nothing is *computed* yet. There are no value metrics, no
calculations, no propagation. The graph knows that an opportunity consumes an
inventory position; it cannot yet tell you the inventory gap, the working-capital
draw, or the margin effect. That is Phases 2 and 3, and it is the honest limit of
this phase.

See the Phase 1 report for the full argument.
