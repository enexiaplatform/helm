# Phase 7 implemented — Management Digital Twin

**Date** 2026-09-29 · **Status** complete in the kernel; pilot **blocked** by the
[trusted runtime deployment gate](trusted-runtime-deployment-gate.md) (§10) ·
**ADRs** [0023](../adr/0023-management-digital-twin.md) ·
[0024](../adr/0024-trusted-authority-runtime.md) ·
[0025](../adr/0025-sensitivity-and-scenario-visibility.md) ·
**Security** [security-model](security-model.md) ·
**Previous** [phase 6](phase-6-implemented.md)

Phases 1–6 each answer one question about the enterprise in their own layer.
Phase 7 answers the question a manager actually asks, across all of them, at a
stated moment and as known at a stated moment: *what is the state of Vietnam,
what did we commit it would become, and how far are we from that?* — with an
identity (a fingerprint), a history (versioned, never mutated) and a lineage
back to the records it was read from.

---

## 1. The model

```
                       ┌──────── lens: effectiveAsOf (E) · recordedThrough (T) ────────┐
Ontology ─────────────▶│                                                              │
Value Graph ──────────▶│   composeSnapshot(scope, spec)                               │
Propagation ──────────▶│     structure · values by layer · constraints · objectives   │──▶ TwinSnapshot
Scenario Runtime ─────▶│     decisions · commitments · intents · assumptions          │    header + manifest
Decision Runtime ─────▶│     governance (trusted verdicts) · attention rules          │    tws_<fnv1a64>_<len>
Authority Runtime ────▶│                                                              │
                       └──────────────────────────────────────────────────────────────┘
                                                   │
       replay (recompose + compare) · compare (TwinDelta) · trajectory (distance / variance)
       explain item (lineage) · explain difference (attribution, dependency only)
       project for viewer (visibility, then sensitivity per item, withheld stated)
```

Package: **`@helm/twin-runtime`**, the new top of the kernel
(`shared → … → decision-runtime → authority-runtime → twin-runtime`). Nothing
below imports it, and it calls no write method below it
(`verify:phase-boundary`).

| Module | Job |
| --- | --- |
| `types.ts` | kinds, lens, scope, completeness, items, layers, categories, delta, trajectory, explanation |
| `fingerprint.ts` | canonical JSON and the snapshot fingerprint |
| `structure.ts` | structure at the lens; scope placement over org-chain anchors; account classification |
| `values.ts` | a node's reading per layer through the engine's own observation selection; staleness |
| `management.ts` | decisions, commitments, intents, assumptions, challenges, policies, occupancies, delegations, governance — reconstructed at the lens from append-only records |
| `attention.ts` | ten named rules and the demo materiality policy; no scores |
| `compose.ts` | a snapshot's items, completeness and references, for every kind |
| `delta.ts` | the twin delta in six categories, and comparison attention |
| `trajectory.ts` | current against committed future |
| `explain.ts` | item lineage and difference attribution |
| `sensitivity.ts` | classes, clearances, visibility, projection, scenario visibility |
| `runtime.ts` · `managementApi.ts` | the runtime and the management API foundation |
| `inMemoryStore.ts` · `postgres.ts` · `conformance.ts` | two stores, one contract |
| `meridianTwin.ts` | the DEMO twin story |

## 2. Snapshot kinds and the two-time lens

| Kind | Lens | Canonical instance |
| --- | --- | --- |
| `CURRENT` | the clock, both times | S0, S1a, S1, S2 (Vietnam), Pharma S2, Industrial S2 |
| `HISTORICAL` | an earlier E and T | H23 — "as management knew the enterprise on 23 Sep, 14:00 ICT"; H23now — the same E, known at the Q4 close |
| `EXPECTED` | forecast layers at a lens | built on request |
| `SCENARIO` | one run over its pinned baseline | built on request |
| `COMMITTED_FUTURE` | the frozen run of a commitment | CF1 — Vietnam, E 2026-12-31, T when the approval was known |

