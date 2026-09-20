# ADR-0017: Calculation semantics — definitions in code, metadata in data, and how inputs are chosen

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 3

Four related decisions that together define what a HELM calculation *is*. They
are one ADR because changing any of them in isolation would break the others.

---

## 1. Executable logic in code, governance metadata in the database

### Problem

Where does a calculation live? §13 forbids `eval()` and storing executable
JavaScript in the database. §60 expects a hybrid. §63 wants calculations to be
owned, described and versioned business policy rather than "anonymous magic".

### Options

1. **Code only.** Simple, testable, fully typed. Calculations become invisible
   to anyone who cannot read TypeScript, and governance (owner, rationale,
   effective date) has nowhere to live.
2. **Database formula strings, interpreted at runtime.** Configurable without a
   deploy. Requires an expression evaluator — the thing §13 explicitly forbids —
   and makes every calculation a potential injection surface and a debugging
   nightmare.
3. **Hybrid: typed functions in code, registered under a versioned key;
   metadata rows in `helm_calculations`.**

### Decision

**Option 3.**

```ts
registerCalculation({
  key: 'expected_revenue',
  version: '1.0.0',
  outputMetric: 'ExpectedRevenue',
  inputs: [...],
  expression: 'opportunity_value × opportunity_probability',
  compute(ctx, inputs) { ... },   // pure, typed, unit-safe
});
```

`helm_calculations` stores key, version, status, output metric, declared inputs,
the human-readable expression, owner, rationale and effective date. It stores
**no executable code**.

The database row is the governance and audit record; the code is the
implementation. `verify:calculations` asserts they agree — a registered
calculation with no metadata row, or a metadata row with no implementation,
fails the build.

**Future externalization.** If configurable formulas are ever needed, the path
is a restricted, non-Turing-complete expression AST evaluated by an interpreter
HELM owns — *not* `eval`, and not before a real requirement exists.

---

## 2. Observation selection is policy, not "latest wins"

### Problem

