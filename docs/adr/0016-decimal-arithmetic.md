# ADR-0016: BigInt fixed-point decimals for all value arithmetic

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 3

## Context

Phase 3 computes money. JavaScript numbers are IEEE-754 binary floats, and
HELM's own canonical model hits the problem directly:

```js
0.7 * 12              // 8.399999999999999   ← expected demand, in units
0.1 + 0.2             // 0.30000000000000004
(0.1 + 0.2) + 0.3     // 0.6000000000000001
0.1 + (0.2 + 0.3)     // 0.6                 ← not associative
```

The first line is the canonical demand calculation: a committed quantity of 12
units at 70% probability is 8.4 expected units, and float says
`8.399999999999999`.

Worth being precise about the scale of the problem, because it is easy to
overstate: many large-magnitude products *are* exact in float —
`4_200_000_000 * 0.7` really does give exactly `2_940_000_000`. Binary floating
point is not randomly wrong; it is wrong in specific, hard-to-predict places.

That unpredictability is the actual argument. Two things follow from it:

1. **We cannot know in advance which numbers will be wrong.** A model that is
   exact today becomes inexact when an assumption changes from 0.38 to 0.375.
2. **Float error is path-dependent** — addition is not associative, so the same
   value reached by two routes can differ in the last bits. That breaks the
   reproducibility and replay equality Phase 3 exists to provide (§15, §59),
   and it breaks them silently.

## Problem

What numeric representation do value calculations use?

## Options considered

1. **JavaScript `number`.** Zero work. Non-deterministic in the last digits,
   breaks replay equality, and produces absurd display values. Unacceptable for
   the one thing this phase must get right.
2. **Integer minor units.** Store amounts as integers of the smallest currency
   unit. Exact for money, and it collapses on the operations HELM actually
   needs: probability is 0.7, a ratio is 0.63, a gap is 4.4 units. Minor units
   solve currency and leave every other unit type unsolved.
3. **decimal.js / big.js.** Mature, exact, well-tested, MIT, no transitive
   dependencies. Costs a runtime dependency inside a kernel package, and brings
   a large API surface (trig, logs, 9 rounding modes) for the six operations
   HELM performs.
4. **A small BigInt fixed-point decimal in `@helm/shared`.** Exact, dependency
   free, fully auditable in-repo, and scoped to exactly the operations the
   value model uses.

## Decision

**Option 4.** `@helm/shared/decimal.ts`: a value stored as a `bigint` of
`value × 10^12`, with a fixed internal scale of **12 decimal places**.

```
add, subtract, multiply, divide, negate, abs, min, max, compare,
isZero, isNegative, round(dp, mode), toString, toNumber(display only)
```

Rounding is **half-up**, applied only where the operation requires it
(`multiply`, `divide`, explicit `round`). Half-up is the convention a finance
reader expects; half-even is available as a mode but is not the default,
because an unexplained rounding rule is worse than a slightly biased one.

### Why 12 places

Business quantities need far fewer, but intermediate ratios need headroom: a
gross-margin percentage derived from a division, then multiplied by 100, then
compared for equality, must not drift. Twelve places sits comfortably inside
`bigint` for values up to ~10^{27}, which covers VND amounts by a wide margin.

### Why not a library, honestly

The operation set here is six functions and exhaustively testable — the tests
cover the classic float traps, associativity, division rounding, and the exact
values in the canonical model. That is a small, well-bounded thing to own. A
library would be a reasonable choice too; the deciding factor is that a kernel
dependency has to be justified by something the kernel cannot do itself, and
this one can.

**The trigger to switch:** if a later phase needs `pow`, `sqrt`, `exp` or `log`
— Monte Carlo (Phase 3+ is explicitly forbidden from it, but Phase 11 is not),
or a discounting model — swap the internals of `decimal.ts` for decimal.js
rather than growing a hand-rolled implementation into a maths library. The
module boundary makes that a contained change.

### Precision policy (§45)

| Stage | Precision |
| --- | --- |
| Internal calculation | 12 decimal places, exact |
| Storage | Postgres `numeric` — exact, no coercion to float |
| Display | rounded at the UI boundary only, per unit type |

Individual formulas **never** invent their own rounding. A calculation that
genuinely needs a rounded intermediate (a commercial quantity that must be a
whole number) declares it as an explicit business rule with a named assumption,
not as a silent `Math.round`.

### Units travel with values

`Decimal` alone would still permit `4.2B VND + 4 units`. So arithmetic in the
value model goes through `Quantity` (`@helm/shared/quantity.ts`), which carries
`{ amount: Decimal, unitType, currency }` and exposes dimensionally-named
operations:

```
sum / difference    same unit, same currency          → same unit
scaleByRatio        quantity × ratio                  → same unit
ratioOf             same-unit ÷ same-unit             → ratio
unitsPurchasable    currency ÷ currency-per-unit      → units
percentageOf        same-unit ÷ same-unit             → percentage
```

This is **unit checking, not unit algebra**. HELM does not derive that
`currency ÷ (currency/unit) = unit`; it provides a named operation whose
signature says so, and validates the inputs. That is the §16 instruction —
"enough unit semantics for canonical business calculations" — taken literally.

## Consequences

**Good.** Exact, reproducible arithmetic with no dependency. Replay equality is
byte-exact. Illegal dimensional operations are unrepresentable rather than
merely discouraged. The implementation is auditable by the people who care most
about the numbers.

**Bad.** Code HELM owns and must maintain. `bigint` is slower than `number` —
irrelevant at management cadence, and measured in Phase 3's performance notes.
`toNumber()` exists for display and is a lossy exit that must not be used inside
calculations; `verify:calculations` asserts that.

**Risk — a subtle rounding bug.** The classic failure mode of hand-rolled
decimals. Mitigation: exhaustive unit tests including negative division,
half-way cases in both signs, and the exact canonical-model values; plus the
swap trigger above if the operation set grows.

## Migration implications

- `@helm/shared` gains `decimal.ts` and `quantity.ts`. No dependency added.
- Value observations continue to store `numeric` in Postgres; the adapter
  converts through the decimal string representation, never through `Number`.
- Phase 2's in-memory adapter stores JS numbers on `ValueObservation.numericValue`
  for compatibility; the propagation engine converts at its boundary and keeps
  full precision in the trace. Unifying the observation representation on
  `Decimal` is recorded as debt.
