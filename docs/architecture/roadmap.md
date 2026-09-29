# Implementation Roadmap

Sixteen phases, in order, with what already exists credited and the gates that
make each phase complete. Status as of **2026-09-30** (Phases 0–6 delivered; Phases 7 and 8 delivered in the kernel).

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
| 3 | Propagation Engine | **✅ done** | 13 governed calculations, exact decimals, lineage | [phase-3-implemented.md](phase-3-implemented.md) |
| 4 | Scenario Runtime | **✅ done** | 7 canonical futures over one pinned baseline | [phase-4-implemented.md](phase-4-implemented.md) |
| 5 | Decision Intelligence | **✅ done** | question, alternatives bound to runs, criteria, commitment | [phase-5-implemented.md](phase-5-implemented.md) |
| 6 | Authority Graph | **✅ done** | roles, DOA versions, consequence-based rules, delegation, approval acts, scoped decision RLS | [phase-6-implemented.md](phase-6-implemented.md) |
| 7 | Management Digital Twin | **✅ done in the kernel** (cloud path: pilot blockers) | versioned snapshots in five kinds, two-time lens, twin delta, trajectory, lineage, sensitivity, trusted authority service | [phase-7-implemented.md](phase-7-implemented.md) |
| 8 | Enterprise Causal Graph | **✅ done in the kernel** (cloud path: pilot blockers) | scoped causal claims, evidence hierarchy, derived status, two-time reconstruction, bounded traversal, correlation apart, twin integration | [phase-8-implemented.md](phase-8-implemented.md) |
| 9 | Management Genome | planned | commitments + outcome reviews as substrate; no learner | structured `find_similar_*`, not embeddings-only |
| 10 | Counterfactual | planned | nothing | actual vs expected vs alternative with confidence |
| 11 | AI Intelligence Runtime | planned | none by design | provider port; citation validation rejects ungrounded ids |
| 12 | Multi-Agent | planned | nothing | 6 function agents + debate → synthesis |
| 13 | Memoire Connector | ♻ formalize | working bridge, no contract | `SourceConnector` + pure `translate()` + fixtures |
| 14 | Country GM Cockpit | **blocked on the [deployment gate](trusted-runtime-deployment-gate.md)** | signal inbox; twin attention rules | attention-first; every card traces to kernel objects |
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

## 4. Phases 2 and 3 — Value Graph and Propagation (both delivered)

**Phase 2** added value metrics with machine-readable semantics, value nodes
attached to ontology entities, twelve typed value link types, and observations
that keep actual, forecast, target and scenario apart. The canonical chain —
Opportunity → Expected Revenue → Demand → Inventory → Working Capital → Margin
→ Cash → Enterprise Value — is traversable in both directions, and enterprise
value is represented as six competing dimensions rather than one score.
Record: [phase-2-implemented.md](phase-2-implemented.md).

**Phase 3** was the pivot from "a management app" to "management
infrastructure". The calculation registry, dependency ordering, deterministic
execution and the append-only calculation trace arrived, along with the Meridian
Pharma Value Model v1 — nine governed calculations that write `DERIVED`
observations onto the value nodes Phase 2 built.

The gate was the product promise: **a manager clicks any number and sees source,
formula, inputs, timestamp, assumptions, confidence and upstream dependencies,
all the way down to a source-system fact.** `verify:lineage` makes it
executable, and every derived number in the canonical chain passes it.
Record: [phase-3-implemented.md](phase-3-implemented.md).

One expectation stated here did not survive contact with the work: the eight
existing engines did **not** become registered calculations. Four of them are
not calculations at all, and the other four need value metrics or entity
projections that do not exist yet. Wrapping them would have filled the
dependency graph with calculations that could not run. See
[the assessment](engine-integration-assessment.md) for the engine-by-engine
verdict and what each is blocked on.

**Phase 4** made the model branch. A scenario stopped being a CVP what-if over
four numbers and became a *branch of the enterprise model*: a fork point, a
sealed set of explicit overrides, and a simulation that re-executes the **same**
propagation engine against the **same** source world with those overrides
applied as an input overlay. Nothing is copied and no fake observation is
written, so the baseline a manager reads is never polluted by somebody's
what-if.

Period identity arrived with it and closed the Phase 3 "furthest-out forecast
wins" defect — by refusing rather than guessing
([ADR-0020](../adr/0020-period-identity.md)).