A value node can carry an actual, a forecast, a target, an estimate, an
assumption and several scenario values simultaneously (Phase 2's whole point).
When a calculation asks for `OpportunityProbability`, which one does it get?
§5 is explicit that silently taking the latest is wrong.

### Decision

**A named, declared preference policy**, resolved per input, never a single
hard-coded global order.

```ts
type ObservationPreference =
  | 'BASELINE'       // DERIVED → FORECAST → ACTUAL → ESTIMATE → ASSUMPTION
  | 'ACTUALS_FIRST'  // ACTUAL → DERIVED → FORECAST → ESTIMATE → ASSUMPTION
  | 'SCENARIO'       // SCENARIO → DERIVED → FORECAST → ACTUAL → ESTIMATE → ASSUMPTION
  | 'ASSUMPTION_ONLY';
```

**`DERIVED` outranks `FORECAST` in `BASELINE`, and this is the load-bearing
choice in the whole policy.** It was originally the other way round, and the
canonical chain proved it wrong: with `FORECAST` first, changing the opportunity
probability recalculated expected revenue and then demand read the *stated*
forecast instead, so nothing downstream of the change moved. The model computed
and propagated nothing — an expensive way to be an ontology with formulas
attached.

The principle behind the ordering: **if HELM can compute a number, the computed
one is the baseline, because it is the only one that can be explained.** A stated
forecast is what HELM falls back on for what it cannot compute. `ACTUALS_FIRST`
deliberately keeps the opposite priority for measured facts — a model that
overrode what actually happened would be worse than useless.

- The **context** sets the default policy for a run.
- An **input may override** it. `AverageSellingPrice` declares
  `ASSUMPTION_ONLY`, because a management assumption is the only legitimate
  source for it and silently falling back to a measured actual would
  misrepresent where the number came from.
- `TARGET` is **never** selected as an input. A target is what we want, not what
  we believe; feeding targets into a forecast would make the model tell us what
  we hoped for. Targets are comparison material, not inputs.
- `DERIVED` observations are selected only when the input is explicitly a
  derived metric in the same run — which is the normal case for chained
  calculations.

### Within a tier: eligibility, then order, then ambiguity

The two kinds of time have to be used for two different questions, and
collapsing them is how this goes wrong.

1. **Eligibility — was the claim KNOWN at `asOf`?** Judged on *record* time
   (`observedAt`, falling back to `recordedAt`). A Q4 forecast made on 18
   September is eligible on 19 September. Judging eligibility on valid time
   instead — the first implementation's mistake — excludes every forecast about
   the future from every calculation run in the present, which makes forecasting
   impossible. A point-in-time claim is additionally ineligible if its
   `effectiveAt` is after `asOf`: a fact that only becomes true later cannot
   describe now. Period claims are exempt, because being about a period is the
   whole point of one.
2. **Order — which claim speaks to the LATEST moment?** Valid time descending
   (`effectiveAt`, else `periodStart`).
3. **Tie-break — which belief is CURRENT?** Record time descending. This is not
   cosmetic: a recalculated derived value has the same valid time as the one it
   supersedes, and the only thing distinguishing them is that HELM learned it
   later. That is exactly what record time is for, so choosing the later record
   is a rule, not an arbitrary pick.
4. **Genuine ambiguity** — identical in valid time *and* record time — is an
   error (`AMBIGUOUS_INPUT`). Nothing distinguishes the claims, so choosing
   would make the result unexplainable.

*Known limitation.* Two forecasts for different future periods on one node would
be separated by step 2 and the further-out one would win. Today the node's
`timeHorizon` and each input's declared `horizon` keep periods apart, so the
situation does not arise in the canonical model; genuine multi-period forecasting
on a single node is not modelled and should not be added without revisiting this
rule.

The chosen observation's id is recorded in the trace, so "which number did it
use?" is always answerable.

### A run consumes its own derived output

```
source world (actual / forecast / assumption)
  -> calculation run
    -> same-run derived output
      -> downstream calculations
```

When a downstream step needs a value the same run has already produced, it takes
**that** observation — not whichever observation of the same kind happens to be
newest on the node.

The first implementation re-queried the node every time, and it appeared to work
because a run's own write always has the latest record time. It is accidental.
Two runs in flight — a scheduled recalculation overlapping a manual one — and a
step consumes the other run's output. The numbers can even come out identical
and the defect still matters: the trace then cites an observation its run did not
produce, so the run's internal consistency cannot be demonstrated at all, which
is the one thing a trace exists to do.

The rule applies only within the tier the preference would have chosen anyway.
An `ACTUALS_FIRST` input still prefers a measurement over the run's own model
output; otherwise the rule would quietly convert every such input into a model
read.

An `UNCHANGED` step contributes to this map too. It wrote no new observation,
but it confirmed the existing one as this run's answer for that node, and
downstream steps must read that rather than searching again.

*What this does NOT provide.* Snapshot isolation over the source world. Two runs
declaring the same `asOf` can still read different facts if one of them is
recorded between their reads — both answers are correct as of that `asOf`, but
which one a given run sees depends on timing. `asOf` bounds what is eligible and
replay re-reads at the same `asOf`, which is the mitigation; genuine snapshot
isolation is a transactional concern and is not attempted here.

### What `asOf` is, and what it is not

`asOf` is the **lens** that selects inputs. It is recorded on the run, and it is
deliberately **not** part of a step's `inputFingerprint`, which covers the
calculation reference, the horizon, the scenario and the exact input
observations and values. If the same observations with the same values were used,
the computation was the same — so a freshness check an hour later must not report
a value as stale merely because the clock moved. Including `asOf` did exactly
that, and made every derived value in HELM permanently stale.

A freshness check therefore re-resolves inputs under the **same context the
value was calculated in** — the horizon, preference and scenario recorded on the
original run — and only the caller's `asOf` moves. Re-resolving a baseline number
under a scenario preference would report it stale because the question changed,
not because a fact did.

### Which time context an output is written with

The **metric**, not the node, decides. A metric's `timeBehavior` says whether it
is a stock (`effectiveAt`) or a flow (`periodStart`/`periodEnd`); the node's
`timeHorizon` only decides how long a flow's period is. Working capital is a
balance even when it is the balance implied by a quarter's demand. Deriving this
from the horizon instead writes a period onto a stock, and the value graph
correctly refuses it.

---

## 3. Confidence: conservative, deterministic, replaceable

### Problem

§19 asks for a simple explicit policy and warns against pseudo-scientific
confidence maths. §46 warns that calculation confidence must not be confused
with opportunity probability — they are different concepts that both happen to
live in 0..1.

### Decision

```
output confidence = min(input confidences) × definition confidence
```

- `min`, not a product of all inputs: a chain of five 0.9-confidence inputs is
  not 0.59-confident, it is limited by its weakest input. Multiplying would
  drive long chains to implausibly low numbers and make confidence useless.
- Multiplied by the **definition's own confidence**, which expresses how well
  the *model* represents reality. `inventory_requirement@1.0.0` is
  `DemandQuantity` with no stock policy at all, so it declares 0.8 — the
  arithmetic is exact, the model is crude, and the output should say so.
- An input with no confidence is treated as `1.0` (a stated fact we have no
  reason to doubt), not as `0`.

**Confidence is a distinct branded type** (`Confidence`) from any business
ratio. `OpportunityProbability` is a `ratio` *metric value*; confidence is
metadata *about* a value. The type system keeps them apart, per §46.

This policy is deliberately replaceable: it lives in one function,
`combineConfidence`, and the trace records the inputs it used, so a future
phase can substitute a better policy and re-derive historical confidence.

---

## 4. Scenario outputs stay out of reality

### Problem

§33–34: propagation under a scenario must not mutate or masquerade as baseline
truth.

### Decision

A calculation run carries an optional `scenarioEntityId`.

- **Baseline run** (no scenario) writes `DERIVED` observations with
  `scenarioEntityId = null`.
- **Scenario run** writes `SCENARIO` observations carrying that scenario's id,
  plus metadata `{ derivedByCalculation: key@version, calculationRunId }`.

Phase 2's constraint already enforces the separation at the database: a
`SCENARIO` observation must carry a scenario, and nothing else may. Phase 3
adds nothing to blur it — a scenario-derived number is a scenario number that
happens to have been computed, and the `derivedByCalculation` metadata records
that without changing its kind.

The alternative — a `DERIVED` observation with a scenario id — was rejected
because it would require relaxing the Phase 2 constraint that keeps reality
separable, in exchange for nothing.

---

## Consequences

**Good.** Calculations are typed, testable and versioned, with a governance
record that a non-engineer can read. Input selection is explainable and
auditable rather than incidental. Confidence is honest about model quality, not
just data quality. Scenario and baseline results cannot be confused.

**Bad.** A calculation requires two artefacts (code + metadata row) that must be
kept in step — enforced by `verify:calculations`, but still two things. The
preference policy is more machinery than "latest wins", and callers must
understand it.

**Risk — preference policies proliferate.** Four is enough; a fifth needs a
reason. `verify:calculations` fails on an unknown policy name.

**Risk — definition confidence becomes decoration.** If every calculation
declares 1.0, the field means nothing. The canonical model deliberately declares
below 1.0 where the model is crude, and the phase documentation explains each.

## Migration implications

- Phase 3 creates `helm_calculations`, `helm_calculation_runs` and
  `helm_calculation_steps`.
- `helm_value_observations.calculation_run_id` had a Phase 2 CHECK forbidding
  any value. It is **widened** (guarded drop + re-add, per `verify:schema`) to
  allow a run id only on `DERIVED` and `SCENARIO` observations.
- No existing calculation semantics change, because none existed.