Every mutable kernel field is reconstructed from append-only records at the
lens (ADR-0023 §2). Kernel additions that made this possible:

- `ACTION_INTENT_STATUS_CHANGED` decision events and
  `setActionIntentStatus` — intent status was a mutable field;
- `helm_role_occupancies.ended_at` / `RoleOccupancy.endedAt` — when an ending
  was *learned*;
- in-memory `removeRelationship` stamps `updatedAt`; `RelationshipQuery.includeClosed`;
  deterministic id tiebreaks in both graph adapters;
- `beforeCommit` hook in `buildMeridianDecision` so S0 is taken before the
  commitment exists.

## 3. Database

One additive migration, `20260929090000_helm_management_twin.sql`, applied to
the shared Supabase project in eight named parts.

| Object | |
| --- | --- |
| `helm_private` schema | 11 SECURITY DEFINER helpers; `EXECUTE` revoked from `PUBLIC` and `anon` |
| every Phase 6 policy | re-pointed at `helm_private`; the three public helpers dropped |
| `helm_value_metrics.sensitivity` · `helm_value_nodes.sensitivity` | five classes; 16 metrics classified |
| `helm_sensitivity_clearances` | admin-granted, time-bounded; guard refuses self-grants |
| `helm_scenarios.visibility` · `helm_scenario_visibility` | `ORG_WIDE` / `RESTRICTED`; unit grants; capture by binding |
| scenario, revision, override, run, constraint, observation, calculation-run and step policies | scoped to scenario visibility and class |
| `helm_decision_types` | `org_id`, `id` PK, partial unique indexes; FKs superseded by format CHECKs + `helm_decision_type_ref_guard` |
| authority tables | client `INSERT`/`UPDATE`/`DELETE` revoked; `evaluator` CHECK `TRUSTED_SERVICE`; `helm_approval_acts_member_guard` |
| `helm_role_occupancies.ended_at` | stamped by the guard; cannot be inserted already ended |
| `helm_twin_snapshots` · `helm_twin_snapshot_items` | write-once; refs required; CURRENT chain; no future knowledge; deferred completeness guard; items readable only where cleared |
| `helm_save_twin_snapshot(jsonb, jsonb)` | SECURITY INVOKER; header and manifest in one transaction |

### Applied to the shared database

| | before | after |
| --- | --- | --- |
| Memoire `accounts` | 1 106 | 1 106 |
| Memoire `opportunities` | 129 | 129 |
| Memoire functions | 9 | 9 |
| Memoire function fingerprint | `eef6a68b…` | `eef6a68b…` (identical) |
| `helm_*` tables | 52 | 56 |
| `helm_*` policies | 227 | 232 |
| policies still referencing a public helper | — | **0** |
| `helm_private` functions | 0 | 11 |

**36 server-side assertions** in one transaction that deliberately aborts:
**24 refusals** and **12 legal controls** that must succeed, **0 failures**.
Fixture users, org, units, snapshots, scenarios, values, decisions and
occupancies were verified back at zero afterwards.

| Proved server-side | |
| --- | --- |
| Pharma member reads its own BU snapshot (control); **not** the Industrial one, **nor** the Vietnam one above it | RLS |
| uncleared Pharma member reads the general item of its snapshot, **not** the financial one | per-item sensitivity |
| Industrial member reads its own snapshot (control); **not** Pharma's | RLS |
| Country GM reads all four snapshots under Vietnam (control); uncleared, **not** the financial item; cleared, both (control) | subtree + clearance |
| a clearance does **not** widen visibility: the cleared Finance Director still cannot read the Pharma snapshot | visibility ≠ sensitivity |
| unbound org-wide scenario visible (control); scenario restricted to Finance hidden from Pharma, visible to Finance (control) | scenario visibility |
| a Pharma decision binds a scenario → Pharma keeps it (control), **Industrial loses it and its values**, the GM above keeps it (control) | capture by binding |
| uncleared member cannot read a financial scenario value; a general one is readable (control) | value class |
| a client writes an authority evaluation · a required approval · an approval act in someone else's name | refused (privileges revoked) |
| a member grants themselves a clearance · extends the decision-type registry | refused |
| an organization redefines a system type (`PRICING`) | refused; an admin's own extension accepted (control) |
| `anon` calls a `helm_private` helper | refused |
| snapshot rewritten · manifest item deleted · CURRENT after HISTORICAL · future knowledge boundary · item without refs · header claiming 3 items with none | refused |
| occupancy inserted already ended | refused; ending one stamps `ended_at` |

