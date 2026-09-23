# Integration Contract — Scenario Engine and Decision Engine

Phase 2 §22 and §23: define how the existing engines will meet the Value Graph,
without rewriting either of them and without coupling the Value Graph to the
current implementations.

**Nothing in this document is implemented in Phase 2.** It is the contract that
Phases 4 and 5 implement against, written now so the Value Graph's shape does
not accidentally foreclose it.

## 1. What already exists

| Engine | Where | State |
| --- | --- | --- |
| Scenario Engine | `src/domain/engines/scenario.ts`, `helm_scenarios` | Working: a P&L baseline plus variants, with deltas and a ±10% tornado. Self-contained; knows nothing about the value graph. |
| Decision Engine | `src/domain/decisionStates.ts`, `helm_decisions` + children | Working: full lifecycle, alternatives with typed financial lines, assumptions, append-only audit. |

Both are green and stay untouched.

## 2. The seam Phase 2 already built

The Value Graph does **not** reference `helm_scenarios`. A `SCENARIO`
observation references `scenario_entity_id` — an **ontology entity of type
`Scenario`**.

That indirection is the entire integration design. It means:

- the Value Graph depends on the ontology, not on the scenario engine;
- anything that can create a `Scenario` entity can contribute scenario values —
  the existing engine, a future one, or a decision option;
- replacing the scenario engine later changes an adapter, not the value model.

The canonical fixture demonstrates it with two scenario entities ("Option A —
Expedite import", "Option B — Reallocate distributor stock") carrying competing
gross-margin and service-level values.

## 3. Scenario Engine → Value Graph (Phase 4)

### 3.1 The adapter, not a migration

```
helm_scenarios row                    ontology Scenario entity
  id, name, baseline, variants   ──▶    canonical_key: helm:scenario:<id>
                                        source_system: 'helm'
                                        source_ref:    <helm_scenarios.id>
                                        attributes:    { kind: 'variant' }
```

One entity per scenario **variant**, because a variant is what a manager
compares — the baseline is reality, which is already the `scenario_id IS NULL`
view.

### 3.2 Variant results become SCENARIO observations

A variant's computed P&L lines map onto existing value metrics:

| Scenario result line | Value metric | Node subject |
| --- | --- | --- |
| revenue | `Revenue` | the scenario's cost object |
| contribution margin | `ContributionMargin` | same |
| profit | `GrossMargin` | same |
| break-even units | *(no metric yet)* | add in Phase 4 if needed |

Each becomes one `SCENARIO` observation with `source_system='helm'`, its own
confidence, and provenance `method='derived'` naming the scenario engine.

### 3.3 The rule that keeps them decoupled

> The scenario engine **pushes** observations into the Value Graph. The Value
> Graph never calls the scenario engine.

Dependency points one way. `@helm/value-graph` has no knowledge of
`helm_scenarios`, and `verify:architecture` would fail if it acquired any.

### 3.4 Deferred deliberately

Phase 2 does not ship this adapter. Writing it now would mean mapping the
current scenario engine's `ScenarioBaseline` / `ScenarioDeltas` shape into value
metrics *before* Phase 3 establishes what a derived value looks like — and
Phase 4 will very likely reshape variants into sparse graph overrides
([ADR-0011](../adr/0011-reconcile-decision-and-value-models.md) §3). Building the
adapter twice is worse than building it once, later.

## 4. Decision Engine → Value Graph (Phase 5)

> **What was actually built.** This section is the design as it stood before
> Phases 4 and 5. Two of its predictions did not survive the work, and are left
> here rather than quietly edited, because the reasoning is still useful:
>
> 1. **An alternative's consequences are not `SCENARIO` observations.** Phase 4
>    chose an input **overlay** resolved inside the propagation engine instead,
>    precisely so that no observation nobody made is ever written into the source
>    world ([ADR-0019](../adr/0019-scenario-runtime.md) §1). The observation type
>    `SCENARIO` still exists and is still the right place for a *stated*
>    scenario fact; a simulated one is not that.
> 2. **An alternative is not its own Scenario entity.** It **references** a
>    scenario, its revision and the run that computed its future
>    ([ADR-0021](../adr/0021-decision-runtime.md) §2). One scenario can therefore
>    be an alternative in more than one decision, and the decision layer stores
>    no economics at all.
>
> What did survive, and matters most: §4.2's point that a comparison must stop
> being an assertion and become a model, and every rule in §4.4.

### 4.1 A decision affects value nodes

Two links, both additive:

```
helm_decisions                      ontology Decision entity
  id, decision_type, status   ──▶     canonical_key: helm:decision:<id>
                                      source_ref:    <helm_decisions.id>

helm_decision_alternatives    ──▶   ontology Scenario entity (one per option)
                                      canonical_key: helm:scenario:alt-<id>
```

An option *is* a scenario: "what would happen if we chose this". So an
alternative's consequences are `SCENARIO` observations on the value nodes it
affects — exactly the shape Phase 2 already supports.

### 4.2 What this buys, and why it is the point

Today `helm_decision_alternatives.financial_lines` are **typed-in numbers**. A
manager asserts "expedited freight costs 140M" and the relevant-cost engine
compares the totals.

After Phase 5, an alternative declares *overrides* and its consequences are
observations on real value nodes. The comparison stops being an assertion and
becomes a model. That is the single most valuable connection in the whole
reconciliation, and it is why the Value Graph's observation types include
`SCENARIO` from the start rather than being retrofitted.

### 4.3 The `affects` surface

A decision's declared impact surface is already expressible: the ontology has an
`AFFECTS` relationship type, and value nodes reference entities. So

```
Decision --AFFECTS--> Product SKU-X
```

plus the value nodes on SKU-X gives "which quantities does this decision touch"
without any new schema.

### 4.4 What must NOT happen

- The Decision Engine must not be rewritten to store its state in the graph.
  Governance stays relational ([ADR-0011](../adr/0011-reconcile-decision-and-value-models.md)).
- `@helm/value-graph` must never import decision logic.
- A decision must not be able to write `ACTUAL` observations. A decision
  produces expectations and scenarios; only execution produces actuals.

## 5. Contract summary

| Direction | Allowed | Mechanism |
| --- | --- | --- |
| Scenario Engine → Value Graph | yes | push `SCENARIO` observations via a `Scenario` entity |
| Decision Engine → Value Graph | yes | `AFFECTS` relationships + `SCENARIO` observations per alternative |
| Value Graph → Scenario Engine | **no** | would invert the dependency |
| Value Graph → Decision Engine | **no** | same |
| Either engine writing `ACTUAL` | **no** | actuals come from source systems, not from plans |

## 6. Phase 2's obligation, discharged

Phase 2 was required to *not block* this integration. It discharges that by:

1. referencing scenarios through ontology entities rather than `helm_scenarios`;
2. modelling `SCENARIO` as a first-class observation type with its own
   constraint (a scenario value must name its scenario; nothing else may carry
   one);
3. keeping reality queryable separately (`scenarioEntityId: null`);
4. adding no dependency in either direction between `@helm/value-graph` and the
   existing engines — enforced by `verify:architecture`.
