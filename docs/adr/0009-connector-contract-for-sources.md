# ADR-0009: All enterprise sources enter through a connector contract

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

The brief requires connectors and integration contracts, and forbids coupling the
kernel to any external system (§1, §13).

Today HELM reads Memoire directly. `src/services/memoireBridge.ts` issues
`supabaseClient.from('opportunities').select('id, account_id, account_name, …')`
inline and maps the result. It works, and it is honest about what it does — but it
puts Memoire's column names inside HELM's service layer, which means the kernel's
vocabulary depends on Memoire's schema.

Because HELM and Memoire share a database, the temptation to keep doing this for
every future source is strong and the coupling is invisible until the second
source arrives.

## Problem

How do enterprise sources reach the kernel so that adding ERP, Finance, SCM or
HRIS requires no kernel change, and a source's schema change cannot ripple inward?

## Options considered

1. **Direct queries per source, as today.** Simplest for one source. Source column
   names spread through HELM; every source needs bespoke code in the service
   layer; nothing is unit-testable without a database; the kernel's vocabulary is
   hostage to foreign schemas.
2. **A generic ETL/ingestion framework.** Powerful and heavy. Premature for a
   system with one real source, and the brief warns against exactly this kind of
   premature infrastructure (§8).
3. **A `SourceConnector` interface with a pure `translate()` step.** Each connector
   owns its source's vocabulary and produces `OntologyMutation[]`. The kernel
   receives ontology terms only.
4. **Option 3 plus a message bus from day one.** Correct destination, wrong order.
   A bus adds operational surface to serve one source that shares the database.

## Decision

**Option 3**, with the event *contract* adopted now and the *transport* deferred.

```ts
interface SourceConnector {
  readonly sourceSystem: string;
  readonly producesEntityTypes: string[];        // enforced whitelist
  readonly producesRelationshipTypes: string[];
  healthCheck(): Promise<ConnectorHealth>;
  pull(scope, since: Cursor | null): Promise<{ events: SourceEvent[]; cursor: Cursor }>;
  translate(event: SourceEvent): Result<OntologyMutation[]>;  // pure
}
```

Four properties carry the weight:

**`translate()` is pure.** No network, no database. A connector is therefore fully
unit-testable with recorded fixtures — the single most valuable property of this
design, because integration bugs are otherwise only findable against a live
system.

**Every source event has the same envelope.** `{ eventType, occurredAt,
sourceSystem, sourceRef, payload, idempotencyKey }`. Replay is safe by
construction; the ingestion path is identical for every source.

**Type whitelists are declared and enforced.** A connector cannot invent entity
types outside its declaration. An ERP connector that starts producing `Decision`
entities fails, loudly.

**Transport is the connector's business.** `pull()` may read tables in the shared
database, call a REST API, or drain a queue. Because HELM and Memoire share a
database, the Memoire connector's `pull()` starts as a polled read over existing
tables with a cursor — no bus, no webhook, no new infrastructure. Moving to
webhooks or a queue later changes one method.

### Mock connectors are not optional

`erp-mock`, `finance-mock` and `scm-mock` implement the same interface with
deterministic fixture data. They exist to prove the seam is real *before* a
paid integration project depends on it — the same two-implementation discipline as
[ADR-0004](0004-graph-abstraction-layer.md). If the interface only works for
Memoire, that is discovered by writing the second connector, not by the first
customer.

### The write direction stays minimal

Connectors are primarily inbound. The one outbound path is decision provenance:
appending a `commercial_events` row with a `helm://decision/<id>` source URL. It
stays an append to an event log and never becomes a general write-back
capability — see
[helm-vs-memoire.md §4.2](../architecture/helm-vs-memoire.md#42-write-provenance-only).

## Consequences

**Good.** The kernel never learns a foreign column name. Connectors are
unit-testable without a live system. Adding a source is a new package, not a
kernel change. Replay is safe. Transport can evolve behind one method.

**Bad.** More indirection than a direct query. Two mappings to maintain per source
(source → event, event → ontology). Mock connectors are code with no customer
value, justified only by the seam they protect.

**Risk — the abstraction fits only Memoire.** Mitigation: the mock connectors, and
the rule that Phase 13 is not complete until `erp-mock` produces entities through
the same path.

**Risk — the kernel is bypassed "just this once".** A page calls
`supabaseClient.from('opportunities')` directly because it is faster. Mitigation:
`verify:memoire-boundary` asserts that no kernel package and no connector other
than `connectors/memoire` references a Memoire table.

## Migration implications

- Phase 1 defines `connector-sdk` types only; no connector is built.
- Phase 13 extracts `memoireBridge.ts` into `connectors/memoire`, splitting it
  into an impure `pull()` and a pure `translate()`, with fixtures captured from the
  live schema.
- The existing `listMemoireOpportunities()` and `writebackDecisionToMemoire()`
  keep working until that extraction. No behaviour changes for users.
- `SourceEvent.eventType` values follow the brief's names (`opportunity.updated`,
  `competitor.detected`, …) so a future real Memoire publisher matches the contract
  HELM already consumes.
