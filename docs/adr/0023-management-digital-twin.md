# ADR-0023: The Management Digital Twin — versioned management state, referenced, not copied

**Status** accepted · **Date** 2026-09-29 · **Deciders** Architecture ·
**Phase** 7 · **Depends on** [ADR-0014](0014-bitemporal-lite.md),
[ADR-0015](0015-value-graph-specialized-storage.md), [ADR-0017](0017-calculation-semantics.md),
[ADR-0019](0019-scenario-runtime.md), [ADR-0021](0021-decision-runtime.md),
[ADR-0022](0022-decision-authority-graph.md) · **With** [ADR-0024](0024-trusted-authority-runtime.md),
[ADR-0025](0025-sensitivity-and-scenario-visibility.md)

## Context

After Phase 6 HELM holds six kinds of truth, each in its own layer with its own
time semantics:

| Layer | Truth | Time |
| --- | --- | --- |
| Ontology (graph-store) | entities, relationships, roles | valid time + record time |
| Value Graph | observations by type — ACTUAL, FORECAST, ESTIMATE, TARGET, ASSUMED, SCENARIO | period + recorded time |
| Propagation | calculation runs and traces | a run's knowledge boundary |
| Scenario Runtime | overrides, runs, futures | pinned baseline |
| Decision Runtime | questions, alternatives, commitments, assumptions, challenges, intents | append-only timeline |
| Authority Runtime | policies, occupancies, delegations, evaluations, approvals | bitemporal policies, immutable acts |

A manager does not ask any one of them a question. They ask *what is the state
of Vietnam now, what did we commit it would become, and how far are we from
that?* — a question that crosses all six at once, and at a particular moment,
as it was known at a particular moment.

There are three familiar ways to answer it badly:

1. **An aggregation layer.** A service that calls each runtime and merges the
   answers into one JSON document per request. It has no identity: the same
   question asked tomorrow gives a different answer and nobody can say whether
   the enterprise changed or the knowledge did.
2. **A copy.** A nightly job that denormalizes the six layers into
   `enterprise_state` tables. The twin then becomes a seventh source of truth
   that drifts from the other six, and "which number is right?" returns.
3. **A dashboard with a date picker.** It filters current rows by date. It
   cannot reconstruct a decision's state on a past day, because the decision
   row was updated since; it cannot distinguish a late restatement from a real
   change.

## Decision

### 1. A snapshot is a reference manifest plus a materialized reading, bound by a fingerprint

A **TwinSnapshot** is an immutable header (`kind`, `lens`, `scope`, `periods`,
model identity, completeness, sensitivity label, fingerprint) and an ordered
manifest of **TwinItems**. Each item carries:

- `refs` — the kernel objects it was read from (entity version, relationship,
  observation, calculation run, scenario run, decision event, commitment,
  evaluation, approval act, policy …), each with a pin (version, fingerprint
  or record time). **An item that names no kernel object is refused** by the
  store and by the database.
- `state` — the reading at the lens, materialized so the snapshot can be read
  without recomputation.
- `layer` for values: `ACTUAL`, `FORECAST`, `ESTIMATE`, `ASSUMED`, `TARGET`,
  `MODELLED`, `SCENARIO`, `COMMITTED_FUTURE`. A reading is always exactly one
  of them and is never promoted into another. Actual state ≠ modelled state ≠
  committed future.

The fingerprint (`tws_<fnv1a64>_<length>`) is computed over the canonical JSON
of the spec (without the free-text label), the model identity and every item.
The store refuses a manifest whose fingerprint it does not itself produce.

This is **hybrid materialization**: the manifest duplicates no truth because
every reading names its source; it is still materialized because a twin that
must recompute to be read is an aggregation layer with a cache.

### 2. Replay is recomposition

`replaySnapshot` recomposes the stored spec under its own lens against the
kernel as it is *now* and compares fingerprints. Identical means the snapshot
is reproducible from the kernel's own append-only records. A difference is
listed item by item. The canonical story replays all nine snapshots
byte-identically after everything that happened later.

This works only because every mutable kernel field is reconstructed from
append-only records at the lens: decision state from its timeline, action-intent
status from `ACTION_INTENT_STATUS_CHANGED` events, assumption outcome from
outcome reviews, challenge status from `resolvedAt`, occupancy end from its
record time (`endedAt`, [ADR-0025 §6](0025-sensitivity-and-scenario-visibility.md)),
relationship closure from `updatedAt`, entity attributes from
`getEntityAsRecordedAt`. Where a layer had only a mutable field, Phase 7 added
the record that makes the history readable; it never reads the mutable field
for a past lens.

### 3. Two times, never one

Every snapshot states `effectiveAsOf` (**E**, business time — *the enterprise
as of 23 Sep*) and `recordedThrough` (**T**, knowledge time — *as management
knew it on 23 Sep*). Acts (commit, approve, delegate) use `min(E, T)`: an
approval recorded on 24 Sep is not part of 23 Sep, however late the knowledge
boundary. Same E with a later T isolates knowledge: every value change between
two such snapshots is a `KNOWLEDGE_CHANGE`, never a business change.

`CURRENT` takes the clock for both. `HISTORICAL` must be earlier than now. A
knowledge boundary in the future is refused everywhere (store, runtime,
database).

### 4. Five kinds

