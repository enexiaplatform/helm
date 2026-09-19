# Implementation Roadmap

Sixteen phases, in order, with what already exists credited and the gates that
make each phase complete. Status as of **2026-09-19** (Phases 0, 1 and 2 delivered).

## 1. Sequencing principle

**Build the kernel before the surfaces.** Propagation needs a value graph; a
value graph needs an ontology. Skipping to the cockpit produces charts over
disconnected silos — which is what HELM exists not to be.

Concretely: the existing build already has working scenario, decision and
outcome machinery (Phases 4, 5 and part of 9) **but no foundation underneath**.
So the roadmap does not run 1→15 linearly; it builds 1–3 to put a floor under
what exists, then returns to 4–6 to reconnect them.

```mermaid
flowchart LR
    P0["0 ✅<br/>Foundation"] --> P1["1 ✅<br/>Ontology"]
    P1 --> P2["2 ✅<br/>Value Graph"] --> P3["3 ▶<br/>Propagation"]
    P3 --> P4["4 ♻<br/>Scenario"] --> P5["5 ♻<br/>Decision"] --> P6["6 🔒<br/>Authority"]
    P6 --> P7["7<br/>Digital Twin"] --> P8["8<br/>Causal"]
    P8 --> P9["9 ♻<br/>Genome"] --> P10["10<br/>Counterfactual"]
    P3 --> P13["13 ♻<br/>Memoire connector"]
    P10 --> P11["11<br/>AI Runtime"] --> P12["12<br/>Agents"]
    P7 --> P14["14<br/>GM Cockpit"]
    P6 --> P14
    P12 --> P15["15<br/>Review Loop"]
    P14 --> P15
```

✅ done · ▶ next · ♻ partially exists, needs reconnection · 🔒 gates the cockpit

## 2. Phase table

| # | Phase | Status | Exists today | Gate |
| --- | --- | --- | --- | --- |
| 0 | Architecture Foundation | **✅ done** | — | docs + 11 ADRs + backlog |
| 1 | Enterprise Ontology | **✅ done** | 3 packages, 8 tables, 43+34 seeded types | [phase-1-implemented.md](phase-1-implemented.md) |
| 2 | Value Graph | **✅ done** | metrics, nodes, links, typed observations | [phase-2-implemented.md](phase-2-implemented.md) |
| 3 | Propagation Engine | **▶ next** | value graph + 8 pure engines to wrap | `explain()` reaches source facts for every number |
| 4 | Scenario Engine | ♻ reconnect | `engines/scenario.ts`, `helm_scenarios`, tornado | scenarios become graph overrides |
| 5 | Decision Engine | ♻ reconnect | full lifecycle, alternatives, assumptions, audit | options carry scenario ids; lines become overrides |
| 6 | Authority Graph | 🔒 redesign | amount-threshold rules only | multi-dimensional rules + chain + escalation + unit RLS |
| 7 | Digital Twin | planned | nothing | versioned snapshots; current / scenario / expected-future |
| 8 | Causal Graph | planned | nothing | hypotheses with evidence both ways; correlation kept distinct |
| 9 | Management Genome | ♻ extend | `engines/decisionMemory.ts` patterns | structured `find_similar_*`, not embeddings-only |
| 10 | Counterfactual | planned | nothing | actual vs expected vs alternative with confidence |
| 11 | AI Intelligence Runtime | planned | none by design | provider port; citation validation rejects ungrounded ids |
| 12 | Multi-Agent | planned | nothing | 6 function agents + debate → synthesis |
| 13 | Memoire Connector | ♻ formalize | working bridge, no contract | `SourceConnector` + pure `translate()` + fixtures |
| 14 | Country GM Cockpit | **blocked on 6, 7** | signal inbox | attention-first; every card traces to kernel objects |
| 15 | Management Review Loop | planned | nothing | W/M/Q reviews generated from the model |

## 3. Phase 1 — Enterprise Ontology (delivered)

Built: `@helm/shared`, `@helm/ontology`, `@helm/graph-store` (in-memory **and**
Postgres adapters behind one conformance suite), eight additive `helm_*` tables
with RLS, 43 entity types and 34 relationship types seeded as registry data, the
canonical Meridian Vietnam graph, five `verify:*` contracts, and a read-only
Ontology Explorer.

Gates met: idempotent ingestion · `asOf` valid-time queries · record-time history
per entity · provenance on every entity and relationship · cross-system identity
resolution through aliases · bounded traversal · tenant isolation proven
server-side · 126 tests green · typecheck, lint and build clean.

