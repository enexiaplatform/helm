# ADR-0007: Entities reference source rows; the graph never duplicates them

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

HELM must model the enterprise as an interconnected system of value, drawing on
Memoire, ERP, SCM, Finance and HRIS — and on its own tables
(`helm_cost_objects`, `helm_inventory_items`, `helm_processes`,
`helm_economics`).

The naive reading of "build an enterprise value graph" is to load everything into
graph nodes. That reading has a name in integration work: it is a data warehouse,
and it brings a sync problem, a staleness problem, and two competing truths for
every field.

HELM already rejected this for Memoire. `helm_decisions` stores
`memoire_opportunity_id` plus an immutable `context_snapshot` — a reference and a
record of what was seen, never a copy. That decision was right, and this ADR
generalises it.

## Problem

What exactly is stored in a graph node, given that the underlying facts live in
tables HELM may not own and must not duplicate?

## Options considered

1. **Full materialisation.** Copy source attributes into `helm_entities`. Fast
   traversal, self-contained graph. Every copy is stale the moment it is written;
   needs a sync pipeline per source; two answers to "what is this opportunity
   worth?"; and it re-creates inside HELM the fragmentation HELM exists to solve.
2. **Pure virtual graph.** Nodes are computed on the fly from source queries,
   nothing persisted. No staleness; but no temporal history, no provenance
   records, no way to attach a scenario override to an edge, and traversal
   requires federated queries across systems. Unworkable for propagation.
3. **Reference + projection.** An entity is an identity and a position in the
   model: type, natural key, name, provenance, validity, confidence. Substantive
   numbers stay in their own tables and are read through the source reference.
   Only *management-relevant derived* values are persisted, as value observations
   with a calculation trace.
4. **Reference + full snapshot on every change.** Option 3 plus a complete
   attribute snapshot per version. Full history and self-contained queries, at
   the cost of large storage growth and the same two-truths problem for current
   values.

## Decision

**Option 3**, with option 4's snapshot applied narrowly and deliberately.

An `helm_entities` row carries:

| Field | Purpose |
| --- | --- |
| `type_code` | its place in the ontology |
| `natural_key` | stable identity: `memoire:opp:123`, `helm:inv:SKU-X@WH1` |
| `name` | human label, for display and search |
| `attributes` | **only** attributes with no other home, or needed for traversal filtering |
| `source_system` + `source_ref` | where the truth lives |
| `observed_at` | when the source asserted it |
| `valid_from` / `valid_to` | temporal position |
| `confidence` | how much to trust it |

It does **not** carry the opportunity's value, the inventory's stock level, or the
cost object's revenue. Those are read from `opportunities`,
`helm_inventory_items` and `helm_economics`.

### Where snapshots do apply

Two places, both because the record must not change under a manager's feet:

1. **`helm_decisions.context_snapshot`** — what the manager saw when deciding.
   Already implemented.
2. **`helm_value_observations`** — a computed value is persisted with its
   `calculation_run_id`. A derived number *is* a fact about a moment, so
   recomputing it later must not silently rewrite history.

The distinction that makes this coherent: **source facts are referenced; derived
values are recorded.** A derived value cannot be re-read from a source system,
because no source system computed it.

### Consequences for existing tables

`helm_cost_objects`, `helm_inventory_items`, `helm_processes` and
`helm_economics` keep their shape and keep working. Each gains a projected
`helm_entities` row with `source_system='helm'` and `source_ref` = its id.

This is why Phases 1–3 do not require rewriting the existing application: the
graph is added *over* the current tables, and the eight engines keep reading the
tables they already read.

## Consequences

**Good.** No sync pipeline, no staleness, one truth per field. Ownership stays
where it belongs. Existing tables and engines are unaffected. Storage grows with
the *model*, not with transaction volume. The Memoire boundary is structurally
preserved — an entity cannot drift into being a copy, because it has nowhere to
put the copied values.

**Bad.** A traversal that needs attribute values must join to source tables — a
resolver step, and an N+1 risk if written carelessly. Cross-system queries cannot
be a single SQL statement. A source row that disappears leaves a dangling
reference.

**Risk — attribute creep.** `attributes` becomes a convenient dumping ground and
option 1 arrives through the back door. Mitigation: `attributes` is for values
with no other home (a manager's assumption) or needed for traversal filtering (a
product's segment). `verify:no-duplicated-fields` asserts that no
`helm_entities.attributes` key shadows a column in the referenced source table.

**Risk — N+1 resolution.** Mitigation: batch resolvers per source system in the
`graph-store` adapter, keyed by `source_ref`, so one traversal produces one query
per source table.

**Risk — dangling references.** Mitigation: entities are superseded, not deleted,
and a resolution failure surfaces as a stale-provenance warning on the entity
rather than a crash.

## Migration implications

- Phase 1 creates `helm_entities` with `source_system` and `source_ref` and a
  unique index on `(org_id, type_code, natural_key)`.
- Phase 2 adds projection for existing HELM tables — an insert per row, no schema
  change to those tables.
- Phase 13's connector `translate()` produces entities carrying
  `source_system='memoire'` and `source_ref` = the Memoire row id, never its
  values.
- If a future source becomes unavailable or read-latency makes resolution
  impractical, a per-source materialised cache may be added **inside the adapter**,
  with its own freshness metadata. That is a caching decision, not a model change,
  and it does not alter this ADR.
