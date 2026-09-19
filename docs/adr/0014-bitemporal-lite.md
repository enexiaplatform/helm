# ADR-0014: Bitemporal-lite — separate valid time from record time

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 1

## Context

Enterprise state is not timeless, and the two ways it moves through time are
genuinely different facts:

> A person was BU Head from January to June. HELM learned this in August.

"January to June" is **valid time** — when the fact was true in the world.
"August" is **record time** — when HELM came to know it. Collapsing them makes
two management questions unanswerable:

- *"Who was BU Head in March?"* — needs valid time.
- *"What did we believe in March, when that decision was made?"* — needs record
  time.

The second is not academic. It is the difference between judging a decision on
the information available at the time and judging it with hindsight. HELM's
outcome ledger and future counterfactual engine (Phase 10) are worthless without
it, and `helm_decisions.context_snapshot` already exists precisely because this
problem was recognised for commercial data.

Phase 0's design carried `valid_from` / `valid_to` and `observed_at` but did not
say how record time was preserved when a fact changes.

## Problem

How much temporal machinery does Phase 1 build, given that full bitemporal
modelling is notoriously heavy and the brief warns against disproportionate
complexity?

## Options considered

1. **Uni-temporal, valid time only.** `valid_from` / `valid_to`, updates in place.
   Simple. Loses "what did we believe then?" permanently — and it cannot be added
   retroactively, because the superseded values were overwritten.
2. **Full bitemporal, both dimensions on every row.** Four timestamps, temporal
   joins on both axes, overlap constraints, `AS OF` on two dimensions. Correct and
   heavy: every query gains two predicates, and Phase 1 would be spent on temporal
   algebra rather than the ontology.
3. **Bitemporal-lite.** Valid time as mutable columns on the current row; record
   time as an append-only version chain. Both dimensions preserved; only valid
   time is cheaply queryable in Phase 1; record-time reconstruction is available
   through an explicit history read.
4. **Event sourcing.** Every change an event, state a fold. Full history by
   construction. Disproportionate, and the brief explicitly excludes an event
   sourcing framework (§20).

## Decision

**Option 3.**

### Two structures

**`helm_entities` holds current state** with a stable `id`:

| Column | Dimension | Meaning |
| --- | --- | --- |
| `valid_from` / `valid_to` | valid time | when the fact is true in the world (`valid_to NULL` = still true) |
| `observed_at` | valid time | when the source asserted it |
| `ingested_at` | record time | when HELM first learned it |
| `updated_at` | record time | when HELM last changed it |
| `version` | record time | monotonic counter |

**`helm_entity_versions` is an append-only chain** — one row per change:

| Column | Meaning |
| --- | --- |
| `entity_id`, `version` | which entity, which revision |
| `snapshot jsonb` | complete entity state at that version |
| `recorded_from` / `recorded_to` | record-time window this version was believed (`recorded_to NULL` = current) |
| `valid_from` / `valid_to`, `observed_at` | the valid-time assertion of that version |
| `change_kind` | `created` · `updated` · `validity_closed` · `retired` |

### The identity decision that makes this work

**`helm_entities.id` is stable across versions.** Relationships reference it with
a real foreign key, and superseding an entity does not orphan its edges.

The alternative — a new row per version, with relationships pointing at version
rows — was rejected: every relationship would need rewriting on every entity
change, turning a single attribute update into a graph-wide write amplification.

### What each dimension can answer in Phase 1

| Question | Phase 1 |
| --- | --- |
| Who is BU Head now? | current row, `valid_to IS NULL` |
| Who was BU Head in March? | `valid_from <= T AND (valid_to IS NULL OR valid_to > T)` — implemented, `GraphStore` `asOf` |
| What did we believe in March? | `helm_entity_versions` where `recorded_from <= T AND (recorded_to IS NULL OR recorded_to > T)` — **implemented as `getEntityHistory`, not yet as graph traversal** |
| What did the whole graph look like in March? | **not implemented.** Requires record-time traversal across relationships |

The last row is the deliberate limit. Record-time *traversal* arrives when Phase
10's counterfactual engine needs it. The data to support it is being captured
from day one, which is the entire point of doing this now rather than later:
**record time cannot be reconstructed retroactively.** A fact overwritten today is
gone.

### Relationships

Relationships carry the same valid-time columns and are **closed, never deleted**
— `removeRelationship` sets `valid_to`. There is no `helm_relationship_versions`
chain in Phase 1: relationships change far less than entity attributes, and their
create/close lifecycle is already recorded in `helm_provenance`
([ADR-0013](0013-provenance-as-first-class-records.md)). If relationship
attribute churn proves material, a version chain is added by the same pattern.

## Consequences

**Good.** Both temporal dimensions are captured from the first row written. Valid
time is queryable now, cheaply. Stable entity ids keep the graph's referential
integrity simple. Full bitemporal traversal remains reachable without a data
migration, because the data exists.

**Bad.** Two writes per entity change (current row plus version row). Snapshots
are whole-entity, so storage grows with churn rather than with delta size.
Record-time queries are a separate API rather than a filter on traversal, which is
an inconsistency users of the port will notice.

**Risk — version-chain growth.** A chatty source could version an entity
thousands of times. Mitigation: versions are written only when content actually
changes — a re-ingest with identical values updates `updated_at` and writes no
version. Phase 1's conformance suite asserts this.

**Risk — the two dimensions get confused in code.** `valid_from` and
`recorded_from` are easy to swap. Mitigation: `shared` exports distinct branded
types `ValidTime` and `RecordTime`, so the compiler rejects a mix-up, and
`verify:schema` asserts every temporal table carries both.

## Migration implications

- Phase 1 creates `helm_entities` with valid-time columns plus `version`, and
  `helm_entity_versions` as an append-only chain.
- `GraphStore` exposes `asOf` (valid time) on reads and traversal, and
  `getEntityHistory` (record time) as a separate operation. Both adapters
  implement both.
- Full record-time traversal is a Phase 10 addition: a new port method over
  existing data, no schema change.
- If relationship versioning becomes necessary, it mirrors this ADR and does not
  invalidate it.
