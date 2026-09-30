# Value graph — layer reference

> **Layer reference.** This file began as the record of the build step that introduced the layer; "Phase N" in the text names that step, not a stage of the product. HELM is one system — read [the architecture](../helm-architecture.md) first. Anything the text says a later step would add now exists: see the other layer references and ADRs 0029–0033.

What was built, the decisions taken during implementation, the deviations and
the debt. A record, not a plan.

**Delivered 2026-09-19.** Branch `phase-1-enterprise-ontology`, building on
Phase 1 (`1ba3eea`).

## 1. What exists now

### `@helm/value-graph`

| Module | Contents |
| --- | --- |
| `types.ts` | 9 value dimensions, 10 unit types with bounds, 8 aggregation behaviours, 5 directionalities, 4 temporal behaviours, 12 value link types, 7 observation types |
| `seed.ts` | 30 shipped metric definitions with full machine-readable semantics |
| `registry.ts` | metric validation (unit, currency, bounds, time context, observation typing) + `validateMetricRegistry` self-check |
| `port.ts` | the `ValueGraph` interface |
| `inMemory.ts` / `postgres.ts` | two adapters, one conformance suite |
| `canonicalValueChain.ts` | the Meridian value layer: 33 nodes, 39 links, 40 observations |

### Database — 4 new tables, all additive

```
helm_value_metrics        dimension, unit, aggregation, directionality,
                          temporal behaviour, scope compatibility
helm_value_nodes          (metric × subject entity × scope × horizon)
helm_value_links          12 typed dependencies; no CAUSES
helm_value_observations   many coexisting typed claims per node
```

Plus a widened `helm_provenance.subject_kind` CHECK (value_node, value_link,
value_observation) and two integrity triggers.

### Application

One new route, `/value-graph` — the Value Graph Explorer. Read-only, no charts,
no scores.

## 2. Decisions taken during implementation

### 2.1 Specialized storage, not the Phase 1 GraphStore

[ADR-0015](../../adr/0015-value-graph-specialized-storage.md). The deciding
argument was **cardinality of truth**: an ontology entity has one current state
with a superseding version chain, while a value node has many concurrent values
that do not supersede each other. The 38% actual, the 35% forecast and the 40%
target are all current and all different kinds of fact. Forcing that into the
entity model would have destroyed exactly the distinction Phases 4, 7 and 10
depend on.

### 2.2 Enterprise value is six nodes, not one score

The canonical chain terminates in six value nodes attached to the
`EnterpriseValue` entity — cash, margin, service, risk, strategic, capital —
spanning five dimensions with opposing directionalities. `verify:value-metrics`
fails if any metric named like an enterprise-value score is introduced.

This is the structural answer to §31: HELM can represent that expediting the
shipment raises service and lowers margin and cash, without pretending it knows
how to weigh them.

### 2.3 `percentage` and `ratio` are different unit types

38% and 0.38 are the same proportion written two ways, and silently mixing them
is the exact failure §9 warns about. A `percentage` is 0–100; a `ratio` is 0–1;
both are bounded in TypeScript **and** by a database trigger.

The honest limit, recorded in `verify:value-observations`: 0.84 recorded as a
percentage is inside 0–100 and cannot be caught by range alone. That is why
`unit_type` is required and explicit on every observation rather than inferred —
the declaration is the defence, not the bound.

### 2.4 Scenarios are referenced through ontology entities

A `SCENARIO` observation references a `Scenario` *entity*, never
`helm_scenarios`. That single indirection is what keeps the Value Graph
decoupled from the existing Scenario Engine while making the future integration
mechanical — see
[scenario-decision-integration.md](../scenario-decision-integration.md).

### 2.5 Two metrics were rejected by my own registry check

`CapacityUtilization` and `StrategicAlignment` declared `WEIGHTED_AVERAGE`
without saying what they were weighted by. `validateMetricRegistry` caught both
before the seed reached the database. They now declare `weightBy`.

That is the aggregation semantics doing their job years before the aggregation
engine exists.

## 3. Deviations from the Phase 2 plan

### 3.1 No projection of existing tables

§12 asked for care here, and the careful answer turned out to be "not yet".
Every table proposed for projection (`helm_cost_objects`,
`helm_inventory_items`, `helm_processes`) is **empty** in the shared database,
and projection needs a consumer to be testable — which arrives in Phase 3.

