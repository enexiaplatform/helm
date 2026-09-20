# Value links and calculation dependencies are not the same thing

HELM has two graphs that both describe how value connects, and conflating them
would quietly destroy the more valuable one. This note states the difference,
why both exist, and what it costs to keep them separate.

```
Value Graph        SEMANTIC dependency     "Inventory CONSUMES Working Capital"
Calculation Graph  EXECUTABLE dependency   "WorkingCapital = InventoryRequirement × UnitCost"
```

---

## They overlap. They are not the same.

Four relationships can hold between the two graphs, and all four occur in the
canonical Meridian model.

### 1. A value link WITH a calculation behind it

`ExpectedRevenue --DRIVES--> DemandQuantity` is both a semantic claim and an
executable one: revenue does drive demand, and `demand_quantity@1.0.0` computes
it. This is the easy case and the one people assume is the only case.

### 2. A value link with NO calculation — a real dependency HELM cannot compute

`InventoryGap --REDUCES--> ServiceLevel` is true. A shortfall does damage
service. HELM has no formula for it, because the relationship between a units
shortfall and a service percentage depends on allocation policy, customer
priority and substitution — none of which is modelled.

**This is the most important case, and the reason the two graphs must stay
separate.** If the value graph were reduced to the calculation graph, this edge
would have to be either deleted or faked. Deleting it would erase a dependency
the business genuinely has. Faking it would produce a service level HELM
invented. Keeping it as a link with no calculation is the only honest option: a
manager can see that service depends on the gap and that HELM does not claim to
quantify it.

`verify:calculation-graph` asserts this case still exists. If every value link
ever gained a calculation, the check fails — because that would mean the
semantic model had been quietly narrowed to whatever the engine could compute.

### 3. A calculation that spans nodes no single link connects

`cash_impact` reads `GrossMargin` on the opportunity and `WorkingCapital` on the
product it sells. No single value link joins those two nodes; the calculation
reaches across via the ontology's `SELLS` relationship.

This is deliberate and has a consequence worth stating: **this deal carries the
capital cost of stock the other tender also needs.** The calculation graph makes
that visible precisely because it is not constrained to follow value links.

### 4. A calculation the model declares it will NOT run

`gross_margin` has `scopeCompatibility: ['commercial', 'market']`. The
EnterpriseValue entity carries a `GrossMargin` value node, and the calculation
refuses to produce it, reporting:

> `gross_margin@1.0.0 does not apply to a value subject (allowed: commercial, market)`

An enterprise margin is a consolidation across deals, and v1 has no
consolidation model. Running the deal-level formula on an enterprise subject
would produce a number that looks like a consolidation and is not one.

Declaring it **uncomputable** is different from blocking on it. A blocked step
means the model tried and could not; an uncomputable declaration means the model
does not claim to. A reader has to be able to tell "not applicable" from
"forgotten", so `PropagationResult.uncomputable` carries these with their
reasons rather than leaving a silent absence.

---

## Why not just one graph?

The obvious simplification is to make value links executable — put a formula on
the edge. It fails for three reasons.

**Arity.** `gross_margin` has three inputs. A link has one source and one target.
Modelling a three-input calculation as three links loses the fact that they
combine in one formula, and there is nowhere to put the formula.

**Direction of truth.** A value link is a claim about the enterprise: it is true
whether or not HELM can compute anything. A calculation is a claim about HELM: it
describes what this system can currently derive. The first should change when
the business changes; the second should change when the model improves. Storing
them together means every model improvement looks like a change to the business.

**Cardinality.** A metric can have one semantic role and several calculations
over time — `inventory_requirement@1.0.0` today, `@2.0.0` when safety stock
arrives. The link `DemandQuantity --DRIVES--> InventoryRequirement` does not
change when the formula does. Versioning the formula on the edge would version
the business claim along with it.

---

## What this costs

Two graphs mean two things to keep coherent, and the cost is real:

* A calculation can reference a metric pair with no value link between them, and
  nothing currently flags it. The semantic model can silently fall behind the
  executable one.
* A value link can be created with no calculation and no intention of ever
  having one, and nothing distinguishes "not modelled yet" from "never will be".

Neither is enforced today. Both are candidates for a future verifier, and the
second probably wants a field on the link rather than a check — a link that says
"deliberately unquantified" is more useful than one a reader has to guess about.

The cost is accepted because the alternative — one graph that is whatever the
engine can compute — would make HELM's model of the enterprise exactly as
sophisticated as its arithmetic, which is the failure mode this architecture
exists to avoid.
