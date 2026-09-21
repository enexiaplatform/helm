# Phase 3 hardening (implemented record)

What changed after the Phase 3 commit, why, and what it proves. A record, not a
plan. Read with [phase-3-implemented.md](phase-3-implemented.md), several of
whose decisions this revises.

**Delivered 2026-09-21**, on top of `a1b2a86` (Phase 3) and `4f0b769` (the
same-run lineage fix).

---

## 1. Three truth layers, made explicit

```
BUSINESS / SOURCE TRUTH   ACTUAL, FORECAST, TARGET, ASSUMPTION
MODEL TRUTH               DERIVED — explainable output, not authoritative by type
EXECUTION STATE           run-bound values; runtime bindings, never persisted as a category
```

**Removed: the global `DERIVED > FORECAST` rule.** Phase 3 had ranked `DERIVED`
first in the baseline policy so chained calculations would see each other. That
made every historical HELM calculation outrank the forecast a person committed
to, so business truth and model truth could not coexist. No source policy can
now return `DERIVED`; persisted model truth is asked for by name
(`MODEL_OUTPUT`). `BASELINE` is renamed `SOURCE_TRUTH` so the policy says which
layer it reads. [ADR-0017 §2](../adr/0017-calculation-semantics.md).

**Added: `truthLayers()`**, which reads both layers side by side and states the
variance, without promoting either.

## 2. Input binding semantics

Every input declares how it resolves:

| Resolution | Reads | For |
| --- | --- | --- |
| `SOURCE_POLICY_ONLY` | the persistent world, under an observation policy | measurements and commitments: available inventory, unit cost, a finance forecast |
| `RUN_OUTPUT_IF_PLANNED` | this run's own upstream output if planned; else persisted model truth; else the source world | executable dependencies: `Expected Revenue → Demand Quantity` |

The run output carries the **raw** quantity, so normalization cannot compound
down a chain. Every trace input records `boundTo: RUN_OUTPUT | SOURCE_OBSERVATION`.
All 18 Meridian inputs declare their resolution — 11 execution dependencies, 7
source inputs — and the governance rows in the database carry it too.

Found while building it: two active calculations producing one metric for
overlapping subjects made the planner silently use whichever was registered
first. The registry now refuses that (`ambiguous_producer`), and the planner
picks the producer per node by scope.

## 3. Source-world snapshot: two lenses

```
effectiveAsOf     what business time is being modelled        → valid time
recordedThrough   what HELM was allowed to know at run start  → record time
```

A source observation enters a run only if **both** hold: `recordedAt <=
recordedThrough`, and (for a point-in-time claim) `effectiveAt <= effectiveAsOf`.
`recordedThrough` is pinned once, at run start. Knowledge is judged on
`recordedAt`, not `observedAt` — a source can assert at 09:00 what HELM learns at
20:16. No long-lived transaction, serializable isolation or event sourcing: the
record-time cutoff is sufficient because observations are append-only.

**Replay** restores both lenses, the policy, the scenario and the calculation
versions, and reproduces the original input set — not merely the arithmetic.

## 4. Precision: root cause and normalization

**Root cause.** `2 687 699 999.999938 VND` was reported as exact in Phase 3. It
was not. `1.395B / 350M = 279/70` does not terminate; truncated at scale 12 its
residue is ~1e-12, and multiplying by a unit cost of 2.17 × 10⁸ amplified it to
~6.2 × 10⁻⁵ VND. The exact answer is `867/70 × 217 000 000 = 2 687 700 000`,
remainder zero.

**Fix.** Internal scale 12 → 28, and a central precision policy
([ADR-0018](../adr/0018-numerical-normalization.md)): internal, storage and
display precision per unit and per currency, with a rounding mode. The
observation holds the normalized business value; the trace holds both.

| | Before | After |
| --- | --- | --- |
| Working capital | 2 687 699 999.999938 VND | **2 687 700 000 VND** (raw residue ~3 × 10⁻²¹) |
| Cash impact | −1 710 499 999.999938 VND | **−1 710 500 000 VND** |
| Gross margin % | 33.2380952381 | **33.2381** |
| Demand | 8.4 units | **8.4 units** — still fractional |

Also found: `percentageOf` hard-coded `100 × 10^12`, silently encoding the scale.
At scale 28 it returned 0. Now uses `HUNDRED`.

Input fingerprints use the canonical decimal of each value, so `0.7`, `0.70`
and `0.700` fingerprint identically.

## 5. Security and repository drift

**Closed:** the `function_search_path_mutable` advisory on `helm_write_entity`.

**Found while closing it:** two HELM objects existed in the live database but in
**no** repository migration — `helm_write_entity` itself and
`helm_entity_aliases_unique_current_idx`, both applied directly during Phase 1. A
database built from the repository could not have run the Postgres graph adapter.
Both are now reproduced exactly (definition, body, privileges), and a
`helm_set_updated_at` pin that was likewise applied live but never committed is
reproduced too. A scripted diff of all 78 live HELM objects against the
repository now finds none missing.

**New contract:** `verify:schema` fails if any `helm_*` function does not pin its
search path.

All seven HELM functions pin `search_path`; none is `SECURITY DEFINER`. The
remaining advisories are Memoire-owned — five `SECURITY DEFINER` functions and an
Auth password setting — and were not touched.

Server-side regression, inside a transaction that deliberately aborts (nothing
committed, no auth user created): the reconciled RPC still creates, stays
idempotent, and versions; a member writes through it under RLS; a non-member
cannot write into or see another organization; the retired `BASELINE` policy and
a run without a knowledge cutoff are refused. Memoire's nine functions have an
identical fingerprint before and after; 1 106 accounts and 127 opportunities
unchanged.

## 6. Proofs added

| Proof | Where |
| --- | --- |
| Same-run binding under two interleaved runs | `engineSemantics.test.mjs`, `verify:lineage` |
| A run cannot see a fact recorded after its cutoff; a later run can | `engineSemantics.test.mjs` |
| Replay reconstructs the original knowledge boundary | `engineSemantics.test.mjs` |
| FORECAST 5.00B / MODEL 4.70B / VARIANCE −0.30B; Finance still says 5.00B | `truthLayers.test.mjs` |
| A source input reads the forecast even when the model ran | `truthLayers.test.mjs` |
| Precision A–E, no float drift in persisted values | `truthLayers.test.mjs` |

Each new guarantee was negative-tested by reintroducing the old behaviour:
single-lens cutoff, `observedAt` knowledge, `DERIVED` in the source policy,
non-canonical fingerprints, scale 12, and a dependency reading persistence
instead of the run. All six were caught.

Two contract rules were found to be **unable to fail** while doing this, and
fixed: the `search_path` rule could not see a function the repository never
created, and the new local-rounding rule contained a literal backspace character
where `\b` was intended, so it could never match.

## 7. Remaining debt

| Debt | Why | When |
| --- | --- | --- |
| Postgres conformance suites unrun | need a Supabase branch and a signed-in user; credentials cannot be fabricated | when a test branch exists |
| `recordedThrough <= started_at` is not a database constraint | app and database clocks differ; a CHECK between them fails on skew | if runs move server-side |
| Applied migrations are now frozen, so governance changes need a generated sync migration each time | the one-canonical-file generator pattern does not survive applied history | revisit when the next model version lands |
| SUM is the only aggregation the engine implements | `MAX` etc. are modelled in the value graph, not executed | Phase 4 |
| Two forecasts for different future periods on one node resolve "furthest out wins" | horizons keep periods apart today | before multi-period forecasting |
| Memoire `SECURITY DEFINER` advisories | Memoire-owned; out of HELM's remit | Memoire |
