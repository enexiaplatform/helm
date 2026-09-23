# ADR-0020: Period identity — a period is a value, not "the furthest-out forecast"

**Status** accepted · **Date** 2026-09-22 · **Deciders** Architecture ·
**Phase** 4 · **Refines** [ADR-0017](0017-calculation-semantics.md),
[ADR-0014](0014-bitemporal-lite.md)

## Context

Phase 3 shipped a known defect. When a value node held several observations
whose validity intervals differed — a Q4 estimate and a Q1 estimate, say —
selection sorted by `validTo` and took the last one. The Phase 3 hardening
record called it what it was: **furthest-out forecast wins**.

It was not a rounding error. It was a category error. The engine had no way to
say *which* period a run was about, so it guessed, and its guess was "the one
that reaches furthest into the future". Every number downstream inherited the
guess silently. A quarterly gross margin could be computed from a Q4 revenue and
a Q1 cost, and nothing in the result said so.

Phase 4 needs the opposite property. A scenario that delays a delivery from
2026-Q4 to 2027-Q1 is *only* meaningful if "2026-Q4" and "2027-Q1" are things
the engine can tell apart. Comparison across futures needs the same: a
difference between two states is only a difference if both states are talking
about the same period.

## Decision

**A period is a first-class value**, defined in `@helm/shared`:

```ts
type Period = { start: ISOInstant; end: ISOInstant; grain: PeriodGrain };
```

1. **Half-open `[start, end)`.** 2026-Q4 ends at the instant 2027-Q1 begins.
   Adjacent periods neither overlap nor leave a gap, so "which period is this
   instant in" has exactly one answer.
2. **The grain is part of the identity.** `2026-10-01 → 2027-01-01` as a QUARTER
   and the same interval as a CUSTOM range are different periods, because they
   mean different things to a reader and aggregate differently.
3. **Calendar alignment is validated at construction.** A "QUARTER" that starts
   on 15 November is refused (`period.misaligned`) rather than stored. A period
   that lies about its grain is worse than no period at all.
4. **Selection matches the period exactly.** With a period requested, an
   observation is eligible only if its validity interval *is* that period
   (`intervalIs`), with a documented fallback to point-in-time claims — a unit
   cost stated at an instant applies to whatever period asks. No "closest",
   no "latest", no "furthest out".
5. **With no period requested, ambiguity is a refusal, not a guess.** If the
   node holds observations for more than one distinct interval and the caller
   did not say which period it means, selection returns `AMBIGUOUS_PERIOD` and
   names the intervals it found. Phase 3 behaviour is preserved exactly where
   there is nothing to be ambiguous about, which is why no Phase 3 test changed.
6. **A run records the period it executed.** `helm_calculation_runs` carries
   `period_start`, `period_end`, `period_grain`; derived observations are
   stamped with the same period, and replay restores it.
7. **The period enters the input fingerprint** — but only when one was stated,
   so Phase 3 fingerprints are unchanged and old runs still replay.

### Declared carry-forward

An input declared `horizon: 'current'` — a unit cost, a lead time, an
inventory position — is a *stock*, not a flow. It is read without a period
filter on purpose, and the code says so at the one line where it happens:

```ts
const inputPeriod = spec.horizon === 'current' ? null : period;
```

This is the only place a period is dropped, it is declared per input in the
calculation definition, and it is visible in the governance row a reader can
inspect. A stock silently borrowed across a period boundary is the failure mode
this makes impossible to do by accident.

## Consequences

**Good.** The Phase 3 defect is closed in the only way that does not create a
new one: by refusing rather than guessing. Multi-period scenarios are correct —
scenario D moves a delivery into 2027-Q1 and the two quarters compute
independently, which is exactly what §55 asks for. Comparison can state
"periods are never compared across one another" and mean it.

**Cost.** Callers that used to get a number now sometimes get a refusal. That
is the point, but it is a real migration burden for anything that relied on the
old behaviour. Within HELM nothing did: the scenario runtime always states its
period, and the Phase 3 canonical chain has one interval per node.

**Not done.** Period *arithmetic* — rolling a quarter up into a year, splitting
a year into months, allocating a flow across a boundary — is deliberately absent.
Multi-period runs execute one independent propagation per period. Revenue
recognition schedules, carry-over of unserved demand, and cumulative metrics
across periods all need that arithmetic and all remain out of scope
([phase-4-implemented](../architecture/phase-4-implemented.md), debt table).

## Alternatives considered

**Keep "furthest-out wins" and document it.** Rejected: it produces a number
that is wrong in a way no reader can see.

**Nearest-period matching.** A period "close enough" to the one requested gets
used. Rejected for the same reason — it is a guess wearing a heuristic's
clothes, and the failure is silent.

**A period column on the observation only, with no identity type.** Rejected:
the grain and the alignment rule are the part that makes two periods comparable,
and a pair of timestamps carries neither.
