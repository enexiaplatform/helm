# Causal graph — layer reference

> **Layer reference.** This file began as the record of the build step that introduced the layer; "Phase N" in the text names that step, not a stage of the product. HELM is one system — read [the architecture](../helm-architecture.md) first. Anything the text says a later step would add now exists: see the other layer references and ADRs 0029–0033.

**Date** 2026-09-30 · **Status** complete in the kernel; pilot **blocked** by the
[trusted runtime deployment gate](../trusted-runtime-deployment-gate.md) (§10) ·
**ADRs** [0026](../../adr/0026-enterprise-causal-graph.md) ·
[0027](../../adr/0027-causal-evidence-policy.md) ·
**Previous** [phase 7](management-twin.md)

Phase 7 made HELM able to say what existed, what was known, what was committed
to and what happened. Phase 8 lets it say what the enterprise **believes** about
why — each belief scoped, backed or challenged by explicit evidence, judged
under a named policy, reconstructable as it stood at any earlier moment — and
keeps that belief visibly apart from what the model computes and from what
merely moved together.

                 CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP

---

## 1. The model

```
Variable (METRIC bound to a value metric · ACTION · CONDITION · EVENT · OUTCOME)
   │
CausalClaim (identity, immutable): cause · effect · relationship · scope · conditions · applicable period
   ├─ revisions (append-only): statement · mechanism · confounders · rationale · external validity · lineage
   └─ evidence links (append-only): SUPPORTS | CHALLENGES | CONTRADICTS | CONTEXTUALIZES
          └─ Evidence (append-only, corrections supersede): type · graded strength · provenance · observed times
CorrelationFinding — a different object; never a claim
CausalQuestion ─ candidates: claims people proposed (HELM proposes none)
Status + confidence: DERIVED at a lens by helm-causal-evidence@1 — never stored
```

Package **`@helm/causal-runtime`**, the new top of the kernel (it reads the twin;
nothing below imports it; it writes nothing below it).

| Module | Job |
| --- | --- |
| `types.ts` | vocabulary: variables, claims, revisions, evidence, links, correlations, questions, evaluations |
| `policy.ts` | the evidence hierarchy, ceilings and status rules (ADR-0027) |
| `scope.ts` | applicability of a claim to a context, dimension by dimension |
| `runtime.ts` | lens-based evaluation, explanation with history, bounded traversal and paths, investigation, projection |
| `integration.ts` | twin difference → model explanation + causal investigation; decision/scenario references; causal attention |
| `inMemoryStore.ts` · `postgres.ts` · `conformance.ts` | two stores, one contract |
| `meridianCausal.ts` | the DEMO CAUSAL HYPOTHESES story |

## 2. Database

One additive migration, `20260930090000_helm_causal_graph.sql`, applied to the
shared project in **six** named parts (the fifth and sixth fix two defects the
live proof found — §3).

