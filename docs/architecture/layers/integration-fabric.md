# Integration fabric — layer reference

`@helm/integration-runtime` · [ADR-0030](../../adr/0030-integration-fabric.md) ·
migration `20260930130000_helm_integration_fabric.sql` ·
[architecture](../helm-architecture.md) · boundary:
[helm-vs-memoire](../helm-vs-memoire.md)

How enterprise source systems reach HELM, and what HELM may propose back.

## What exists

| Part | File | Contract |
| --- | --- | --- |
| `SourceAdapter` | `types.ts`, `memoire.ts` | `translate(record)` is pure; a versioned connector id (`memoire-connector@0.2.0`); a declared source contract |
| `MemoireReader` | `memoire.ts` | rows strictly after a cursor, oldest first, under the caller's own RLS; a fixture reader for tests. The app's reader is `createMemoireOpportunityReader` in `src/services/memoireBridge.ts` |
| `IdentityMapper` | `identity.ts` | register / resolve aliases by `(system, kind, value)`; a name is never an identity; a conflict is reported, never merged |
| `SchemaDriftDetector` | `drift.ts` | pure: `NONE` · `ADDITIVE` · `BREAKING`; a numeric column arriving as a string is not drift |
| `IngestionPipeline` | `pipeline.ts` | checkpoint → drift → translate → write → one ledger row; idempotent by content |
| `sourceAndModel` | `truth.ts` | source and model claims side by side; states that neither overwrites the other |
| `WritebackGateway` | `writeback.ts` | `dispatch`, `list` — and nothing that sends |
| Stores | `inMemoryStore.ts`, `postgres.ts`, `conformance.ts` | `appendSync`, `listSyncs`, `checkpointOf` (derived), `insertWriteback`, `findWriteback`, `listWritebacks` |

Tables (`helm_integration_syncs`, `helm_writeback_requests`) are append-only with the
record time stamped by the database.

## How a Memoire opportunity enters

1. The reader returns rows after the checkpoint.
2. Drift is checked against the declared contract; breaking drift blocks the object
   type and writes nothing.
3. Each record translates to an `Opportunity` and its `Customer` (canonical keys
   `memoire:opportunity:<id>`, `memoire:account:<id>`), a `HELD_BY` relationship,
   aliases, and **source observations** (`OpportunityValue`, `OpportunityProbability`)
   naming the system, the field and the object.
4. Provenance points at the ingestion event; the ledger row records counts, drift,
   quarantined records and the cursor.

Re-reading everything from a blank checkpoint changes nothing; a changed value is a
new observation; a record without a currency is quarantined and holds the checkpoint.

## Writeback (dry run)

`dispatch({ commitmentId })` derives one request per **explicit action intent** of the
commitment that has an adapter (for the Rohto commitment: one, aimed at Memoire;
intents for finance and SCM are skipped and say so). A request records the payload, its
hash, an idempotency key, the governance state it was judged in and a receipt that says
`sent: false`. A commitment governance does not permit is recorded as `REFUSED`. `LIVE`
is refused at the API and impossible in the schema.

## Proof

33 package tests (1 skipped) · `verify:integration-schema`, `-runtime`,
`verify:writeback-dry-run` · mutations on the mode pin, the checkpoint rule, idempotency,
drift blocking, governance and the receipt · live migration proven with controls.

## Debt

Only Memoire has an adapter; ERP, finance, SCM and HR are contracts without one.
Postgres conformance is skipped (blocker B). Entity resolution beyond identifiers is
deliberately absent ([identity-resolution](../identity-resolution.md)).
