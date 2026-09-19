# ADR-0004: Graph abstraction layer over relational tables; defer a graph database

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

HELM's kernel is graph-shaped: an ontology of entities and relationships, a value
graph of nodes and links, a causal graph of hypotheses. Traversal is a core
operation — "what does this opportunity touch?", "every path from this gap to
enterprise value", "what feeds this number?".

The brief is explicit (§10): do not introduce Neo4j immediately; use PostgreSQL
tables with recursive queries; **build a graph abstraction layer** so a later move
to Neo4j, Memgraph or Neptune does not rewrite the domain.

## Problem

How is graph storage represented and accessed so the kernel is genuinely portable
across graph engines — and not merely claimed to be?

## Options considered

1. **Neo4j now.** Native traversal, mature Cypher. Costs: a second database to
   operate and secure, loss of RLS-based isolation for graph data (a hard
   regression), loss of transactional consistency with `helm_decisions`, and a
   sync problem between two stores. Premature by the brief's own guidance.
2. **Postgres tables, queried directly from domain code.** Simplest to write.
   Recursive CTEs leak into every consumer, so a future migration touches
   everything. The abstraction layer would exist only as an intention.
3. **Postgres tables behind a `GraphStore` port, one adapter.** Domain code speaks
   traversal, not SQL. But with a single adapter, nothing tests whether the
   abstraction actually holds — the Postgres adapter's incidental behaviours leak
   into the contract unnoticed.
4. **`GraphStore` port with two adapters from day one** — Postgres and in-memory —
   both passing one shared conformance suite.

## Decision

**Option 4.** `packages/graph-store` defines the `GraphStore` port
([kernel-interfaces.md §2](../architecture/kernel-interfaces.md#2-graph-store--the-persistence-port))
and ships two adapters in Phase 1:

- `PostgresGraphStore` — recursive CTEs over `helm_entities` /
  `helm_relationships` via Supabase, RLS-enforced.
- `InMemoryGraphStore` — the same contract over plain objects.

**One conformance suite runs against both.** This is the mechanism that makes the
abstraction real: an adapter-specific assumption fails immediately in the other
adapter, at the moment it is introduced rather than at migration time years
later.

Design constraints on the port:

- **Traversal is a first-class operation**, not composed from repository calls.
  `traverse()` and `paths()` are what a graph engine implements natively; a port
  built only from `getById`/`findMany` would force N+1 access patterns that no
  adapter can optimise.
- **`maxDepth` is required.** An unbounded traversal is a defect, not a
  convenience.
- **Temporal and scenario filters are in the port** (`asOf`, `scenarioId`), not
  applied afterwards by callers — otherwise every consumer reimplements them and
  they diverge.
- **`pathConfidence` is part of a returned path.** A long chain is never highly
  confident, and computing that in the store keeps it consistent everywhere.
- **No SQL, and no Supabase import, outside the Postgres adapter.** Asserted by
  `verify:package-boundaries`.

Additional benefits the in-memory adapter buys immediately, beyond portability:
every kernel package becomes testable with no database, and the demo organization
runs fully offline — which the existing demo mode already requires.

## Consequences

**Good.** The kernel never learns SQL. A graph-engine migration is one new
adapter plus a data copy. Kernel tests run in milliseconds with no database.
Demo mode keeps its no-network guarantee. Graph data keeps RLS isolation and
stays transactional with decisions.

**Bad.** The port is extra code to design and maintain, and every new traversal
need must be expressed in it rather than written ad hoc. Recursive CTEs are harder
to write and tune than Cypher.

**Risk — an abstraction that quietly becomes Postgres-shaped.** The conformance
suite is the guard, and it must run in CI on both adapters from the first commit.
If a feature can only be implemented in one adapter, that is a signal to change
the port, not to special-case the adapter.

**Risk — recursive CTE performance at depth.** Unknown until real graphs exist.
Mitigation: required `maxDepth`, indexes on `(org_id, from_entity_id, type_code)`
and `(org_id, to_entity_id, type_code)`, and measurement before optimisation. If
propagation becomes the bottleneck, a materialised closure table is the next step
— behind the same port.

## Migration implications

- Phase 1 creates `helm_entities` and `helm_relationships` with indexes chosen for
  traversal in both directions.
- Should a graph database later be justified, the trigger is measured: traversal
  latency at realistic depth and breadth. The move is a new adapter plus an export
  — the domain does not change.
- If a closure/materialised-path table is introduced, it is an adapter
  implementation detail and does not appear in the port.