**Advisors afterwards.** Security: the three Phase 6 helper WARNs are **gone**;
the five pre-existing shared-core helper WARNs and the leaked-password
protection WARN remain (not HELM's to change). Performance: **no
`auth_rls_initplan`**; 10 new `unindexed_foreign_keys` INFOs on the new, empty
tables, matching the existing pattern. RLS was not weakened to remove any
warning.

## 4. Canonical proof — the Rohto story as a twin

All run in memory over the real Phase 1–6 stack by `runMeridianTwinStory`
(**DEMO**, labelled as such in the data and the UI), asserted by the tests and
the `verify:twin-*` contracts.

| Snapshot | What it holds |
| --- | --- |
| **S0** — before the decision | the Rohto opportunity; the order-fulfilment constraint **BREACHED** (12 needed, 4 on hand); modelled GM 33.2381 %, cash −1 710 500 000 VND; own stock 4 as SCM reported it; the decision `READY_FOR_DECISION`; no commitment; the authority context (DOA v1, seats); attention `CONSTRAINT_BREACHED`, `DECISION_AWAITING_COMMITMENT` |
| **S1a** — committed | decision `COMMITTED`; governance `PENDING_APPROVAL`, policy result `REQUIRES_APPROVAL`, evaluator `TRUSTED_SERVICE`, consequences `TRACE_VERIFIED`; attention `APPROVAL_PENDING` |
| **S1** — approved | governance `APPROVED`; committed-future values (GM **32.3878 %**); three action intents; **the constraint is still BREACHED** — intent is not reality |
| **CF1** — committed future | the run the commitment froze, read from the commitment's own snapshot — not today's model re-run; GM 32.3878 %, cash −1 735 500 000 VND |
| **S2** — after the Q4 outcome | actuals: own stock 12, freight 185 220 000 VND ACTUAL, GM **31.7 %** ACTUAL (Finance); the constraint **SATISFIED**; attention `COMMITTED_FUTURE_OFF_TRACK`, `CRITICAL_ASSUMPTION_DISPROVED` |

**CF1 → S2**: `EXPECTED_VS_ACTUAL` (Q4 has ended) — gross margin committed
32.3878, actual 31.7, **−0.6878 pts**. The difference explanation traces both
branches, then attributes the gap through the model: gross margin
952 200 000 → 931 980 000 VND, driven by fulfilment cost 140 000 000 [ESTIMATE,
SCM] → 185 220 000 [ACTUAL, Finance]; opex unchanged. It carries the
disclaimer: *dependency in the model, not causation.*

**S1 → CF1**: `DISTANCE_TO_INTENT`, not variance — Q4 had not ended. Demand
coverage committed 96.8858 %, today's model 32.2953 % (it still reads the stock
that is actually there).

**Historical replay.** All nine story snapshots recompose **byte-identically**
after everything that happened later (DOA v2, restatement, reclassification,
succession, actuals, the Q4 re-run). H23 still reads capacity utilisation 78,
governance `PENDING_APPROVAL`, no actual GM. H23now — the same business
instant known at the Q4 close — differs **only** in knowledge: SCM's
restatement 78 → 81 is a `KNOWLEDGE_CHANGE`, and the 24 Sep approval is still
not part of 23 Sep.