| Kind | What it is |
| --- | --- |
| `CURRENT` | the enterprise now; each follows the previous `CURRENT` of the same scope (`previousSnapshotId`), which stays exactly as it was |
| `HISTORICAL` | an earlier lens, reconstructed |
| `EXPECTED` | the standing forecast layers at a lens — what the model expects without any decision |
| `SCENARIO` | one scenario run's future over its pinned baseline |
| `COMMITTED_FUTURE` | the run a commitment froze, read from the commitment's own snapshot of it — never today's model re-run |

### 5. Scope is structural and time-aware

A snapshot's scope is `ENTERPRISE` or an `ENTITY` (country, BU, customer,
product, portfolio …). Entities are placed by walking the org-chain anchors of
relationships as they stood at the lens. Entities one hop off the chain
(customers, SKUs, classification segments) are `ATTACHED`, not placed. A scope
entity that did not exist at the lens makes the snapshot `INVALID`
(`SCOPE_UNRESOLVED`) — never an empty `COMPLETE`.

### 6. Completeness is a state with reasons, never a zero

`COMPLETE`, `PARTIAL`, `DEGRADED`, `INVALID`, each with named reasons:
`MODEL_STALE`, `FUTURE_INCOMPLETE`, `COMMITTED_RUN_DIVERGES`,
`NO_COMMITTED_RUN`, `RUN_NOT_KNOWN`, `COMMITMENT_NOT_KNOWN`,
`AUTHORITY_NOT_EVALUATED`, `AUTHORITY_VERDICT_UNTRUSTED`,
`AUTHORITY_INDETERMINATE`, `UNCLASSIFIED_CUSTOMER`, `SCOPE_UNRESOLVED`,
`EMPTY`. A value the kernel does not have is absent with a reason. HELM never
fills a gap with zero.

### 7. Management categories and attention are rules, not scores

Every item belongs to one or more of eleven management categories (structure,
value, performance, constraints, risks, objectives, decisions, commitments,
governance, assumptions, attention). **Attention** items are raised by named,
versioned rules (`CONSTRAINT_BREACHED@1`, `APPROVAL_PENDING@1`,
`CRITICAL_ASSUMPTION_DISPROVED@1`, `COMMITTED_FUTURE_OFF_TRACK@1` …) under a
stated materiality policy (`helm-demo-materiality@1`, demo). Each names the
items that caused it and carries their kernel refs. There is no score, no
weight, no ordering by importance and no model — the list is the conditions
that hold, in key order.

### 8. Comparison is a delta with categories, not a diff of JSON

`compareSnapshots` produces a **TwinDelta**: each changed item as before →
change → after, in one of six categories (structural, value, decision,
assumption, governance, knowledge). Comparisons of different kinds or scopes
carry comparability warnings; a delta across futures says so and points at the
trajectory.

### 9. Current against committed future: distance, then variance

`getTrajectory(current, committedFuture)` pairs the readings of the same node
and period. **Before the period ends** the relation is `DISTANCE_TO_INTENT` —
how far today's state is from what was committed; calling it variance would
claim an outcome that has not happened. **After the period ends** it is
`EXPECTED_VS_ACTUAL`. The trajectory is a relationship between two snapshots
only: nothing is interpolated, projected or forecast between them.

### 10. Explanation walks lineage; attribution is dependency, not cause

`explainItem` resolves an item to its kernel records. `explainDifference`
traces the expected and the actual branches separately, then attributes the
gap by walking the calculation traces — which inputs of the formula moved,
and by how much. It carries `ATTRIBUTION_DISCLAIMER`: this is the model's
arithmetic dependency, not a causal claim. Causal inference is Phase 8.

### 11. A TwinStore port, two adapters, one contract

`TwinStore` (write-once save, get, list, CURRENT chain, clearances) with an
in-memory and a Postgres adapter, held to one conformance suite. The Postgres
adapter saves header and manifest atomically through
`helm_save_twin_snapshot(jsonb, jsonb)` (SECURITY INVOKER — it writes under the
caller's RLS and grants nothing); a deferred constraint refuses a header whose
manifest is short or whose sensitivity label is not the union of its items'.

### 12. The twin sits on top and never writes below

`@helm/twin-runtime` depends on every lower layer; nothing depends on it.
`verify:phase-boundary` fails if any lower package imports it or if the twin
calls a write method of a lower layer (the demo story `meridianTwin.ts`, which
drives the lower runtimes to build its history, is the one named exception).

## Consequences

- "What did we know on 23 Sep?" has one reproducible answer with a fingerprint.
- The twin adds two tables and a clearance table; it copies no truth.
- A snapshot's size grows with scope (134–149 items for the Vietnam demo);
  composition is ~14–17 ms in memory. Postgres composition is not measured yet.
- Every lower layer had to make its history readable. That is where most of
  Phase 7's kernel changes went, and it is the property Phases 8–10 rely on.
- No causal graph, genome, counterfactual, recommendation, optimization, AI or
  cockpit. The twin states conditions; it does not rank them.

## Alternatives rejected

- **Recompute on read (no stored snapshots)** — no identity, no replay, no
  "as known then" once a mutable field changes.
- **Full copy of every layer per snapshot** — a seventh source of truth.
- **Event-sourced twin projection** — the lower layers are already append-only
  records; a second event log would duplicate them.
- **A graph database for the twin** — rejected for the same reasons as
  [ADR-0004](0004-graph-abstraction-layer.md).