| Object | |
| --- | --- |
| `helm_causal_variables` | per-org keys; METRIC ⇔ metric key |
| `helm_causal_claims` | eight verbs, no CAUSES; scoped or justified enterprise-wide; qualifier coherence; no status column |
| `helm_causal_claim_revisions` | sequential, stop at retirement; retirement explained |
| `helm_causal_evidence` | ten types; provenance required; judgement labelled; statistics stated; one supersession per item |
| `helm_causal_evidence_links` | one per (claim, evidence); a contradictory case never supports |
| `helm_correlation_findings` | method, population, period, estimate, uncertainty, limitations — all required |
| `helm_causal_questions` · `helm_causal_question_candidates` | candidates are existing claims |
| guards | write-once; `NEW.recorded_at := now()` (the database's record time); same-org references; deferred "claim has revision 1" |
| `helm_private` | row rules `causal_claim_row_visible`, `causal_evidence_row_visible`, `causal_question_row_visible`, by-id wrappers, `causal_claim_evidence`, `causal_claim_classes`, `causal_claim_decisions` |
| `helm_record_causal_claim(jsonb, jsonb)` | SECURITY INVOKER; claim and revision 1 in one transaction |
| privileges | anon: none; authenticated: SELECT, INSERT only (UPDATE/DELETE/TRUNCATE revoked) |

### Applied to the shared database

| | before | after |
| --- | --- | --- |
| Memoire `accounts` / `opportunities` | 1 106 / 129 | 1 106 / 129 |
| Memoire functions · fingerprint | 9 · `eef6a68b…` | 9 · `eef6a68b…` (identical) |
| `helm_*` tables | 56 | 64 |
| public policies | 232 | 248 |
| `helm_private` functions | 11 | 20 |

## 3. Server-side proof (rolled back)

**41 assertions: 31 refusals and 10 legal controls, 0 failures.** Fixture users,
orgs, units, decision, variables, claims and evidence verified back at zero.

| Proved | |
| --- | --- |
| Pharma member reads the org-wide, Pharma-restricted and Pharma-decision claims (control); **not** a FINANCIAL claim, a claim resting on STRATEGIC evidence, the link to that evidence, a withheld claim's wording, another org's claim, a FINANCIAL variable | RLS |
| Industrial member reads the org-wide claim (control); **not** the Pharma-restricted claim, **not** the claim resting on the Pharma decision | BU restriction, decision capture |
| Country GM (FINANCIAL clearance) reads the restricted, financial and decision-bound claims (control); **not** the STRATEGIC claim or its evidence | subtree + compartments |
| admin reads the STRATEGIC claim (control) | |
| writing into another org · in someone else's name · evidence of an uncleared class · retiring someone else's claim | refused |
| a reader may revise (control); the claim writer, a member's evidence and a member's question each read their own row back via RETURNING (controls) | |
| UPDATE by a client (no privilege) · UPDATE / DELETE by the owner (guards) · CAUSES · unscoped · unknown variable · judgement as measurement · statistic without limitations · contradictory case as support · second supersession · cross-org link · skipped revision · revision after retirement · claim without revision 1 · correlation without limitations · anon calling a helper | refused |
| record time stamped by the database (control) | |

**Two defects found by the proof, fixed before it passed:**

1. **RLS refused `INSERT … RETURNING`.** SELECT policies that re-read their
   own row by id (`can_see_causal_claim(id)`) cannot see a row inserted in the
   same statement, so every client write that reads its record back would
   fail. Policies now take the row's own columns (part 5). `verify:causal-schema`
   now forbids the pattern; a mutation proves it.
2. **Default privileges.** Supabase grants `authenticated` UPDATE and DELETE on
   new public tables; RLS matched no row, but the privilege is now revoked
   (part 6).

**The same RETURNING defect existed in Phases 6 and 7** (four tables:
`helm_decisions`, `helm_scenarios`, `helm_scenario_runs`, `helm_twin_snapshots`);
a rolled-back check confirmed `helm_save_twin_snapshot` was refused even for an
org admin. Fixed in its own additive migration,
`20260930100000_helm_rls_row_visibility.sql` (same rules, row-based; the twin
tables lose the default UPDATE/DELETE privilege), proved server-side (5
refusals, 9 controls including member inserts read back through RETURNING and
the captured-scenario and BU-restriction rules unchanged), and now forbidden
by `verify:schema` (`rls-returning`).

**Advisors afterwards.** Security: no new findings (the causal helpers live in
`helm_private`); the five shared-core helper WARNs and leaked-password
protection remain. Performance: no `auth_rls_initplan`; 17 new
`unindexed_foreign_keys` INFOs on the empty causal tables.

## 4. Canonical Rohto causal investigation (DEMO)

```
OBSERVED DIFFERENCE   CF1 → S2   Gross margin 32.3878 % → 31.7 %   −0.6878 pts

MODEL EXPLANATION     fulfilment cost 165 000 000 → 185 220 000 VND  (+20 220 000)
                      the committed plan = SCM's 140 000 000 estimate + 25 000 000 transfer allowance
                      (S1 → S2 shows the same input 140 000 000 → 185 220 000, +45 220 000)

CAUSAL INVESTIGATION  "Why did Q4 fulfilment cost come in 20 220 000 VND above the committed plan
                       (45 220 000 above SCM's original estimate)?"          SUPPORTED_EXPLANATION_EXISTS
   H1 Expedited transfer by air INCREASES fulfilment cost    SUPPORTED · MODERATE
      mechanism: expedite → flown instead of trucked → air-freight surcharge booked as fulfilment cost
      for: judgement (LOW), SCM freight invoice (MEDIUM, PROCESS_MECHANISM), 2025 expedite review (MEDIUM, REPEATED_PATTERN)
   H2 Supplier surcharge                                      UNRESOLVED (LOW for, LOW against: no invoice found)
   H3 Customs and handling                                    UNRESOLVED (MEDIUM ledger line, LOW "already estimated")
   H4 January supplier price revision                         WEAKENED — TEMPORAL_CONFLICT: effective 20 Jan, after the cost

IMPORTANT  The model dependency between fulfilment cost and margin is not itself evidence
           of why fulfilment cost moved. How much H1 explains is not quantified.
```

**The brief's "+45.22M" versus the twin's +20.22M.** The committed future
already planned 165 000 000 VND (SCM's 140M plus a 25M transfer allowance), so
the CF1 → S2 margin gap of −0.6878 pts is explained by +20 220 000, not
+45 220 000. The question states both; the twin's S1 → S2 difference shows the
+45.22M against SCM's estimate.

Also: **C2** fulfilment cost DECREASES gross margin — SUPPORTED on its own
evidence (accounting policy + eight quarters), shown beside the KNOWN VALUE
DEPENDENCY `gross_margin@1.0.0 → gross_margin_pct@1.0.0`, never counted in it.
**C3** faster delivery INCREASES Rohto's service outcome — HYPOTHESIS on
judgement alone, linked to the decision's on-time-delivery assumption, raised
as `DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED@1`.

## 5. The proofs

| Proof | Result |
| --- | --- |
| Contradictory evidence | D1 (Q3 discount raised Industrial volume): SUPPORTED on 1 Feb (INTERVENTION + REPEATED_PATTERN), CONTESTED after Finance's NATURAL_EXPERIMENT; the supporting evidence is kept; Finance's competing D2 (market demand) stored beside it; MARKET_DEMAND recorded as a confounder |
| Temporal impossibility | H4 — cause observed after the effect → TEMPORAL_CONFLICT, counted against, WEAKENED, never SUPPORTED |
| Scope limitation | H1 (Pharma BU / Rohto) OUTSIDE Thailand Pharma and Industrial; APPLIES_TO_PART of Vietnam; no fulfilment-cost claim applies in Thailand Pharma |
| Historical knowledge | H1 HYPOTHESIS on 19 Jan, SUPPORTED after 20 Jan; 19 Jan unchanged afterwards; at S2's knowledge boundary no claim existed yet |
| Causal cycle | service failure → churn → revenue pressure → cost cutting → service failure: stored; traversal requires maxDepth, terminates, marks the closing edge; a loop is not a path |
| Dependency vs causality | the whole causal story leaves formulas, runs and observations identical; a claim between two model-linked metrics with no evidence is HYPOTHESIS / NONE |
| Coincidence | inventory allocation changed and satisfaction improved in Q4: a CorrelationFinding, no claim; "why did satisfaction improve?" is OPEN |
| Lineage | 14 claims and 14 evidence items with provenance; H1 → CF1, S2, value node, customer, invoice; C3 → decision and assumption |

## 6. Twin, decision and scenario integration

- **`/twin`**: a value difference shows MODEL EXPLANATION, then CAUSAL
  HYPOTHESES per moved input (or "no causal knowledge"), then the IMPORTANT
  note. A twin snapshot's `recordedThrough` is the causal knowledge boundary.
- **Decisions / scenarios**: claims carry DECISION, ASSUMPTION and SCENARIO
  references; `claimsReferencing` finds them; neither runtime is changed.
- **Attention**: `CRITICAL_CAUSAL_ASSUMPTION_CONTESTED@1`,
  `DECISION_ASSUMPTION_CAUSALLY_UNSUPPORTED@1`, `TEMPORAL_CONFLICT_IN_EVIDENCE@1`
  — named conditions, unscored.

## 7. `/causal` (Kernel instrument)

Questions with their candidates; claims (status pill, cause → relationship →
effect, scope, confidence, for/against); known value dependencies; correlations;
"Why do we believe this?" — mechanism, evidence for, against and context with
provenance and ceilings, scope, conditions, confounders, period, external
validity, the model dependency apart, how the belief changed, and bounded
paths. Five visual kinds never drawn alike: KNOWN VALUE DEPENDENCY, CAUSAL
HYPOTHESIS, SUPPORTED CLAIM, CONTESTED CLAIM, CORRELATION. "Read as" and "As
known on" select the reader and the lens.

## 8. Contracts and tests

`verify:causal-schema`, `-runtime`, `-evidence`, `-temporality`, `-scope`,
`-vs-calculation`, `-lineage`, `-security`, and `verify:phase-boundary`
(updated: causal knowledge confined to its package; no counterfactual, causal
inference engine, causal score or path probability anywhere; the causal runtime
writes nothing below it). `node scripts/lib/mutate.mjs` breaks **98
invariants** across 28 contracts (32 of them Phase 8); every one is caught.

## 9. Performance (in memory; no database timing is quoted)

`node scripts/lib/bench-causal.mjs`, canonical story (14 claims, 14 evidence):

| | |
| --- | --- |
| claim retrieval (getClaim, evaluated) | 0.02 ms |
| all claims, each evaluated | 0.17 ms |
| historical view reconstructed (19 Jan) | 0.06 ms |
| evidence evaluation alone (pure) | 0.01 ms |
| traversal, depth 4 · feedback loop, depth 8 | 0.16 ms · 0.16 ms |
| paths | 0.16 ms |
| claim explanation with history | 0.07 ms |
| question investigation | 0.32 ms |
| twin difference → causal hypotheses | 2.17 ms |

## 10. Maturity, blockers and debt

| Layer | State |
| --- | --- |
| Kernel | Phase 8 complete |
| Shared database schema | Phase 8 migration applied and verified (41 assertions) |
| Postgres causal store | written; conformance suite **SKIPPED** (no isolated authenticated environment) |
| Trusted authority deployment | **NOT DEPLOYED** (unchanged) |
| Cloud end-to-end readiness | **NOT YET PROVEN** |
| Production / pilot readiness | **BLOCKED** by the deployment gate |

- **Blocker A** — unchanged.
- **Blocker B** — now 8 SKIPPED suites (the causal store joins them). Causal
  claims are shown beside decisions and the twin in the demo; in the cloud their
  persistence is unproven, and the Phase 7 twin save defect above shows why the
  gate matters.
- Debt: entity-type sensitivity classes; unindexed foreign keys (INFO); no cloud UI to author
  claims (the demo authors them through the kernel).

## 11. What Phase 8 does not do

No causal discovery, inference, do-calculus, Bayesian networks, structural
equations, uplift models, counterfactuals (Phase 10), pattern learning across
decisions (Phase 9), AI causal recommendation, optimization or agent debate.
Phase 9 has not been started.
