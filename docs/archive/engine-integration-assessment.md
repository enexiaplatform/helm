# Existing engines and the propagation engine — an assessment

> **Archive.** This describes the pre-kernel application, which has been retired: the engines, pages and tables it discusses were replaced by the layers in [the architecture](../architecture/helm-architecture.md). It is kept as history and is not a description of HELM today.

The Phase 3 brief asks (§37) whether the deterministic engines built before the
kernel should be integrated with the propagation engine, and says explicitly:
evaluate each one, do not mechanically wrap them all.

This is that evaluation. The conclusion, stated first: **two of the eight are
worth converting to calculations, three are not calculations at all, and three
should be converted later, for reasons that are about Phase 4 and Phase 7 rather
than about Phase 3.** Nothing is wrapped in this phase.

---

## The test applied to each

A deterministic engine belongs in the propagation engine when all four hold:

1. **It produces a value, not a judgement.** A number a manager would put in a
   plan, not a classification, a flag or a state transition.
2. **Its inputs are value observations** that live, or could live, on value
   nodes — rather than arbitrary object graphs assembled in the UI.
3. **Its output is a metric** that something else might depend on. An engine
   whose output nothing consumes gains nothing from being in a dependency graph.
4. **It is worth tracing.** The audit trail, the versioning and the confidence
   have to earn their cost. A formula nobody will ever be asked to justify does
   not need a trace.

An engine that fails (1) is not a calculation and never will be. An engine that
passes (1) but fails (2) is a calculation whose inputs are not yet modelled —
which is a Phase 4 or Phase 7 problem, not a reason to force it now.

---

## Engine by engine

### `cvp.ts` — Cost-Volume-Profit · **CONVERT (Phase 4)**

Produces contribution margin, break-even volume, margin of safety and operating
leverage from price, variable cost, fixed cost and volume. Every input is a
metric HELM already models or plausibly could; every output is a number a
manager plans against.

It fails test (2) today for one specific reason: **fixed costs have no value
node.** `Opex` exists, but the canonical graph attaches it to a cost object, not
to a business unit's fixed-cost base, and break-even is meaningless without
that. Converting CVP requires modelling the fixed-cost base first.

It is also the engine with the strongest case for conversion, because
break-even is exactly the kind of number that moves when something upstream
moves, and today it does not move at all — it is recomputed in the UI from
whatever the page happens to hold.

**Blocked on:** a `FixedCostBase` metric and the value nodes to carry it.

### `inventory.ts` — safety stock, reorder point, EOQ · **CONVERT (Phase 4)**

`analyzeInventoryItem` produces safety stock, reorder point, days of inventory,
stock-out risk, expiry exposure and EOQ. The first two are genuine calculations
in the Phase 3 sense and would improve `inventory_requirement@1.0.0` immediately:
the v1 requirement equals demand with no safety stock at all, and its 0.8
definition confidence says so.

Two obstacles, both real:

* **`inverseNormalCdf` is an approximation.** Converting it means either
  declaring a definition confidence that reflects the approximation, or moving
  to exact arithmetic it cannot support. Rational-approximation coefficients
  are irreducibly floating-point; `Decimal` cannot represent them. The honest
  path is a documented `RATE`-style metric whose confidence states the
  approximation, not a pretence of exactness.
* **Demand standard deviation is not modelled.** There is no
  `DemandVariability` metric, and safety stock without it is arithmetic on a
  number nobody has.

`analyzeWorkingCapital` (DOI + DSO − DPO = CCC) is a clean calculation and could
convert with no obstacle at all — but it needs DSO and DPO metrics, which the
value graph does not yet carry.

**Blocked on:** `DemandVariability`, `DaysSalesOutstanding`, `DaysPayableOutstanding`.

### `economics.ts` — margin ladder and variances · **CONVERT LATER (Phase 7)**

`buildMarginLadder` walks revenue → gross margin → contribution → operating
margin for a cost object. Structurally this is four chained calculations and the
Meridian model already implements two of them.

The reason not to convert now is **§38's projection question**: the ladder reads
`helm_cost_objects`, which is a Memoire-era table that was never projected into
the ontology. Converting the engine without projecting the table would create a
second, parallel way for a margin to exist in HELM — the exact duplication
ADR-0007 exists to prevent.

`buildVariances` is a comparison, not a calculation: it subtracts actual from
budget. It belongs to whatever surface shows variance, not to the dependency
graph.

**Blocked on:** projecting `helm_cost_objects` (see below).

### `relevantCost.ts` — relevant costing and the allocation trap · **DO NOT CONVERT**

This engine decides which costs are *relevant to a decision*: it excludes sunk
and allocated costs, and detects the allocation trap where a segment shows a
negative reported net but a positive segment margin.

It fails test (1). Relevance is **a property of a decision, not of a value**.
The same cost is relevant to one alternative and irrelevant to another, and
nothing about the cost itself changes. Putting it in the dependency graph would
require a calculation whose output depends on which question is being asked,
which is not what a calculation is.

