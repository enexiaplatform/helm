# ADR-0015: The Value Graph gets specialized storage, not the generic GraphStore

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 2
**Builds on** [ADR-0004](0004-graph-abstraction-layer.md) ·
[ADR-0007](0007-value-graph-projection.md)

## Context

Phase 1 delivered a generic semantic graph: `helm_entities` and
`helm_relationships` behind a `GraphStore` port, with two adapters held to one
conformance suite. It answers *what exists and how is it related*.

Phase 2 must answer a different question: *how do these entities participate in
creating, consuming, constraining and destroying value*. That needs three things
the ontology does not have — metrics with machine-readable semantics, typed
value dependencies between quantities, and observations that distinguish what is
from what we expect, want, and might get.

The obvious temptation is to express all of it in the existing graph: a value
node is "just" an entity of type `ValueNode`, a value link is "just" a
relationship. That would be elegant, and it would be wrong.

## Problem

Is the Value Graph stored as ontology entities and relationships, or as its own
tables referencing ontology entities?

## Options considered

1. **Everything through the Phase 1 GraphStore.** One storage model, one port,
   one conformance suite, no new tables. But:
   - Metric semantics (dimension, unit type, aggregation behaviour,
     directionality, temporal behaviour) would live in `attributes jsonb`, where
     no constraint can check them. "Percentage metric receives a currency unit"
     becomes undetectable at the database, which is precisely the failure §9 of
     the phase brief exists to prevent.
   - **Observations have no equivalent at all.** An entity is a thing that
     exists with one current state and a version chain. An observation is one of
     *many simultaneous* claims about the same node — an actual, a forecast, a
     target and three scenario values all true at once, none superseding the
     others. Forcing that into the supersede-based entity model would either
     destroy the distinction or abuse versioning to mean something it does not.
   - Value links carry `linkType` semantics (`DRIVES`, `CONSUMES`, `REDUCES`)
     that overlap confusingly with ontology relationship types but mean something
     different: a dependency between *quantities*, not between *things*.
2. **A separate service with its own database.** Clean separation, and it breaks
   referential integrity to `helm_entities`, loses transactional consistency, and
   adds infrastructure the brief excludes.
3. **Specialized tables in the same database, referencing ontology entities by
   foreign key, behind their own `ValueGraph` port.** Metric semantics become
   columns with constraints. Observations get a table shaped like observations.
   Value links get their own type vocabulary. The ontology stays the semantic
   spine and is referenced, never duplicated.

## Decision

**Option 3.**

```
helm_value_metrics        metric definitions: dimension, unit type, aggregation,
                          directionality, temporal behaviour, scope compatibility
helm_value_nodes          (metric × subject entity × scope × horizon)
helm_value_links          typed value dependencies between nodes
helm_value_observations   many coexisting claims per node, each typed
```

`helm_value_nodes.subject_entity_id` is a real foreign key into
`helm_entities`. The Value Graph *references* the ontology; it never copies it,
which is [ADR-0007](0007-value-graph-projection.md) applied one layer up.

A new package `@helm/value-graph` defines the `ValueGraph` port with in-memory
and Postgres adapters, held to one shared conformance suite — the same
two-adapter discipline as [ADR-0004](0004-graph-abstraction-layer.md), for the
same reason.

### Why the brief's "prefer specialization" instinct is right here

The two graphs differ in their **cardinality of truth**. In the ontology, an
entity has one current state; history is a chain of superseded versions. In the
Value Graph, a node has *many concurrent values* that do not supersede each
other — the 38% actual, the 35% forecast and the 40% target are all current, and
all different kinds of fact.

That is not a storage-layout preference. It is a different model of what "true"
means, and collapsing the two would lose the distinction that Phases 4, 7 and 10
are built on.

### What the two graphs share

- The same organization scoping and RLS approach.
- The same provenance mechanism — `helm_provenance` is extended with new subject
  kinds rather than duplicated ([ADR-0013](0013-provenance-as-first-class-records.md)).
- The same temporal discipline — valid time vs record time
  ([ADR-0014](0014-bitemporal-lite.md)).
- The same bounded-traversal rule: `maxDepth` is required, never optional.
- The same registry-as-data approach for metric definitions
  ([ADR-0006](0006-data-driven-ontology.md)), so an organization can add its own
  metrics without a migration.

### Package dependency

`@helm/value-graph` depends on `@helm/graph-store` (the port) so it can verify
that a subject entity exists and belongs to the caller's organization before
attaching a value node to it. Dependencies point inward, as ADR-0002 requires:
`value-graph → graph-store → ontology → shared`.

### What this ADR does NOT authorise

No calculation. No propagation. A value link records that demand *depends on*
expected revenue; nothing recomputes demand when revenue changes. That is
Phase 3, and `verify:value-graph` asserts the absence — a formula or evaluator
inside `@helm/value-graph` fails the build.

## Consequences

**Good.** Metric semantics are enforceable at the database, not hoped for in
JSON. Observations get a model that fits them, so actual/forecast/target/scenario
stay distinguishable — which is the prerequisite for scenario comparison, the
digital twin, forecast-accuracy learning and counterfactuals. Value link
vocabulary stays separate from ontology relationship vocabulary, so `CONSUMES`
in the value graph cannot be confused with `CONSUMES` between entities.

**Bad.** A second port, a second adapter pair and a second conformance suite to
maintain. Queries spanning both graphs need two reads. Engineers must learn which
graph answers which question — mitigated by the rule of thumb: *the ontology
holds nouns, the value graph holds quantities.*

**Risk — the two graphs drift apart.** Mitigation: value nodes reference
entities by foreign key, and `verify:value-graph` asserts every node's subject
entity exists in the same organization.

**Risk — duplicated traversal logic.** Both graphs need bounded BFS with
confidence chaining. Mitigation: the confidence-chaining helper lives in
`@helm/shared` and is used by both, so the two cannot disagree about what a path
confidence means.

## Migration implications

- Phase 2 adds four `helm_value_*` tables plus a widened `subject_kind` CHECK on
  `helm_provenance` (a HELM-owned, empty table — a widening, not a narrowing).
- No Phase 1 table changes shape.
- Should the two graphs later prove to want one storage model after all, the
  `ValueGraph` port is the seam that makes that an adapter change.
