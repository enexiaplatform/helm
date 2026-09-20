# Meridian Pharma Value Model v1

HELM's first executable management model. Nine calculations that turn the
Phase 2 value graph from a description of how value connects into something that
computes.

This document is written for a manager, not only for an engineer. It says what
each number means, who owns it, what it assumes, and — most importantly — what
it is **not**.

---

## The chain

```
OpportunityValue × OpportunityProbability      →  ExpectedRevenue
ExpectedRevenue  ÷ AverageSellingPrice         →  DemandQuantity
Σ DemandQuantity                               →  InventoryRequirement
InventoryRequirement − AvailableInventory      →  InventoryGap        (floored at 0)
InventoryRequirement × UnitCost                →  WorkingCapital
DemandQuantity      × UnitCost                 →  Cogs
ExpectedRevenue − Cogs − Opex                  →  GrossMargin
GrossMargin ÷ ExpectedRevenue × 100            →  GrossMarginPct
GrossMargin − WorkingCapital                   →  CashImpact
```

Six source facts feed it, and nothing computes them:
`OpportunityValue`, `OpportunityProbability`, `UnitCost`, `AverageSellingPrice`,
`AvailableInventory`, `Opex`.

## Worked, with the canonical numbers

Rohto Q4 tender: 4.2B VND at 70%. SKU-X: 350M VND assumed price, 217M VND unit
cost. A competing provincial tender: 3.1B VND at 45%. Company stock: 4 units.

| Step | Formula with real numbers | Result | Conf |
| --- | --- | --- | --- |
| Expected Revenue (Rohto) | 4 200 000 000 × 0.7 | **2 940 000 000 VND** | 0.70 |
| Expected Revenue (tender) | 3 100 000 000 × 0.45 | 1 395 000 000 VND | 0.45 |
| Demand (Rohto) | 2 940 000 000 ÷ 350 000 000 | **8.4 units** | 0.63 |
| Demand (tender) | 1 395 000 000 ÷ 350 000 000 | 3.985714285714 units | 0.41 |
| Inventory Requirement | Σ (8.4 + 3.985714285714) | **12.385714285714 units** | 0.32 |
| Inventory Gap | max(12.385714285714 − 4, 0) | **8.385714285714 units** | 0.29 |
| COGS | 8.4 × 217 000 000 | 1 822 800 000 VND | 0.60 |
| Gross Margin | 2 940 000 000 − 1 822 800 000 − 140 000 000 | **977 200 000 VND** | 0.54 |
| Gross Margin % | 977 200 000 ÷ 2 940 000 000 × 100 | 33.2380952381 % | 0.54 |
| Working Capital | 12.385714285714 × 217 000 000 | 2 687 699 999.999938 VND | 0.28 |
| Cash Impact | 977 200 000 − 2 687 699 999.999938 | **−1 710 499 999.999938 VND** | 0.19 |

Three of these are worth pausing on.

**8.4 units is not a shipment.** It is the expected value across outcomes:
70% of 12 units. Rounding it to 8 or 9 is a commercial commitment decision, and
the model deliberately does not make it.

**12.385714285714 is where the contention becomes a number.** Phase 2 could say
that two value streams claimed the same stock position. Phase 3 says the claim
is 12.39 units against 4 on hand — a shortfall of 8.39. That difference is the
whole point of the phase.

**Cash impact is negative, and that is not a bug.** Serving this demand earns
977M in margin and ties up 2.69B in stock. A v1 cash model that ignores payment
terms will say so bluntly. A manager reading −1.71B should ask about payment
terms, which is exactly the conversation the number is supposed to start.

---

## What each calculation assumes

Every calculation carries a `definitionConfidence` that describes **how well the
model represents reality**, not how uncertain the inputs are. The arithmetic is
exact in every case; these numbers are about the model.

| Calculation | Conf | The simplification it admits to |
| --- | --- | --- |
| `expected_revenue` | 1.00 | none — probability weighting is the standard treatment |
| `gross_margin_pct` | 1.00 | none — it is a ratio of two figures the model already has |
| `cogs` | 0.95 | assumes every expected unit is sold at the modelled cost |
| `inventory_gap` | 0.90 | excludes distributor stock; reallocation is a decision, not availability |
| `gross_margin` | 0.90 | deal-level; an enterprise margin is a consolidation, not this summed |
| `demand_quantity` | 0.90 | one price for all units; no mix, no discount ladder |
| `working_capital` | 0.85 | values at cost, ignores payment terms |
| `inventory_requirement` | 0.80 | **no safety stock, no service buffer, no lead-time cover** |
| `cash_impact` | 0.70 | **ignores payment terms, collection timing and tax** |

The two lowest are the two most important to read carefully. `inventory_requirement`
is demand with no stock policy at all — the arithmetic is trivially correct and
the model is crude, and the confidence says which. `cash_impact` is margin minus
capital, presented as a v1 cash model rather than dressed up as a cash-flow
statement, because a model that looks more sophisticated than it is would be
trusted more than it deserves.

Confidence degrades down the chain — 1.00 at revenue, 0.19 at cash — because it
is `min(input confidences) × definition confidence` at every step. By the time a
number has passed through four crude models it should not look certain.

---

## Business constants are not in the code

The average selling price of 350M VND per SKU-X unit is an **ASSUMPTION
observation on a value node**, owned and reviewable, not a literal in a
TypeScript file. `demand_quantity` declares `preference: ASSUMPTION_ONLY` for
it, which means the engine will refuse to substitute a measured actual if the
assumption is missing: an assumption presented as a measurement is the most
dangerous kind of number in a management system.

`verify:calculations` enforces this mechanically — it scans every `compute()`
body and fails on any numeric literal other than 0 or 1.

---

## What the model deliberately does NOT do

* **It does not roll up.** Working capital for SKU-X is not summed into the
  Vietnam inventory position; gross margin for one deal is not summed into the
  Pharma BU. Those value nodes exist, carry stated finance figures, and the
  calculations that would produce them are declared **uncomputable** rather than
  faked. Consolidation is not summation, and v1 has no consolidation model.
* **It does not optimize.** It quantifies a trade-off — 8.39 units short,
  −1.71B in cash — and stops. Resolving the trade-off is a manager's job.
* **It does not round.** `2 687 699 999.999938` is carried as it is. The residue
  of a recurring division is part of the number, and hiding it would be a
  small, silent lie of exactly the kind that compounds.
* **It does not compare scenarios.** It can compute one. Ranking them is Phase 4.

---

## Ownership

| Owner | Calculations |
| --- | --- |
| Country GM Vietnam | `expected_revenue`, `demand_quantity`, `inventory_requirement`, `inventory_gap` |
| Finance Director Vietnam | `working_capital`, `cogs`, `gross_margin`, `gross_margin_pct`, `cash_impact` |

Every calculation names an owner and a rationale in `helm_calculations`, and the
registry refuses a definition that has neither. A management calculation nobody
can justify is not a calculation; it is anonymous magic.

---

## Versioning

Every calculation is `key@1.0.0`. A **meaning change is a new version, never an
edit**: a trace from last quarter must still resolve the formula that actually
produced its numbers. The database enforces at most one ACTIVE version per key,
and an older version stays resolvable so historical traces keep explaining
themselves.

When `inventory_requirement` gains a safety-stock policy it becomes
`inventory_requirement@2.0.0`, with a higher definition confidence, and every
number computed under 1.0.0 continues to say it was computed under 1.0.0.