This belongs to Phase 5 (Decision Intelligence), where a decision has a scope
and relevance can be a property of that scope.

### `scenario.ts` — scenario evaluation and sensitivity · **DO NOT CONVERT (superseded)**

`evaluateScenario` applies percentage and absolute deltas to a baseline and
re-runs CVP. The propagation engine already does the general form of this,
properly: a SCENARIO run reads SCENARIO observations, writes SCENARIO outputs,
and cannot leak into reality (ADR-0017 §4).

This engine should be **replaced** in Phase 4, not wrapped. `sensitivity()` —
which ranks drivers by profit swing — is scenario *comparison*, which Phase 3's
boundary verifier explicitly forbids here and Phase 4 owns.

### `signals.ts` — signal detection · **DO NOT CONVERT**

Fails test (1) decisively. A signal is a **judgement about whether a value
deserves attention**, evaluated against thresholds that are management policy.
`detectSignals` produces severity levels and evidence, not quantities.

It will *consume* propagated values — a stock-out signal should fire on a
derived inventory gap rather than a stated one — but that is a dependency in the
other direction, and it belongs in Phase 8 (Signals) where thresholds become
governed policy.

There is a real integration here and Phase 3 is not where it happens.

### `capacity.ts` — process and bottleneck analysis · **CONVERT LATER (Phase 7)**

`analyzeProcess` computes cycle time, value-added ratio and the bottleneck
activity. Cycle time and utilisation are genuine metrics —
`CapacityUtilization` already exists in the value graph.

Blocked by §38 again: it reads `helm_processes`, which is not projected into the
ontology. Bottleneck *identification* is a `MAX` over activities, which is an
aggregation the value graph models but the propagation engine does not implement
(v1 aggregates by SUM only).

**Blocked on:** projecting `helm_processes`, plus non-SUM aggregation.

### `decisionMemory.ts` — outcome patterns · **DO NOT CONVERT**

Fails tests (1) and (3). `detectPatterns` finds behavioural patterns across
closed decisions — systematic under-delivery, recurring forecast lessons. It
produces observations about *how the organization decides*, not values in the
enterprise value model.

Phase 10 (Institutional Memory) owns this.

---

## Summary

| Engine | Verdict | Blocked on |
| --- | --- | --- |
| `cvp.ts` | Convert in Phase 4 | a fixed-cost-base metric |
| `inventory.ts` | Convert in Phase 4 | demand variability, DSO/DPO metrics |
| `economics.ts` | Convert in Phase 7 | projecting `helm_cost_objects` |
| `capacity.ts` | Convert in Phase 7 | projecting `helm_processes`, non-SUM aggregation |
| `relevantCost.ts` | Never — belongs to Phase 5 | relevance is a decision property |
| `scenario.ts` | Replace in Phase 4 | superseded by scenario runs |
| `signals.ts` | Never — belongs to Phase 8 | consumes values, does not produce them |
| `decisionMemory.ts` | Never — belongs to Phase 10 | not about enterprise value |

**Nothing was converted in Phase 3, and nothing was wrapped.** Every engine
still runs exactly as it did, against exactly the same tests. The propagation
engine sits beside them rather than over them.

The reason for the restraint is worth stating plainly: wrapping all eight would
have produced a larger-looking Phase 3 and a worse system. Four of them are not
calculations, and the other four need value metrics or entity projections that
do not exist yet. A wrapper that papered over that would have made the
dependency graph a lie — full of calculations that could not actually run.

---

## §38 — the un-projected tables

Three Memoire-era HELM tables hold data the value model would benefit from and
are **not** projected into the ontology:

| Table | What it holds | Why it matters | Projection cost |
| --- | --- | --- | --- |
| `helm_cost_objects` | products, segments, channels with revenue and cost structure | the margin ladder's subject | Low — `CostObject` maps to existing `Product` / `Segment` / `Channel` entity types; the work is an identity-resolution decision, not a new type |
| `helm_inventory_items` | SKU-level stock, lead time, demand statistics | richer than the canonical `Inventory` entity, and the source of demand variability | Low — `Inventory` already exists; this is an attribute-level merge |
| `helm_processes` | process activities, cycle times, capacity | the capacity engine's subject | Medium — needs a `Process` entity type and an `Activity` sub-entity the ontology does not have |

**Recommendation: project `helm_inventory_items` first**, in Phase 4. It is the
cheapest of the three, it unblocks safety stock, and it would let
`inventory_requirement` move from v1 (demand exactly, confidence 0.8) to a
version with a real stock policy — which is the single largest accuracy gain
available to the Meridian model.

`helm_cost_objects` should follow in Phase 7 alongside the margin ladder, and
`helm_processes` after that. None of this is Phase 3 work, and doing any of it
here would have widened the phase without deepening it.
