# Phase 5 implemented — Decision Intelligence & Commitment Model

**Date** 2026-09-23 · **Status** complete ·
**ADR** [0021](../adr/0021-decision-runtime.md) ·
**Terminology** [decision-terminology](decision-terminology.md) ·
**Legacy** [decision-engine-assessment](decision-engine-assessment.md) ·
**Principle** [decision quality ≠ outcome quality](decision-quality-vs-outcome.md)

Phase 5 gives HELM the ability to record what management is deciding, which
futures were considered, what evidence and assumptions supported the choice,
what trade-offs were accepted, and what commitment was made — and to hold all of
it still while the model underneath keeps moving.

It adds no recommendation, no score, no ranking and **no authority**.

---

## 1. What a decision is now

```
Decision ── one management QUESTION, scope, trigger, owner,
            four horizon dates, reversibility, knowledge boundary,
            authorityStatus: NOT_EVALUATED
  └─ Revision ── DRAFT → SEALED (a commitment seals one)
        ├─ Alternative ── MODELLED → (scenarioId, revisionId, runId)
        │                 UNMODELLED → a stated reason, no numbers
        │                 WITHDRAWN
        ├─ Criterion ──── HARD_CONSTRAINT | TARGET | PREFERENCE |
        │                 QUALITATIVE | OPTIONAL_WEIGHTED
        │                   └─ Assessment (qualitative, authored by a person)
        ├─ Assumption ── owner, criticality, confidence, source, outcome
        ├─ Challenge ─── OPEN | RESOLVED | ACCEPTED_RISK | REJECTED
        └─ Evidence ──── SUPPORT | CHALLENGE | CONTEXTUALIZE | INVALIDATE
              ↓ commit
        Commitment ── chosen alternative, rationale, accepted trade-offs,
                      expected outcomes READ from the chosen future state,
                      review triggers, action intents · dfp_…
              └─ Snapshot ── the frozen evidence manifest · dsn_…
              └─ Outcome review ── expected vs actual, assumption outcomes
```

The decision holds no values and no economics. Everything numeric is read from
the alternative's own scenario run at display time, so the decision layer
cannot disagree with the model.

## 2. The package

| Package | Added in Phase 5 |
| --- | --- |
| `@helm/decision-runtime` | **new** — types and terminology, ports (`DecisionStore`, `DecisionRuntime`), criterion evaluation, the trade-off space, readiness, the commitment fingerprints, the runtime, in-memory + Postgres stores held to one conformance suite, and the canonical Meridian decision as data |

It sits at the top of the kernel: `shared → ontology → graph-store →
value-graph → propagation-engine → scenario-runtime → **decision-runtime**`.
`verify:architecture` fails if that order is violated, and the decision layer
writes nothing below itself — no observation, no calculation run, no scenario.

## 3. Criteria, evaluated as facts

Six criteria in four styles exercise the canonical decision:

| Criterion | Style | Line | What the model says |
| --- | --- | --- | --- |
| Customer service | HARD_CONSTRAINT | ≥ 90 | A 96.8858 · B 96.8858 · C 91.3495 · D 100 — all SATISFIED |
| Gross margin % | TARGET | ≥ 35 | A 30.517 · B 32.3878 · C 22.9048 — all MISSES_TARGET; D UNKNOWN (BLOCKED: divide by zero) |
| Cash impact | PREFERENCE | — | STATED, never judged |
| Feasibility | TARGET | ≤ 0 units | B 0.385714 MISSES_TARGET, D 0 MEETS_TARGET |
| Inventory optionality | QUALITATIVE | — | authored assessments only; E is NOT_ASSESSED |
| Strategic account | QUALITATIVE | — | authored assessments only |

No total is produced anywhere. A blocked metric stays `UNKNOWN` with its reason
attached, and its alternative stays in the decision — the honest answer to
"what is D's margin?" is "the model cannot compute it, here is why", not zero.

Weights: **no default, none required**. A weighted view exists only once
management records a method, an author and a rationale; without one the request
is refused rather than answered with an invented method.

## 4. The trade-off space

Against a reference alternative, each criterion is a `GAIN`, a `CONCESSION`, the
`SAME`, or `UNRESOLVED`. From the canonical decision, relative to A:

- **B** gains 1.8708 margin points and 55 000 000 VND of cash, and concedes
  inventory optionality (SUPPORT → CONCERN).
- **C** concedes on all six.
- **D** gains service, cash and feasibility, concedes the strategic account, and
  is `UNRESOLVED` on margin (blocked) — plus a comparability note, because it
  models a different period.
- **E** is `UNRESOLVED` on everything, because nothing about it is modelled.

One dominance statement is produced — A over C — qualified by the model it holds
under. **The committed alternative dominates nothing**, which is the point: the
canonical proof would be much weaker if HELM's "obvious" answer and management's
answer coincided.

## 5. Readiness

