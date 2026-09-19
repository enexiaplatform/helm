# ADR-0013: Provenance as first-class records, not entity columns

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 1
**Refines** [ADR-0007](0007-value-graph-projection.md)

## Context

ADR-0007 gave entities inline provenance columns: `source_system`, `source_ref`,
`observed_at`. That is enough to answer "which system said this?" and nothing
more.

HELM's §17 promise is considerably larger. A manager clicking *"why 4.2B revenue
at risk?"* must eventually reach the contributing sources — and those sources are
heterogeneous in kind, not just in name:

- a field on a Memoire opportunity, pulled by a named connector in a named
  ingestion run;
- a figure derived by a calculation from several inputs;
- a number a manager typed in as an explicit assumption;
- a value inferred from a relationship rather than observed directly.

Inline columns cannot represent these. One row holds one source, so a derived
value with four inputs has nowhere to record them, and a human assumption has
nowhere to record who assumed it.

## Problem

How is provenance represented so it covers ingestion, derivation, calculation and
human judgement uniformly — while Phase 1 builds only the ontology-level
foundation and not the calculation machinery that comes in Phase 3?

## Options considered

1. **Inline columns only (ADR-0007 as written).** Simple, one join fewer.
   Single-source by construction; cannot express derivation, cannot record a
   field-level source, cannot attribute a human assumption. Would need replacing
   in Phase 3.
2. **A `provenance jsonb` blob on each row.** Flexible, no schema work. Not
   queryable in practice ("everything sourced from ERP field X"), no referential
   integrity, and each writer invents its own shape.
3. **A dedicated `helm_provenance` table, polymorphic over subjects.** One row per
   provenance assertion, attached to an entity, relationship or version, and
   optionally to a specific field. Uniform across ingested, derived, calculated
   and human-entered facts.
4. **Full W3C PROV-O.** Complete and standard. Substantially more machinery
   (agents, activities, entities as separate node types) than HELM's questions
   require, and it would dominate Phase 1.

## Decision

**Option 3**, with option 1's inline columns **retained as a denormalised fast
path**.

```
helm_provenance(
  id, org_id,
  subject_kind,           -- 'entity' | 'relationship' | 'entity_version'
  subject_id,
  source_field,           -- nullable: field-level attribution
  method,                 -- 'ingested' | 'seeded' | 'derived' | 'calculated'
                          -- | 'human_assumption' | 'inferred'
  system, connector,      -- 'memoire', 'memoire-connector@0.1.0'
  source_object_type, source_object_id,
  ingestion_event_id,     -- groups a batch
  transformation,         -- what was applied
  inputs jsonb,           -- for derived/calculated: the contributing refs
  actor_id,               -- for human_assumption
  confidence, notes, payload,
  observed_at,            -- when the source asserted it
  recorded_at             -- when HELM learned it
)

helm_ingestion_events(
  id, org_id, system, connector, cursor,
  started_at, finished_at, status, record_count, notes
)
```

### Why both representations

`helm_entities.source_system` / `source_entity_id` stay, because the overwhelmingly
common query is "show this entity's origin" and forcing a join for it would make
every list view slower for no benefit. The inline columns are the **primary**
provenance record, duplicated into `helm_provenance`; the table is authoritative
for anything richer.

`verify:ontology` asserts the two agree, so the denormalisation cannot silently
drift.

### `method` is the extension point

The six methods span every way HELM will ever acquire a fact. Phase 1 uses
`ingested`, `seeded` and `human_assumption`. Phase 3's calculation trace writes
`calculated` rows with `inputs` populated — meaning the audit chain Phase 3 needs
requires **no schema change**, only new rows. That is the specific reason this
table is built now rather than in Phase 3: building it later would mean
retrofitting provenance onto entities that already exist without it.

### `ingestion_event_id` makes replay auditable

Every connector run creates one `helm_ingestion_events` row. Every fact it
produces references it. "What changed in last night's ERP sync, and what did it
touch?" becomes one query, and a bad ingestion is traceable to its batch rather
than reconstructed from timestamps.

## Consequences

**Good.** One uniform mechanism for ingested, derived and human-entered facts.
Field-level attribution is possible. Phase 3's calculation audit needs no
migration. Ingestion batches are auditable. Human assumptions are attributable to
a person, which matters when a decision is reviewed a year later.

**Bad.** A second write per fact, so ingestion does roughly twice the row
insertion. Polymorphic `subject_id` cannot carry a foreign key, so referential
integrity there is by convention and asserted by `verify:ontology` rather than by
Postgres. Denormalised inline columns can drift, which is why they are checked.

**Risk — provenance rows outgrow the facts they describe.** A high-frequency
source could generate far more provenance than entities. Mitigation: provenance
is written per *change*, not per *observation* — re-ingesting an unchanged fact
updates `recorded_at` on the existing row rather than inserting. Volume is bounded
by change rate, not poll rate.

**Risk — the table becomes a dumping ground** via `payload`. Mitigation:
`payload` holds only the source fragment that justifies the fact, never a full
record copy — the same discipline as
[ADR-0007](0007-value-graph-projection.md).

## Migration implications

- Phase 1 creates `helm_provenance` and `helm_ingestion_events`, both org-scoped
  with RLS.
- Seeded ontology and the canonical demo graph write `method='seeded'` rows, so
  even fixture data is traceable and the mechanism is exercised from day one.
- Phase 3 writes `method='calculated'` rows referencing `calculation_run_id` in
  `inputs`. No schema change.
- Phase 13's connectors populate `connector` and `ingestion_event_id` from the
  `SourceConnector` contract ([ADR-0009](0009-connector-contract-for-sources.md)).
- Should provenance volume become a problem, partitioning by `recorded_at` is an
  adapter-level change invisible to the `GraphStore` port.