**Structural change.** S1 → S2 holds the Rohto reclassification (Key Account →
Strategic Account) and the Commercial Director succession (Hoang Thu Trang) as
structural changes, apart from every value change.

**Governance change.** DOA v1 → v2 appears as a governance change; the
evaluation made under v1 is not rewritten and still cites v1.

**Decision change.** Open → Committed → Approved, stated as management-state
transitions in the S0 → S1a → S1 deltas.

## 5. Security in the twin

- **Scoped snapshots**: a Pharma BU snapshot is invisible to the Industrial BU
  and the reverse; the Country GM sees both.
- **Per-item sensitivity**: a viewer without `FINANCIAL_SENSITIVE` sees the
  snapshot without its margin and cash items, and is told how many items of
  which class were withheld. Nothing is silently removed.
- **Captured scenarios**, **visibility ≠ authority**, and **trusted verdicts
  only**: a governance item resting on a `CLIENT_RUNTIME` verdict makes the
  snapshot `DEGRADED` (`AUTHORITY_VERDICT_UNTRUSTED`).

## 6. The trusted authority path (ADR-0024)

`createTrustedAuthorityService` refuses seven client-supplied facts by name
before any read, derives identity from the verified token, reads membership,
checks visibility as the caller, re-derives the chosen run's 14 calculation
steps and its overrides, then runs the Phase 6 engine and writes the verdict
stamped `TRUSTED_SERVICE`. A tampered run (a stored output the formulas do not
reproduce) is refused. The edge function `helm-authority` wraps it; the demo
runs the same service in-process.

**Deployment: not done** (§10).

## 7. The surfaces

- **`/twin`** (Kernel instrument, `AppShell wide`): scope, "Read as" (viewer
  preset), state (snapshot) and "Compared with"; the snapshot list with lens,
  completeness and fingerprint; state by management category with withheld
  notices; change as before → change → after; *Expected against actual* or
  *Now against the committed future*; a lineage aside that explains an item or
  a difference.