`READY_WITH_GAPS` for the canonical decision, with every gap named: an
unmodelled alternative, four required criteria that cannot be evaluated for it,
a blocked margin for D, an unowned critical assumption, and Finance's open
challenge. No score, no percentage, and a statement in the report itself that
readiness is procedural completeness and never a judgement of the choice.

## 6. Commitment and immutability

The commitment carries six rationale items (three for the choice, two
"why not", one "what this rests on"), two explicitly accepted trade-offs, three
expected outcomes read from the chosen future state plus one qualitative, three
review triggers and three action intents. `authorship` is management-authored;
the schema cannot store any other kind.

After the commit, `verify:decision-immutability` proves that **nine** distinct
edits are refused, and that the frozen manifest and its fingerprint survive
re-simulation, a rebase and new evidence byte-for-byte. Evidence recorded
afterwards is kept and reported separately as evidence the decision did not
have. Reconsideration opens revision 2 at a later knowledge boundary with every
alternative carried over as `UNMODELLED — not yet simulated`.

## 7. Database

One additive migration, `20260923100000_helm_decision_runtime.sql`, applied to
the shared Supabase project in named parts.

| Object | |
| --- | --- |
| `helm_decisions` | **migrated in place** — management question, kernel state, trigger, four horizon dates, reversibility, knowledge boundary, `authority_status`; `recommendation`, `decided_alternative_id`, `decision_rationale`, `expected_metrics`, `status`, `approved_by` retained and `COMMENT`-marked RETIRED |
| `helm_decision_alternatives` | **migrated in place** — revision, status, scenario/revision/run references, unmodelled reason; a guard refuses an incomplete, still-running, mismatched or foreign run |
| `helm_decision_assumptions` | **migrated in place** — revision, owner, criticality, confidence, source, outcome |
| `helm_actions` | **migrated in place** — action intents with a target system; `writeback` retained and RETIRED |
| `helm_decision_events` | **kept unchanged** — append-only since Phase 1; adopted as the kernel timeline, with the `auth.uid()` initplan fix |
| `helm_decision_revisions` | DRAFT/SEALED, one draft per decision, fork point, reconsideration link; never deleted, sealed rows frozen |
| `helm_decision_criteria` · `_criterion_assessments` · `_weightings` | exact decimals as text, weight only on `OPTIONAL_WEIGHTED`, one weighting per revision |
| `helm_decision_challenges` | resolvable once, never deleted |
| `helm_decision_evidence` | recordable after a commitment, and then outside the manifest |
| `helm_decision_commitments` · `_commitment_snapshots` | insert-only; one commitment per revision; rationale non-empty; manifest records its own knowledge boundary |
| `helm_decision_outcome_reviews` | insert-only, after the fact |
| `helm_approval_rules` | **untouched and unread** — an authority concept, left for Phase 6 to judge |

Business logic stays in code. The triggers enforce **integrity only** —
immutability, tenancy, coherence, lifecycle — and never compute a business
value. No executable JavaScript is stored anywhere.

### Applied to the shared database

| | before | after |
| --- | --- | --- |
| Memoire `accounts` | 1 106 | 1 106 |
| Memoire `opportunities` | 128 | 128 |
| Memoire functions | 9 | 9 |
| Memoire function fingerprint | `eef6a68b…` | `eef6a68b…` (identical) |
| `helm_*` tables | 33 | 42 |
| `helm_*` policies | 112 | 136 |

**52 server-side assertions** were then run inside a transaction that
deliberately aborts — every refusal the guards claim, exercised against real
Postgres. The harness carries the same built-in control Phase 4 introduced: one
deliberately *legal* statement that must be recorded, because a proof harness
that silently swallows its own failures reports a clean pass while proving
nothing. After the rollback every decision table was verified back at zero rows.