One gate deferred with cause: the TypeScript conformance suite has not been run
against Postgres, because that needs authenticated test credentials. The write
path and RLS were instead verified server-side with 24 live assertions.

Full record, including deviations and debt:
[phase-1-implemented.md](phase-1-implemented.md).
Original task breakdown: [../product/backlog-phase-1.md](../product/backlog-phase-1.md).

## 4. Phase 2 — Value Graph (delivered) and Phase 3 — Propagation (next)

**Phase 2** added value metrics with machine-readable semantics, value nodes
attached to ontology entities, twelve typed value link types, and observations
that keep actual, forecast, target and scenario apart. The canonical chain —
Opportunity → Expected Revenue → Demand → Inventory → Working Capital → Margin
→ Cash → Enterprise Value — is traversable in both directions, and enterprise
value is represented as six competing dimensions rather than one score.
Record: [phase-2-implemented.md](phase-2-implemented.md).

**Phase 3** is the pivot from "a management app" to "management infrastructure".
The calculation registry, dependency ordering, execution and the calculation
audit log arrive; the eight existing engines become registered calculations that
write `DERIVED` observations onto the value nodes Phase 2 built.

Gate for Phase 3, stated as the product promise: **a manager clicks any number
and sees source, formula, inputs, timestamp, assumptions, confidence and upstream
dependencies, all the way down to a source-system fact.** No number in HELM may
exist without that chain.

## 5. Phases 4–6 — reconnect governance

4 and 5 exist and work; their job here is to stop being self-contained. Scenario
variants become sparse graph overrides; decision alternatives stop being
free-typed financial lines and become overrides whose consequences are computed.

**Phase 6 is a security phase.** Authority gains scope, geography, BU, risk,
action type, approval chain and escalation; unit-level and functional RLS land
with it ([security-model.md §3](security-model.md#3-known-gaps-and-the-phase-that-closes-each)).
It gates Phase 14: a cockpit exists to present cross-functional data to a scoped
role, so shipping it while any org member can read every country's margins would
be a defect, not a feature.

## 6. Phases 7–10 — state, causality, learning

7 gives versioned enterprise state, so "current vs scenario vs expected future"
is a comparison of snapshots. 8 separates correlation from management causal
hypothesis, with evidence for *and against* and a confidence that moves. 9 turns
the existing pattern detection into retrieval over structured situation patterns.
10 delivers counterfactuals as scenario comparison, behind an interface that
causal inference can implement later.

## 7. Phases 11–13 — intelligence and integration

AI enters **only after** the kernel can ground it. The gate is mechanical: a
response citing an id absent from its `GroundedContext` is rejected by the
runtime. Agents represent management functions and receive scope-narrowed
context. Phase 13 formalises the Memoire bridge into the connector contract that
ERP, Finance and SCM will reuse — and can run earlier, since it only needs
Phase 3.

## 8. Phases 14–15 — the applications

The cockpit opens on *what requires management attention*, not a wall of charts.
Each card traces to kernel objects, and clicking one opens context → why it
matters → value-chain impact → root causes → options → scenario comparison →
similar past decisions → recommendation → authority requirements → decision
action → outcome tracking.

Phase 15 generates weekly, monthly and quarterly reviews from the model: what
changed, why, where value moved, which decisions worked, which assumptions were
wrong, what needs escalation, what happens next.

## 9. Definition of done (every phase, from §19)

1. Relevant existing code inspected
2. Architecture docs written or updated
3. Domain model defined
4. Interfaces defined
5. Migration created (additive)
6. Domain logic implemented
7. APIs implemented
8. Minimal UI only if required
9. Demo data seeded
10. Unit tests written
11. Integration tests written
12. Tests run and green
13. Lint and typecheck clean
14. What was built documented
15. Remaining technical debt named

A phase is **not** complete if tests fail, typecheck fails, business logic is
untested, domain logic lives in React components, or an architectural assumption
is undocumented. Foundational changes need an ADR first
([ADR-0001](../adr/0001-record-architecture-decisions.md)).

## 10. Standing risks

| Risk | Mitigation |
| --- | --- |
| **No version control** | `git init` blocks Phase 1 step 1 |
| Shared production database | additive migrations, `verify:additive-migrations` |
| `helm_*` reshaping window closes at first real onboarding | do Phases 1–3 schema work now, while all `helm_*` tables are empty |
| Cockpit pressure before Phase 6 | phase gate documented here and in the security model |
| Ontology over-modelling | seed only what the canonical scenario needs; types are data, so additions are cheap |
| Propagation performance on deep graphs | `maxDepth` required on every traversal; measure before optimising |
| AI drift into ungrounded answers | citation validation is a rejection, not a warning |
