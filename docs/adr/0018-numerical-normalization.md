# ADR-0018: Numerical normalization — internal precision, storage precision, display precision

**Status** accepted · **Date** 2026-09-21 · **Deciders** Architecture ·
**Phase** 3 hardening · **Refines** [ADR-0016](0016-decimal-arithmetic.md)

## Context

ADR-0016 put HELM's arithmetic on BigInt fixed-point decimal at scale 12, and the
Phase 3 report then presented this working-capital figure as exact:

```
2 687 699 999.999938 VND
```

It was not. The exact answer is **2 687 700 000 VND, remainder zero**:

```
demand (Rohto)   2.94B / 350M  = 8.4       = 42/5
demand (tender)  1.395B / 350M             = 279/70   non-terminating
requirement      42/5 + 279/70 = 867/70
working capital  867/70 × 217 000 000      = 2 687 700 000 exactly
```

The error was intermediate rounding. `279/70` was truncated at the twelfth
decimal place (residue ~1e-12), then multiplied by a unit cost of 2.17 × 10⁸,
which amplified the residue to ~6.2 × 10⁻⁵ VND. The arithmetic was exact **at
scale 12**; the business answer was wrong. A fraction of a dong is not a quantity
any ledger can hold, so the stored number was false as a statement about money.

The audit also found:

| Boundary | Finding |
| --- | --- |
| intermediate division | **root cause** — scale 12 is too little headroom once a quotient is multiplied back up by a large magnitude |
| `percentageOf` | a hard-coded `100 × 10^12` constant silently encoded the scale; it would have produced 0 at any other scale |
| Decimal → JS number | `numericValue` on an observation is a JS number; it is exact only because normalization now makes every stored business value representable |
| Postgres | the column is `numeric`, so it preserves whatever it is sent; the exact decimal string is also kept in `metadata.exactValue` |
| aggregation | `sumAll` is exact; not a source of error |
| formatting | `formatQuantity` and `toString` print the exact decimal; not a source of error |

## Decision

**Three precisions, decided in one place** (`packages/shared/src/precision.ts`):

| | What it is | Where it is set |
| --- | --- | --- |
| **internal** | digits carried through intermediate arithmetic | `DECIMAL_SCALE = 28`, global |
| **storage** | digits the persisted business value keeps | per unit, and per currency for money |
| **display** | digits a reader is shown | per unit |

With a `roundingMode` per unit. A metric may override any of them through
`metadata.precision`.

| Unit | Storage | Display | Rounding | Why |
| --- | --- | --- | --- | --- |
| currency | the currency's minor unit (VND 0, USD 2, KWD 3) | same | half-even | a fraction of a dong does not exist; half-even avoids upward bias across many amounts |
| percentage | 4 | 2 | half-up | a basis point stays distinguishable; 33.24% is what a manager reads |
| ratio | 6 | 4 | half-up | 0..1 needs more digits than a percentage to carry the same information |
| units | 6 | 4 | half-up | **fractional on purpose** — expected demand is a statistical value |
| count | 0 | 0 | half-up | a count of things is whole |

**Raw and normalized are both kept.** The engine computes at internal precision
and normalizes exactly once, at the moment an observation is written:

- the **observation** holds the normalized business value;
- the **trace** step holds `outputValue` (normalized) and `outputValueRaw` (the
  computation, when normalization moved it);
- the **execution frame** holds the *raw* quantity, so a downstream step in the
  same run continues from the computation rather than from its rounded
  representation and normalization cannot compound down a chain.

## What normalization is NOT

**It is not a business rule.** Turning 2 687 699 999.9999999999999999999969 into
2 687 700 000 VND removes an artefact of decimal division that nobody owns.
Turning an expected demand of 8.4 units into a procurement order of 9 units is a
commercial decision, and it belongs in a calculation that declares itself as one
(`procurement_quantity = ceil(demand_quantity)`), with its own owner and
rationale. The precision policy must never do it, which is why `units` keeps six
decimals.

No formula contains local rounding. `verify:calculations` fails on any numeric
literal other than 0 or 1 in a `compute()` body, which also catches a stray
`Math.round`.

## Consequences

Before and after, for the canonical chain:

| Value | Before (scale 12, no normalization) | After |
| --- | --- | --- |
| Working capital | 2 687 699 999.999938 VND | **2 687 700 000 VND** (raw residue ~3 × 10⁻²¹) |
| Cash impact | −1 710 499 999.999938 VND | **−1 710 500 000 VND** |
| Gross margin % | 33.2380952381 | **33.2381** (displayed 33.24) |
| Inventory requirement | 12.385714285714 units | **12.385714 units** |
| Demand | 8.4 units | **8.4 units** — unchanged, still fractional |

Scale 28 is not free: BigInt operands are larger. At HELM's volumes this is
immaterial, and the alternative — carrying an error that normalization then hides
— is exactly what this ADR exists to rule out. The raw residue is now ~10⁻²¹, so
normalization is visibly formatting rather than concealment; at scale 12 the same
step would have been rounding away a 6 × 10⁻⁵ error that the arithmetic created.

A calculation's input fingerprint uses the **canonical** decimal of each value,
so `0.7`, `0.70` and `0.700` produce one fingerprint.

## Rejected alternatives

- **Round in the UI only.** Leaves a false number in the ledger and in every
  downstream calculation that reads it back.
- **Exact rational arithmetic throughout.** Correct, but denominators grow
  without bound through a long chain and every consumer would need to understand
  rationals. Scale-28 decimal is exact to far beyond any business precision.
- **Normalize at every step.** Compounds rounding down the chain. Normalization
  belongs at the storage boundary, once.
