# ADR-0030: The integration fabric — the source owns the fact; HELM ingests it, never duplicates it, never writes back live

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Depends on** [ADR-0007](0007-value-graph-projection.md),
[ADR-0009](0009-connector-contract-for-sources.md),
[ADR-0013](0013-provenance-as-first-class-records.md),
[ADR-0014](0014-bitemporal-lite.md), [ADR-0021](0021-decision-runtime.md),
[ADR-0022](0022-decision-authority-graph.md) ·
[helm-vs-memoire](../architecture/helm-vs-memoire.md)

## Context

HELM shares one database with Memoire and must eventually read ERP, finance,
supply-chain and HR systems. The failure modes are familiar:

1. **Double entry.** A manager retypes what a source already knows, and the two
   drift.
2. **Source and model collapsed.** The source says the probability is 55%, the
   model estimates 35%. If one overwrites the other, nobody can tell which claim
   was ever right — and the model quietly becomes "the" number.
3. **Guessing at a changed source.** A renamed column ingested "best effort"
   silently corrupts every downstream calculation.
4. **Identity by name.** Two customers called "Hanoi General" become one.
5. **A write-back nobody authorized.** An automation that pushes a decision into
   an operational system before anyone has decided HELM may.

## Decision

### 1. One port, five parts

`@helm/integration-runtime` is a lateral layer beside the reasoning layers. It
reads through `value-graph` and `graph-store` and reads decisions and
commitments only to decide what may be *proposed* outward.

- **`SourceAdapter`** — a pure `translate(record)` from one source object to
  ontology entities, relationships and *facts*. It owns a versioned connector id
  (`memoire-connector@0.2.0`) and a declared source contract.
- **`IdentityMapper`** — registers `(system, kind, value)` aliases. A **name is
  never an identity**; an identifier another entity already holds is reported as
  a conflict and **never merged**.
- **`IngestionPipeline`** — pulls after a checkpoint, detects drift, translates,
  writes, and appends one ledger row per run.
- **`SchemaDriftDetector`** — pure: `NONE`, `ADDITIVE` (ingested and reported) or
  `BREAKING` (a required field vanished or changed type).
- **`WritebackGateway`** — turns an *explicit action intent* of a governed
  commitment into a **dry-run** request (§5).

### 2. Source Truth ≠ Model Truth

An adapter can only produce `ACTUAL`, `FORECAST` or `TARGET` observations, each
naming its system, field and object. It has no path to write `ESTIMATE` or
`DERIVED`; a translation that tries is quarantined. A model estimate of the same
quantity sits **beside** the source value; neither overwrites the other and HELM
does not say which is right (`sourceAndModel`). The twin reads the difference as
a change in *what the source claims*, naming the source.

### 3. Idempotent by content

Re-reading everything from a blank checkpoint changes nothing: an entity is
written only if its content differs, an observation only if its value differs, an
alias only if it is new. A changed source value is a **new** observation and the
earlier one stays (append-only, [ADR-0014](0014-bitemporal-lite.md)).

### 4. A checkpoint is derived, and a blocked run holds it

There is no mutable cursor. The checkpoint is the cursor of the latest ledger row
that was not `BLOCKED_BY_DRIFT` or `FAILED`. A record HELM cannot take (no
currency: HELM will not guess one) is *quarantined* and the run is `PARTIAL`, so
the next run sees it again. `BREAKING` drift blocks the object type, writes
nothing and leaves the checkpoint where it was. The database enforces the same
(`helm_integration_syncs_checkpoint_holds`).

### 5. Write-back is a dry run, and only that

`helm_writeback_requests.mode` is pinned to `DRY_RUN` in the schema. A request
exists only for an **explicit action intent of the commitment it names**, only
when the governance state permits execution (`AUTHORIZED` or `APPROVED`;
otherwise the request is recorded as `REFUSED` with the state it was judged in),
carries the commitment fingerprint and a receipt that says *nothing was sent*,
and is unique on its idempotency key. The gateway and the adapter expose no
method that sends. A live mode is a separate, explicitly authorized decision and
a later migration; visibility of a request follows visibility of its decision —
never authority.

### 6. Memoire is read-only

The Memoire reader is the signed-in user's own `opportunities` under Memoire's own
RLS. HELM never writes a Memoire object, never alters Memoire schema, and stores
Memoire entities as references with provenance
([verify:memoire-boundary](../../scripts/verify-memoire-boundary.mjs)).

## Consequences

- A Memoire change is visible in the twin as a source change with lineage to the
  ingestion event, connector and source object; the next management review is
  prepared with exactly that change.
- Adding ERP or finance is one adapter and one contract — the pipeline, the ledger
  and the drift detector are shared.
- The Postgres implementation of the ledger is proven by contract and by a
  rolled-back live proof; its **conformance suite has not been run in an isolated
  authenticated environment** (deployment gate, blocker B).
- Nothing is written outward in v1. "Connected" means *read*.

## Alternatives rejected

- **Ingest best-effort through drift.** Rejected: a guess is worse than a stopped
  run that says why.
- **Let the model overwrite a source value it disagrees with.** Rejected: it
  erases the evidence for the disagreement.
- **A mutable `last_synced_at` cursor.** Rejected: it cannot be audited and a crash
  can move it past a record that was never taken.
- **Live write-back behind a flag.** Rejected for v1: the schema, not a flag, is
  the guard.
