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
| [0016](0016-decimal-arithmetic.md) | Exact decimal arithmetic on BigInt fixed-point, not floats | accepted | 3 |
| [0017](0017-calculation-semantics.md) | Calculation semantics — definitions in code, metadata in data, and how inputs are chosen | accepted, §2 revised | 3 |
| [0018](0018-numerical-normalization.md) | Numerical normalization — internal, storage and display precision | accepted | 3 |
| [0019](0019-scenario-runtime.md) | The Scenario Runtime — branches of the model, not copies of the data | accepted | 4 |
| [0020](0020-period-identity.md) | Period identity — a period is a value, not "the furthest-out forecast" | accepted | 4 |
| [0021](0021-decision-runtime.md) | The Decision Runtime — what management decided, and what it decided against | accepted | 5 |
| [0022](0022-decision-authority-graph.md) | The Decision Authority Graph — who may commit what, over which scope, under which consequences | accepted | 6 |
| [0023](0023-management-digital-twin.md) | The Management Digital Twin — versioned management state, referenced, not copied | accepted | 7 |
| [0024](0024-trusted-authority-runtime.md) | The trusted authority runtime — verdicts are computed where the client cannot reach | accepted, amends 0022 | 7 |
| [0025](0025-sensitivity-and-scenario-visibility.md) | Sensitivity classes, scenario visibility, private helpers and decision-type tenancy | accepted, amends 0022 | 7 |
| [0026](0026-enterprise-causal-graph.md) | The Enterprise Causal Graph — evidence-backed causal claims, kept apart from dependency, correlation and coincidence | accepted | 8 |
| [0027](0027-causal-evidence-policy.md) | The causal evidence policy — a hierarchy with ceilings, count never decides | accepted | 8 |
| [0028](0028-management-genome.md) | The Management Genome — organizational memory of situations, beliefs, choices and outcomes; process and outcome kept apart, no person rated | accepted | 9 |
| [0029](0029-counterfactual-worlds.md) | Counterfactual worlds — anchored, labelled, never collapsed | accepted | 10 |
| [0030](0030-integration-fabric.md) | The integration fabric — the source owns the fact; HELM ingests it, never duplicates it, never writes back live | accepted | integration |
| [0031](0031-management-reviews.md) | Management reviews — the operating cadence as a pack of references | accepted | reviews |
| [0032](0032-governed-intelligence-runtime.md) | The intelligence runtime — a governed, provider-neutral reader that cannot write enterprise truth | accepted | intelligence |
| [0033](0033-agent-council.md) | The council — perspectives over one truth; an Agent Perspective is not Decision Authority | accepted | agents |