Advisors afterwards: **no new security findings** (5 pre-existing
`SECURITY DEFINER` warnings on Memoire's own org helpers and one Auth setting),
and **no `auth_rls_initplan` warnings at all** — the new policies were written
with `auth.uid()` already hoisted. 46 new `unindexed_foreign_keys` INFOs on the
decision tables match the existing pattern; the tables are empty.

## 8. The `/decisions` surfaces

- **`/decisions`** — management questions, preparation state, owner, deadline,
  revision, whether a commitment exists. Not a status board.
- **`/decisions/:id`** — the Decision Workspace: the question at the top, the
  readiness gaps, the context and horizon, the criterion × alternative matrix
  (every value read from that alternative's own simulation), the trade-off
  space, assumptions with their owners, challenges with their resolutions,
  evidence with what it bears on, the commitment with its reasoning and frozen
  manifest, and the timeline.
- **`/memory`** — every commitment with what it rested on and how it turned out.
  It detects nothing.
- **`/` (Attention)** — a signal's "Frame a decision" opens a modal that asks
  for the management question and creates a kernel decision with the signal as
  its trigger. HELM will not write the question.
- **`/settings`** — the approval-rules panel is replaced by "Decision
  authority", which states that `authorityStatus` is `NOT_EVALUATED` and why.

## 9. Contracts

| Contract | Proves |
| --- | --- |
| `verify:decision-schema` | 9 new tables guarded, commitments frozen, authority not storable, a MODELLED alternative must reference its run, weights only where asked for, migration additive |
| `verify:decision-runtime` | one question, 5 alternatives over 4 computed futures, criteria evaluated as facts, a blocked metric stays blocked, qualitative only from people, trade-offs stated, readiness as gaps, commitment authored by management, nothing ranked |
| `verify:decision-lineage` | commitment → rationale → criteria → chosen future → scenario assumptions → calculations → source observations → provenance; dissent preserved |
| `verify:decision-immutability` | 9 edits after commitment refused, the manifest frozen through re-simulation, rebase and new evidence, reconsideration opens a new revision, only the outcome is learnable |
| `verify:decision-scenario-binding` | 15 evaluated values all read from their own alternative's simulation, no economics duplicated, unbindable scenarios refused, mixed boundaries flagged, nothing written below |
| `verify:phase-boundary` | *(updated)* no recommendation, authority, causal inference, optimization, agent debate or pattern learning — across 41 files |

Every contract was mutation-tested. `node scripts/lib/mutate.mjs` breaks
**18 invariants on purpose**, one at a time, and asserts that the contract which
claims to cover each one fails; all 18 are caught, and the working tree is
restored whatever happens. A contract that survives its mutation is a
decoration, so the harness is the proof that these are not.

`npm run check` is green — **408 tests (403 pass, 5 skipped), 25 contracts**,
lint and production build clean.

## 10. Performance

Measured in memory over the canonical Meridian stack (48 value nodes,
13 calculations, 7 simulated scenarios), Node 24 on the development machine, via
`node scripts/lib/bench-decision.mjs`:

| | |
| --- | --- |
| stack build (graph + values + 7 scenarios simulated) | 40 ms |
| canonical decision: build, prepare and commit | 8 ms |
| `createDecision` | 0.01 ms |
| `getWorkspace` (6 criteria × 5 alternatives + readiness) | 3.8 ms |
| `evaluateReadiness` alone | 1.1 ms |
| `tradeOffSpace` (5 alternatives + dominance) | 3.0 ms |
| `getCommitmentSnapshot` (frozen manifest read) | 0.01 ms |
| `explainDecision` (full lineage to source facts) | 2.2 ms |

The shape is what the design predicts. Everything the decision layer does
itself is trivial; the cost is **reading future states** — `getWorkspace` and
`tradeOffSpace` each load one `FutureState` per modelled alternative, so cost is
linear in alternatives and nothing is cached between calls. Committing is
cheaper than reading, because the manifest is built once and afterwards only
read back. No cloud measurement is quoted: no organization has onboarded to the
shared database, and inventing a number would be worse than not having one.

## 11. Debt carried forward

| Debt | Why it is not fixed here |
| --- | --- |
| **Postgres conformance suites skip** | Five suites now need test-branch credentials that do not exist. Skipped, not passing. Flagged since Phase 2 and still flagged; no credentials were fabricated. |
| **No memoization of future states** | See §10. A workspace with 20 alternatives would read 20 future states per render. Caching needs an invalidation story tied to the run, which is a Phase 6+ question. |
| **Structural overrides** | Still declared and refused (Phase 4 debt). An alternative that changes the *shape* of the enterprise — a second distributor — is therefore honestly `UNMODELLED`, which is exactly what alternative E demonstrates. |
| **Period arithmetic** | No roll-up or carry-over, so D moves the whole order to Q1 and its margin blocks. The decision records that as UNKNOWN rather than papering over it. |
| **Aggregation** | The engine still sums; `WEIGHTED_AVERAGE`, `MIN`, `MAX` declared, not executed. |
| **Unindexed foreign keys** on the new tables | Advisor INFO ×46, matching the existing pattern. Tables are empty. |
| **Outcome review needs modelled metrics** | Expected-vs-actual only reaches as far as the value model does. Where a commitment expected something qualitative, the review says so rather than inventing a number. |
| **`helm_approval_rules` left in place** | Unused and unread. Phase 6 decides whether it is the right shape for decision rights. |

## 12. What Phase 5 deliberately does not do

No alternative is recommended, scored, ranked or optimized. No decision is
approved, authorized or escalated, and `authorityStatus` is pinned to
`NOT_EVALUATED` in the type **and** in the database. Nothing learns across
decisions: no pattern detection, no base rates, no causal inference, no
counterfactual engine. Nothing is written into Memoire or any other system — a
commitment produces action intents, and delivering them is a later phase.

Decision rights, approval authority, thresholds, escalation and delegation are
Phase 6.
