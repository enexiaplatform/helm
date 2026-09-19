# HELM vs Memoire — The Boundary

**This separation is non-negotiable.** It is enforced by a contract test
(`verify:memoire-boundary`), not by memory or good intentions.

## 1. One sentence each

**Memoire is the Commercial Execution Platform.** Commercial people work in it,
all day. It produces **Commercial Truth**.

**HELM is the Enterprise Management Infrastructure.** Managers use it to decide.
It produces **Management Truth**.

> Memoire records what happened. HELM decides what to do about it.

## 2. Ownership table

| Capability | Owner | HELM may |
| --- | --- | --- |
| Accounts, contacts, stakeholders | **Memoire** | reference by id, snapshot |
| Opportunities, pipeline, stages | **Memoire** | reference, snapshot, project as entities |
| Quotations, tenders, orders | **Memoire** | reference |
| Activities, interactions, plans | **Memoire** | read aggregates |
| Competitor records, commercial knowledge | **Memoire** | read signals |
| Commercial forecast & calibration | **Memoire** | consume as input |
| — | — | — |
| Enterprise ontology & value graph | **HELM** | own |
| Cross-functional propagation | **HELM** | own |
| Scenarios & simulation | **HELM** | own |
| Decisions, options, assumptions | **HELM** | own |
| Decision authority & approval chains | **HELM** | own |
| Outcome ledger, lessons, genome | **HELM** | own |
| Management attention & signals | **HELM** | own |
| Enterprise state snapshots | **HELM** | own |

### 2.1 The rules that follow

1. **HELM never writes to a Memoire-owned entity table.** The single exception
   is appending a `commercial_events` row as decision provenance (§4.2) — an
   append to an event log, never a mutation of a record.
2. **HELM never builds a commercial execution screen.** No account list, no
   pipeline board, no activity logger, no quotation editor.
3. **Memoire never imports HELM code**, and has no knowledge HELM exists beyond
   receiving events with a `helm://` source URL.
4. **HELM never copies a Memoire entity.** It stores a reference plus an
   immutable snapshot (§4.1).
5. **A migration never alters or drops a Memoire table.** Additive only, forever
   ([ADR-0003](../adr/0003-supabase-postgres-system-of-record.md)).

## 3. The shared substrate — and why that is not a boundary violation

HELM and Memoire share **one Supabase project** (`mlmpcpkucurylkrobain`):
one Postgres database, one auth system, one user identity.

This is a deliberate strategic choice, not an accident of convenience. It buys:

- **One identity.** A manager signs in once; no SSO federation to build.
- **Zero-latency integration.** No ETL, no sync lag, no reconciliation job.
- **Referential integrity across the boundary.** `memoire_opportunity_id` can be
  a real reference, not a hopeful string.

It costs discipline, paid in three ways: schema namespacing
([ADR-0005](../adr/0005-namespace-all-helm-tables.md)), strictly additive
migrations, and an **application-level** boundary that the database does not
enforce for us. Sharing a database is exactly why the boundary must be asserted
by tests — nothing physical stops a careless `select` on `accounts`.

```mermaid
flowchart TB
    subgraph SUPA["Supabase project mlmpcpkucurylkrobain"]
        subgraph MT["Memoire tables — user_id scoped, RLS auth.uid()"]
            direction LR
            A[accounts · 1,106] ~~~ O[opportunities · 127] ~~~ S[stakeholders · 1,752] ~~~ CE[commercial_events · 13]
        end
        subgraph HT["HELM tables — org_id scoped, RLS membership"]
            direction LR
            ORG[organizations · org_units] ~~~ HD[helm_decisions] ~~~ HE["helm_entities (P1)"] ~~~ HV["helm_value_* (P2)"]
        end
        AUTH[(auth.users — shared identity)]
    end
    MA[Memoire app] --> MT
    MA --> AUTH
    HA[HELM app] --> HT
    HA --> AUTH
    HA -.->|"read-only: reference + snapshot"| MT
    HA -.->|"append-only: decision provenance"| CE
```