- **`/decisions/:id`**: evaluation and approval go through the trusted service;
  the governance panel says who evaluated ("trusted service · in-process
  (demo) · 14 steps re-derived").

## 8. Contracts

| Contract | Proves |
| --- | --- |
| `verify:twin-schema` | write-once manifests, per-item sensitivity, private helpers re-pointed, scenario capture, decision-type tenancy, metric classes equal to the kernel's |
| `verify:twin-snapshot` | S0 before, S1 intent not reality, CF1 from the frozen run, fingerprints reproduce, eleven categories, layers apart |
| `verify:twin-temporality` | 9 snapshots replay byte-identically; 23 Sep known later differs only in knowledge; current state versioned |
| `verify:twin-diff` | Open → Committed → Approved; structure apart from value; v1 → v2 without rewriting; −0.6878 pts expected vs actual; attention named, never scored |
| `verify:twin-lineage` | 983 items all referenced; 14 modelled values traced to source; the CF1 → S2 gap attributed to fulfilment cost, not causation |
| `verify:twin-security` | BU snapshots scoped both ways; per-item sensitivity, withheld stated; captured scenarios; visibility ≠ authority; trusted verdicts only |
| `verify:authority-server` | the bundle refuses 7 client-supplied facts before any read; trusted verdict re-derived; tampered run refused; service-only writes in the schema |
| `verify:phase-boundary` | *(updated)* twin confined to its package and writing nothing below; no recommendation, attention score, cockpit, causal inference, optimization, agents or pattern learning |
| `verify:decision-visibility` | *(updated)* the SQL helpers now in `helm_private` |

`node scripts/lib/mutate.mjs` now breaks **66 invariants** across 20 contracts (25 of them
Phase 7), one at a time; every one is caught by a named assertion of the
contract that claims it.

The full suite: typecheck and lint clean (3 pre-existing fast-refresh
warnings); **552 tests, 545 pass, 0 fail, 7 skipped** (the Postgres halves of
seven conformance suites, including the new twin store's); **38 contracts ok**.

## 9. Performance

In memory, canonical story, Node 24, `node scripts/lib/bench-twin.mjs`.
Snapshots hold 124–149 items.

| | |
| --- | --- |
| stack + canonical story (Phases 1–6 seed, 9 snapshots) | ~205 ms |
| build a CURRENT snapshot, Vietnam scope (compose + store) | 13.6 ms |
| build a HISTORICAL snapshot, 23 Sep lens | 17.0 ms |
| load a stored snapshot | < 0.01 ms |
| replay (recompose + fingerprint compare) | 9.5 ms |
| compare S0 → S2 (twin delta + attention) | 2.1 ms |
| explain a difference (CF1 → S2 GM, attribution walk) | 1.0 ms |
| explain one item | 0.01 ms |
| current against committed future (trajectory) | 0.07 ms |
| management state (by category + attention) | 0.02 ms |
| project for a viewer (visibility + sensitivity) | 0.01 ms |

Composition dominates; reading a stored snapshot is free. **No database timing
is quoted**: the Postgres store has not been exercised against a live
database with a signed-in identity.

## 10. Maturity, pilot blockers and debt

| Layer | State |
| --- | --- |
| Kernel | Phase 7 complete |
| Shared database schema | Phase 7 migration applied and verified |
| Trusted authority implementation | Built and contract-tested |
| Trusted authority deployment | **NOT DEPLOYED** — deployment to the shared project is not approved |
| Postgres conformance | **7 suites SKIPPED** — no isolated authenticated environment |
| Cloud end-to-end readiness | **NOT YET PROVEN** |
| Production / pilot readiness | **BLOCKED** by the [deployment gate](trusted-runtime-deployment-gate.md) |

Two blockers stand before any pilot, production governance, the Country GM
Cockpit, or a claim that authority enforcement is production-ready:

- **Blocker A — trusted authority runtime not deployed, cloud path unproven.**
  Built and bundled; not deployed. Until it is, the cloud decision page cannot
  record an evaluation or approval: the direct writes are revoked, and will not
  be re-enabled for testing.
- **Blocker B — Postgres conformance never run against an isolated,
  authenticated environment.** `list_branches` is empty; no signed-in test
  identity exists; none were fabricated. The rolled-back server-side proof (§3)
  is the substitute evidence for the database layer only.

The eleven conditions that clear both are in the [deployment gate](trusted-runtime-deployment-gate.md).
The rest of this table is ordinary backlog.

| Item | Status |
| --- | --- |
| Decision rows are row-shaped | Sharing a decision while hiding its amount remains a gap; twin items are redacted by class. |
| HR and per-entity-type classes | Reserved (`HR_RESTRICTED`); no HR data exists. |
| Materiality policy is demo | `helm-demo-materiality@1` — an organization's own policy is not yet data. |
| Twin snapshots are built on request | No schedule; a `CURRENT` snapshot exists when someone builds one. |
| Unindexed foreign keys | 10 new INFOs; tables are empty. |

## 10a. Addendum — a defect found in Phase 8

The Phase 8 live proof showed the twin's SELECT policy re-read its own row by id, so `helm_save_twin_snapshot` (and `INSERT … RETURNING` on decisions, scenarios and runs) was refused by RLS. Fixed in `20260930100000_helm_rls_row_visibility.sql`; see [phase-8-implemented.md](phase-8-implemented.md) §3.

## 11. What Phase 7 does not do

No causal graph or causal inference (attribution is arithmetic dependency and
says so), no genome or pattern learning, no counterfactual, no recommendation,
ranking or scoring, no optimization, no AI or agents, no autonomous decision
or act, no GM cockpit. Phase 8 has not been started.