Each decision is recorded per table in
[projection-decisions.md](../projection-decisions.md), with the governing rule:
*if an object would generate entities in proportion to transaction volume it is
the wrong altitude; if in proportion to the management model, project it.*

### 3.2 Scenario/Decision adapters documented, not built

§22 and §23 offered "thin adapter if low-risk, or document and defer". Deferred,
because Phase 4 will very likely reshape scenario variants into sparse graph
overrides ([ADR-0011](../../adr/0011-reconcile-decision-and-value-models.md) §3) and
building the adapter against today's shape would mean building it twice.

The contract is written and the seam is already in place.

### 3.3 The Postgres conformance suite still cannot run

Unchanged from Phase 1, and flagged again as required. Running it needs an
authenticated session; creating auth accounts or authenticating with passwords
is outside what I will do. Both suites are written, wired and skip with
instructions.

What was verified instead, server-side against the live database: **21
assertions** covering RLS isolation across value nodes, links and observations;
the unit-integrity trigger; scenario-context constraints in both directions;
time-context requirements; the calculation-run prohibition; cross-org node and
link triggers; metric semantic constraints; and observation append-only
behaviour. All passed, all test rows removed.

### 3.4 `verify:schema` taught to accept constraint widening

Widening a CHECK on a HELM-owned table (drop with `IF EXISTS`, immediately
re-add the same name in the same migration) is additive evolution. Narrowing or
dropping without replacement still fails, and dropping one on a Memoire table is
refused by `verify:memoire-boundary` as before. Negative-tested both ways.

## 4. Test results

```
npm run typecheck   clean
npm run lint        clean
npm test            166 tests, 164 pass, 2 skipped (both Postgres conformance)
npm run build       clean
npm run verify      9/9 contracts pass
```

New in Phase 2: 24 ValueGraph conformance tests, 14 canonical value chain tests,
4 verification contracts. All 126 Phase 0/1 tests still green.

| Contract | Asserts |
| --- | --- |
| `verify:value-schema` | 4 tables org-scoped; observations append-only; scenario context both directions; unit/currency coherence; no calculation runs; metric semantics; nodes reference rather than duplicate; no causal link types |
| `verify:value-metrics` | no duplicates or thin descriptions; no summable proportions; weighted averages declare their weight; target ranges declare their range; canonical coverage; every dimension populated; no collapsed enterprise-value score; migration matches seed |
| `verify:value-graph` | canonical chain builds and is idempotent; connects both directions; enterprise value spans ≥5 dimensions; bounded traversal; contention queryable; tenant isolation; **no propagation code and no propagation behaviour** |
| `verify:value-observations` | scenario context; unit integrity; currency presence; time context; type coexistence; reality separable; every observation traceable; hand-entered actuals need provenance |

Each was negative-tested.

## 5. Security

21 live assertions (§3.3). Supabase security advisors report **no new
findings** — the pre-existing five `SECURITY DEFINER` warnings are the Phase 0
org helpers.

Memoire unchanged throughout: 1,106 accounts / 127 opportunities.

## 6. Technical debt

| Debt | Why | When |
| --- | --- | --- |
| Postgres conformance unexecuted (both suites) | needs authenticated test credentials | when a Supabase branch + token exist |
| No projection of existing domain tables | needs a Phase 3 consumer | Phase 3 |
| Scenario/Decision adapters not built | would be built twice | Phases 4–5 |
| Scenario chain view shows "no value" for nodes without scenario observations | correct, and reads oddly in the explorer | Phase 3 makes derived scenario values real |
| Value-link traversal is client-side BFS | same reasoning as Phase 1 | when measured |
| No FX normalization | currency is explicit per observation; conversion deferred | when a second reporting currency appears |
| `PipelineCoverage` has no node in the canonical chain | seeded for completeness, unused | when pipeline enters the model |
| Unit-level / functional RLS | Phase 1 debt, unchanged | Phase 6 — still gates the cockpit |

## 7. What Phase 2 proved, and did not

**Proved.** The enterprise is structurally connected through value: an
opportunity reaches six enterprise-value dimensions through demand, inventory,
capital and margin; the chain walks both ways; two value streams contend for one
inventory position with the claimed quantity visible; four kinds of claim coexist
on one node without collapsing; every observation traces to a source.

**Did not.** Nothing is calculated. Expected revenue is 2.94B because Memoire
said so, not because HELM multiplied 4.2B by 0.7. Moving probability to 0.9
changes nothing downstream — asserted as a *passing test*, because that is the
Phase 2/3 boundary.
