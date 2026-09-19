# ADR-0011: Preserve the decision kernel; reconcile it with the value model

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

Two model shapes are in play.

**What exists** is decision-centric. `helm_decisions` is the aggregate root, with
alternatives, assumptions, an append-only event log, actions, approval rules and
an outcome ledger. Eight pure engines compute managerial-accounting results:
CVP, relevant cost, scenario sensitivity, inventory, capacity, cost-object
economics, signal rules, decision-memory patterns. Forty tests, all green.

**What the brief specifies** is value-centric. The primitive is enterprise value,
and the system's job is to model how value is created, destroyed, transferred,
protected and compounded — with decisions as one thing that acts on that model.

These are easy to mistake for a conflict, and the mistake is expensive in either
direction: rewriting the decision kernel to be "value-first" would discard working
governance machinery, while grafting a value graph onto the side would produce two
models that disagree.

## Problem

Does the existing decision-centric model get rebuilt on top of the value graph,
kept beside it, or connected to it — and if connected, how?

## Options considered

1. **Rewrite decisions as value-graph operations.** Conceptually pure: everything
   is an entity, a decision is a node, alternatives are scenario overlays. Costs:
   discards a working state machine, approval logic, audit trail and 40 tests;
   loses the relational integrity that governance needs; and puts the most
   safety-critical part of the system into the least-proven part of the model. A
   lifecycle with approvals genuinely belongs in relational tables with
   constraints, not in a generic graph.
2. **Keep them separate.** Value graph for analysis, decision tables for
   governance, no structural link. Cheapest, and it defeats the purpose: an
   option's consequences could never be computed, only typed in by hand — which is
   what `helm_decision_alternatives.financial_lines` is today.
3. **Connect them: decisions stay relational, and their analytical content becomes
   value-graph operations.** A decision references entities and scenarios; an
   alternative's financial lines become graph overrides whose consequences are
   computed; outcomes feed back as evidence and recalibration.
4. **Make the value graph a read model projected from decisions.** Inverts the
   dependency — the graph would only know what decisions had already touched, so
   it could never detect an emerging problem no one had decided about yet. That is
   the opposite of the SENSE step.

## Decision

**Option 3.** Both models are kept, with a defined seam.

### Division of responsibility

| Concern | Home | Why |
| --- | --- | --- |
| What exists and how it connects | ontology (graph) | extensible, temporal, provenance-bearing |
| How numbers reach each other | value graph + propagation | traversable, explainable |
| Causal belief | causal graph | confidence must move with evidence |
| Decision lifecycle, approval, audit | relational `helm_*` tables | constraints, RLS, append-only guarantees |
| Enterprise state over time | digital twin snapshots | versioned, comparable |
| Learning | genome + causal feedback | patterns need structured filters |

The principle: **the graph models the enterprise; relational tables govern the
process.** A graph is the right tool for "what touches what"; a constrained
relational table is the right tool for "this cannot reach `approved` without a
qualified approver".

### Four specific connections

**1. Signals point at chains.** `helm_signals` gains `value_node_id`. Today a
signal says "SKU-X has a negative segment margin"; afterwards it says that *and*
shows the chain that produced it and what lies downstream.

**2. Alternatives become overrides.** `financial_lines` today are typed-in numbers
with a `kind` that marks them relevant, sunk or allocated. They become a set of
value-graph overrides, and the incremental comparison is *computed* rather than
entered. The relevant-cost engine keeps its exact role — classifying relevance and
publishing `excludedLines` — but operates on derived values.

This is the most valuable single connection in the whole reconciliation, because
it turns an option from an assertion into a model.

**3. Scenarios become sparse overlays.** `helm_scenarios.baseline` + `variants`
JSON becomes a set of relationship and observation overrides carrying
`scenario_id`. Every option then reports the same metric set, so comparison is
apples to apples by construction.

**4. Outcomes recalibrate the graph.** A failed assumption is evidence against the
causal hypothesis it rested on, and lowers the confidence of the links involved.
This is the compounding mechanism; it only works because links carry confidence as
data.

### The eight engines are wrapped, not rewritten

Each engine is already a pure function from inputs to outputs — precisely what
`helm_calculations` describes. Phase 3 registers them as calculations, adding the
`trace` and declaring their inputs and output metrics. `signals.ts` changes more
than the others: it stops consuming hand-assembled silo inputs and starts
consuming propagated values.

Estimated shape of the work: seven engines are mechanical wrapping; `signals.ts`
is a genuine rewire.

### The digital twin is narrowly defined

To prevent a third competing model, the twin is **versioned snapshots and state
projections over the ontology and value graph** — never its own parallel
representation of the enterprise. A twin snapshot is a point-in-time materialised
view with a version, not a second source of truth.

## Consequences

**Good.** Nothing working is discarded. Governance keeps relational guarantees.
Analysis gains a real model. The migration is incremental and every step keeps the
suite green. Both brief requirements are satisfied without contradiction.

**Bad.** Two representations to keep coherent. A decision's analytical content
spans the graph and its own tables, so some queries join both. Engineers must
learn where each concern lives — which is what the table above exists for.

**Risk — the boundary blurs.** Decision logic creeps into the graph, or graph
traversal into `decision-engine`. Mitigation: `decision-engine` depends on
`value-graph` and `scenario-engine` through their public interfaces only; the
reverse dependency is a build error under `verify:package-boundaries`.

**Risk — reshaping `helm_decision_alternatives` breaks the working UI.**
Mitigation: the override representation is added alongside `financial_lines`, both
supported during Phase 5, and the column is dropped only once the UI reads
computed values. All `helm_*` tables are currently empty, so there is no data
migration — a window that closes at the first real onboarding.

## Migration implications

- Phases 1–3 add tables; they change none of the existing decision tables.
- Phase 4 adds `scenario_id`-carrying overrides beside the existing JSON baseline;
  the old representation keeps working.
- Phase 5 adds `value_node_id` to signals and override support to alternatives,
  both additive.
- Phase 6 replaces `helm_approval_rules` with `helm_authority_rules`. The old table
  is empty, so this is a clean cut rather than a data migration.
- `implemented-mvp.md` remains the accurate record of the pre-Phase-0 build and is
  not rewritten as the model evolves; it is history.