The gate was the trade-off space: seven canonical futures over the Meridian
baseline, each traceable to its stated assumptions, compared side by side with
origin and confidence on every value — **and no recommendation**. Choosing
between them is Phase 5's job, and `verify:phase-boundary` fails the build if
Phase 4 starts doing it.
Record: [phase-4-implemented.md](phase-4-implemented.md) ·
[ADR-0019](../adr/0019-scenario-runtime.md) ·
[terminology](scenario-terminology.md) ·
[legacy engine assessment](scenario-engine-assessment.md).

**Phase 5** made the reasoning durable. A decision stopped being a status on a
row and became a management *question* with the alternatives considered, the
criteria management stated, the assumptions somebody owns, the disagreement
somebody voiced, the evidence it rested on, and a commitment that freezes all of
it. An alternative carries no economics of its own: it references the scenario
revision and the run that computed its future, so a decision can never disagree
with the model.

One expectation stated here did not survive the work, and is worth naming: this
roadmap said an *approval* would record which future it approved. It does not.
Phase 5 records a **commitment**, and commitment is not approval — a person
decided, on stated grounds; whether they were permitted to is a different
question. Every commitment carries `authorityStatus: NOT_EVALUATED`, pinned in
the type and by a database constraint, so Phase 6 can answer it without
rewriting anything decided before it existed.

The gate was decision lineage: **why did management choose this?** resolves
through the rationale, the criteria, the chosen future state, the scenario
assumptions and the calculation traces to a source fact — with the rejected
futures, the open challenge and the accepted trade-offs still attached.
Record: [phase-5-implemented.md](phase-5-implemented.md) ·
[ADR-0021](../adr/0021-decision-runtime.md) ·
[terminology](decision-terminology.md) ·
[legacy engine assessment](decision-engine-assessment.md) ·
[decision quality ≠ outcome quality](decision-quality-vs-outcome.md).

## 5. Phase 6 — decision authority (delivered)

**Phase 6 was a security phase.** Authority gained scope, geography, BU, acts,
thresholds on computed consequences, approval chains, escalation and
delegation, and decision visibility became unit-scoped in RLS
([security-model.md §3](security-model.md#3-known-gaps-and-the-phase-that-closes-each)).
The commitment stayed exactly as Phase 5 recorded it: authority is a separate,
fingerprint-bound judgement of it. Record: [phase-6-implemented.md](phase-6-implemented.md) ·
[ADR-0022](../adr/0022-decision-authority-graph.md).

It gates Phase 14: a cockpit exists to present cross-functional data to a scoped
role, so shipping it while any org member can read every country's margins would
be a defect, not a feature.

## 6. Phase 7 — Management Digital Twin (delivered in the kernel)

The enterprise as a versioned management state: immutable snapshots that
reference the kernel records they were read from, under a two-time lens
(business time and knowledge time), replayable to the same fingerprint.
"Current vs committed future" is a comparison of snapshots — distance to intent
before the period ends, expected against actual after. The phase also closed
three Phase 6 debts: verdicts are computed by a trusted server-side service
([ADR-0024](../adr/0024-trusted-authority-runtime.md)); scenarios and values
follow decision visibility and sensitivity classes, and the helpers moved to
`helm_private` ([ADR-0025](../adr/0025-sensitivity-and-scenario-visibility.md)).
Record: [phase-7-implemented.md](phase-7-implemented.md) ·
[ADR-0023](../adr/0023-management-digital-twin.md).

| Layer | State |
| --- | --- |
| Kernel | Phase 7 complete |
| Shared database schema | Phase 7 migration applied and verified |
| Trusted authority implementation | built and contract-tested |
| Trusted authority deployment | **NOT DEPLOYED** |
| Postgres conformance | **8 suites SKIPPED** (no isolated credentials; the causal store added in Phase 8) |
| Cloud end-to-end readiness | **NOT YET PROVEN** |
| Production / pilot readiness | **BLOCKED** by the [trusted runtime deployment gate](trusted-runtime-deployment-gate.md) |

Blocker A (runtime not deployed, cloud path unproven) and Blocker B (Postgres
conformance never run in an isolated authenticated environment) gate pilot
use, production governance and Phase 14.

## 6a. Phase 8 — Enterprise Causal Graph (delivered in the kernel)

What the enterprise has evidence to believe influences its outcomes: scoped,
versioned causal claims judged by explicit evidence under a named policy, with
status derived at a lens and never stored, kept apart from calculation
dependency, correlation and coincidence. Record:
[phase-8-implemented.md](phase-8-implemented.md) ·
[ADR-0026](../adr/0026-enterprise-causal-graph.md) ·
[ADR-0027](../adr/0027-causal-evidence-policy.md). The Postgres causal store
joins Blocker B (8 suites SKIPPED).

## 6b. Phases 9–10 — learning, counterfactuals

9 turns
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
