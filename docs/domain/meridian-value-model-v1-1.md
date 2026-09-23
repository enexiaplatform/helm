# Meridian Pharma Value Model v1.1 — the four scenario calculations

**Phase 4** · Extends [Meridian Value Model v1](meridian-value-model-v1.md)

v1 could answer *"what is this opportunity worth and what does serving it tie
up?"* It could not answer *"if we win this order, can we actually ship it, and
what does committing the stock cost us elsewhere?"* — because nothing in the
model distinguished **expected demand** from **what must ship**, and nothing
represented an allocation.

v1.1 adds four calculations and changes none of the nine. The nine are restated
byte-identically in the governance migration; only the registry they belong to
is new.

---

## The four

```
OpportunityValue ÷ AverageSellingPrice                   →  OrderQuantity
min(AvailableInventory, InventoryRequirement)
      ÷ InventoryRequirement × 100                       →  DemandCoverage
max(OrderQuantity − AllocatedInventory, 0)               →  UnservedDemand
ExpectedRevenue × UnservedDemand ÷ OrderQuantity         →  RevenueAtRisk
```

One new source fact feeds them and nothing computes it: **`AllocatedInventory`**
— the units of own stock a management choice commits to one opportunity for a
period.

### `order_quantity` — units the business must deliver if it wins

`OpportunityValue ÷ AverageSellingPrice`, **not** probability-weighted.

This is the distinction v1 was missing. Expected demand for the Rohto tender is
**8.4 units**: the right number for planning revenue, and the wrong number for
asking whether the order can be fulfilled. A won order ships **12 units** or it
is late. Feasibility is a question about what must ship, not about what is
expected.

Valued at the same assumed selling price `demand_quantity` already uses, so the
two cannot disagree about what a unit is worth. v1.1 assumes the whole order
falls in the modelled period — see the debt note below.

*Owner: Country GM Vietnam · definition confidence 0.9*

### `demand_coverage` — the ability to serve, measured the only way v1.1 can

Own available stock against the period's requirement, capped at the requirement
because surplus stock does not serve more than all of the demand.

The metric is named `DemandCoverage`, not `ServiceLevel`, on purpose. It ignores
lead time, partial deliveries and the timing of demand within the period. It is
a **proxy** for the ability to serve, and calling it a service level would invite
a reader to compare it against an SLA it has no relationship to.

*Owner: Supply Chain Director Vietnam · definition confidence 0.7*

### `unserved_demand` — what a stated allocation leaves uncovered

`max(OrderQuantity − AllocatedInventory, 0)`.

**HELM never allocates.** This calculation reads the allocation a person or a
scenario stated and reports what that choice leaves uncovered. With no
allocation stated it does not assume one — it **BLOCKS**, because "nothing
allocated" and "not yet decided" are different facts, and a model that quietly
turns the second into the first has made a management decision on the reader's
behalf.

That is why the Meridian baseline shows Revenue at Risk as BLOCKED: no
allocation has been stated, and inventing a zero would have been a lie that
looks like data.

*Owner: Country GM Vietnam · definition confidence 0.9*

### `revenue_at_risk` — the exposure that allocation creates

`ExpectedRevenue × UnservedDemand ÷ OrderQuantity`.

If a third of an order cannot ship, a third of its expected revenue is exposed.
v1.1 treats that exposure **proportionally** and as **lost rather than
deferred**: it ignores late-delivery penalties, partial acceptance and
substitution, none of which HELM has a basis for. Probability is inherited from
`ExpectedRevenue` and never introduced here, so the risk figure cannot
accidentally be weighted twice.

*Owner: Finance Director Vietnam · definition confidence 0.6 — the lowest in the
model, because the model is crude, not because the arithmetic is uncertain.*

---

## What this makes visible

The shared-resource question, which v1 could describe but not compute. Four own
units, two opportunities:

| Commitment | Rohto unserved | Rohto at risk | Tender unserved | Tender at risk |
| --- | --- | --- | --- | --- |
| **P** all four to Rohto | 8 units | 1 960 000 000 VND | 8.857143 units | 1 395 000 000 VND |
| **T** all four to the tender | 12 units | 2 940 000 000 VND | 4.857143 units | 765 000 000 VND |

Neither row is better. That is the point: the same four units cannot serve both,
and HELM shows what each commitment forecloses without choosing between them.

## One metric revised

`WorkingCapital` moved from `LOWER_IS_BETTER` to `CONTEXT_DEPENDENT`
(metric version 2). Under a service objective, less working capital is not
better — it is the stock you did not have. The revision is recorded in the
metric's `metadata.revised`, so anything that read the old directionality can
see that it changed and when.

## Debt

| | |
| --- | --- |
| **Whole order in one period** | `order_quantity` assumes the full order falls in the modelled period. Splitting an order across periods needs the period arithmetic [ADR-0020](../adr/0020-period-identity.md) deliberately left out. |
| **Coverage is not service** | No lead time, no partial deliveries, no within-period timing. |
| **Risk is proportional and total** | No penalties, no partial acceptance, no substitution, no deferral. |
| **Allocation is stated, never derived** | By design, not by omission. Deriving it would be optimization, which Phase 4 does not do. |

## Versioning

Every v1.1 calculation is `key@1.0.0` — they are new keys, not new versions of
old ones, because none of them changes the meaning of anything v1 computed. The
nine v1 calculations keep their versions and their numbers.
