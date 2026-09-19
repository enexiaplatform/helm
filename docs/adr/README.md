# Architecture Decision Records

A foundational architectural change requires an ADR **before** implementation.
Never silently change foundational architecture.

## Format

Every ADR uses the same sections:

```
# ADR-NNNN: Title
Status · Date · Deciders · Phase
## Context
## Problem
## Options considered
## Decision
## Consequences
## Migration implications
```

Status is one of `proposed` · `accepted` · `superseded by ADR-NNNN` ·
`deprecated`. An accepted ADR is never edited in substance — it is superseded by
a new one, so the reasoning history stays readable.

## What warrants an ADR

- Adding, removing or replacing a persistence technology
- Changing the kernel's layering or dependency direction
- Changing the tenancy or isolation model
- Changing the Memoire boundary
- Introducing a new runtime (API service, worker, queue, cache)
- Changing how the ontology, value graph or calculations are represented
- Introducing AI into a previously deterministic path
- Anything that would make a future migration materially harder

## Index

| ADR | Title | Status | Phase |
| --- | --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted | 0 |
| [0002](0002-pnpm-turborepo-monorepo.md) | pnpm + Turborepo monorepo with a packaged kernel | accepted | 0 |
| [0003](0003-supabase-postgres-system-of-record.md) | Postgres via Supabase as the system of record; defer a standalone API service | accepted | 0 |
| [0004](0004-graph-abstraction-layer.md) | Graph abstraction layer over relational tables; defer a graph database | accepted | 0 |
| [0005](0005-namespace-all-helm-tables.md) | Namespace every HELM table `helm_*` | accepted | 0 |
| [0006](0006-data-driven-ontology.md) | Ontology types are registry data, not enums | accepted | 0 |
| [0007](0007-value-graph-projection.md) | Entities reference source rows; the graph never duplicates them | accepted | 0 |
| [0008](0008-deterministic-before-ai.md) | Deterministic engines before AI; AI behind a grounded, vendor-neutral port | accepted | 0 |
| [0009](0009-connector-contract-for-sources.md) | All enterprise sources enter through a connector contract | accepted | 0 |
| [0010](0010-test-and-contract-strategy.md) | Vitest in packages plus executable architecture contracts | accepted | 0 |
| [0011](0011-reconcile-decision-and-value-models.md) | Preserve the decision kernel; reconcile it with the value model | accepted | 0 |
| [0012](0012-defer-pnpm-turborepo-and-vitest.md) | Use npm workspaces; defer pnpm, Turborepo and Vitest | accepted | 1 |
| [0013](0013-provenance-as-first-class-records.md) | Provenance as first-class records, not entity columns | accepted | 1 |
| [0014](0014-bitemporal-lite.md) | Bitemporal-lite — separate valid time from record time | accepted | 1 |
| [0015](0015-value-graph-specialized-storage.md) | The Value Graph gets specialized storage, not the generic GraphStore | accepted | 2 |