### 3.1 Two different tenancy models in one database

| | Memoire | HELM |
| --- | --- | --- |
| Scope column | `user_id` | `org_id` |
| RLS predicate | `auth.uid() = user_id` | `is_org_member(org_id)` |
| Sharing | single-user workspaces | multi-user, role-ranked |

They coexist because they never share a table. The bridge between them is the
signed-in user: HELM reads Memoire data **as that user**, so RLS guarantees HELM
can never surface commercial data the user could not already see in Memoire. The
boundary is enforced by Postgres, in the user's own security context.

An implication worth stating plainly: HELM's org-level view of commercial data is
currently limited to what its *individual signed-in users* can see in Memoire. A
true org-wide commercial read requires Memoire to adopt the shared org layer —
already anticipated by its `scope` seam
([discovery-findings.md §6](discovery-findings.md#6-memoire--what-the-sibling-codebase-teaches)).
Until then, org-wide commercial aggregates come from the connector's event
stream, not from live cross-user queries.

## 4. The integration contract

### 4.1 Read: reference + immutable snapshot, never copy

When a decision draws on commercial context, HELM stores:

1. **The reference** — `memoire_opportunity_id`, `memoire_account_id`.
2. **An immutable snapshot** — `context_snapshot jsonb`: the fields the manager
   actually saw, at the moment of analysis.

Why both. The reference keeps HELM current: live data is re-read for display, and
Memoire keeps evolving without breaking HELM. The snapshot keeps HELM honest: a
decision must be judged against the information available when it was made. If
an opportunity later moves from 70% to 20%, the decision was not wrong — it was
made on 70%. Without the snapshot, every retrospective becomes hindsight bias,
and the genome learns the wrong lesson.

### 4.2 Write: provenance only

When an approved decision starts executing, HELM appends one
`commercial_events` row into the deciding user's Memoire workspace:

```
event_type:   'helm_decision_approved'
source_type:  'system_rule'
source_id:    <decision id>
source_url:   'helm://decision/<id>'
summary:      'HELM decision: <title> — chosen: <alternative>'
structured_payload: { helmDecisionId, decisionType, chosenAlternative,
                      expectedOutcome, actions[] }
idempotency_key: 'helm-decision-<id>'
```

Memoire's timeline shows *why* something changed commercially, with a link back,
and needs no HELM-specific code to do it. The `idempotency_key` makes replay
safe.

This is the **only** write. HELM does not update an opportunity's stage, value,
probability or close date — even when a decision implies one. It tells the
manager what to change; the manager changes it in Memoire. Anything else makes
two systems authoritative for one field.

### 4.3 Events: the direction Phase 13 takes this

Today's bridge is direct database reads. The target is an event contract, so
Memoire (and later ERP, Finance, SCM) publish and HELM subscribes:

```
account.updated              opportunity.created
opportunity.updated          opportunity.stage_changed
quotation.created            pipeline.changed
activity.completed           competitor.detected
tender.updated               commercial_signal.detected
```

Each event carries `{ eventType, occurredAt, sourceSystem, sourceRef, payload,
idempotencyKey }` and is translated by the connector into ontology entities,
relationships and observations. The kernel never sees Memoire's vocabulary.

Because HELM and Memoire share a database, "publish" can start as a polled
outbox read over existing tables — the contract matters more than the transport,
and adopting the contract first means the transport can change later without
touching the kernel.

## 5. Failure modes to watch for

Signs the boundary is eroding, each one a reason to stop:

- A HELM screen a salesperson would want to use daily.
- A `helm_*` table with a column duplicating a Memoire field (`account_name`,
  `opportunity_stage`) rather than referencing it.
- HELM computing a commercial forecast instead of consuming Memoire's.
- Memoire importing anything from HELM.
- A `supabaseClient.from('accounts')` call inside a kernel package.
- HELM writing to any Memoire table other than appending `commercial_events`.

The last two are mechanically detectable and are what `verify:memoire-boundary`
asserts.
