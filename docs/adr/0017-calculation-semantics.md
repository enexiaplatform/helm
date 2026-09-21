# ADR-0017: Calculation semantics — definitions in code, metadata in data, and how inputs are chosen

**Status** accepted, §2 revised · **Date** 2026-09-19, revised 2026-09-21 ·
**Deciders** Architecture · **Phase** 3

**Revision.** §2 originally ranked `DERIVED` above `FORECAST` in the baseline
policy. The Phase 3 hardening replaced that with three explicit truth layers, an
explicit per-input resolution, and a two-lens source snapshot. The original
reasoning and why it was wrong are kept in §2.

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

## 2. Three truth layers, and how an input is resolved

**Revised in the Phase 3 hardening (2026-09-21).** The first version of this
section made `DERIVED` outrank `FORECAST` in the baseline policy. That was the
wrong fix for a real problem, and the record of why is kept below rather than
deleted.

### Problem

A value node can carry an actual, a forecast, a target, an estimate, an
assumption, several scenario values and HELM's own derived output, all at once.
When a calculation asks for `Expected Revenue`, which one does it get? §5 is
explicit that silently taking the latest is wrong. And there is a second, sharper
question hiding inside the first: when HELM computes 4.70B and Finance has
forecast 5.00B, which one is the business number?

### What went wrong the first time

Phase 3 initially ranked `DERIVED` first in `BASELINE` so that chained
calculations would see each other's output — with `FORECAST` first, a probability
change recalculated revenue and then demand read the *stated* forecast, so nothing
downstream moved. Promoting `DERIVED` fixed the chaining and broke something more
important: every historical HELM calculation became more authoritative than the
forecast a person had actually committed to, merely because of its observation
type. Finance's 5.00B and HELM's 4.70B could not coexist, and the variance between
them could not be stated. A management system that silently prefers its own
arithmetic over what the business said is not a management system.

The chaining problem was real; ranking was the wrong tool. Chaining is an
**execution** concern and is now solved as one.

### Decision: three truth layers

```
BUSINESS / SOURCE TRUTH   ACTUAL, FORECAST, TARGET, ASSUMPTION
                          claims made by a business system or an authorized person

MODEL TRUTH               DERIVED
                          what a HELM model computed, under a named calculation
                          version and a recorded context — explainable output,
                          NOT automatically the authoritative business number

EXECUTION STATE           values bound to a run that is executing
                          runtime bindings that make one execution internally
                          consistent; never a persistent category
```

### Decision: observation policies read the persistent world

```ts
policyOrder = {
  SOURCE_TRUTH:    ['FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ACTUALS_FIRST:   ['ACTUAL', 'FORECAST', 'ESTIMATE', 'ASSUMPTION'],
  SCENARIO:        ['SCENARIO', 'FORECAST', 'ACTUAL', 'ESTIMATE', 'ASSUMPTION'],
  ASSUMPTION_ONLY: ['ASSUMPTION'],
  MODEL_OUTPUT:    ['DERIVED'],          // asked for by name, per input only
};
```

**No policy that answers "what does the business say?" can return `DERIVED`.**
`SOURCE_TRUTH` replaces the old `BASELINE` name so the policy says which layer it
reads. `MODEL_OUTPUT` exists for a caller that explicitly wants persisted model
truth, and cannot be a run's policy. `TARGET` is never selectable anywhere: a
target is what we want, not what we believe.

A run declares its policy; an input may override it (`AverageSellingPrice`
declares `ASSUMPTION_ONLY`, because falling back to a measured actual would
misrepresent where the number came from).

### Decision: every input declares how it resolves

```ts
type InputResolution = 'SOURCE_POLICY_ONLY' | 'RUN_OUTPUT_IF_PLANNED';
```

- **`SOURCE_POLICY_ONLY`** — always the persistent world, under the declared
  policy. For measurements and commitments that must remain source truth:
  available inventory, unit cost, a finance forecast. The default, because
  reading the world is the safe assumption and an execution dependency has to say
  so.
- **`RUN_OUTPUT_IF_PLANNED`** — if the current plan produces this metric for this
  node, consume **that** output: the execution frame's value, carrying the raw
  quantity rather than its business-rounded representation, without consulting
  persistence at all. If the upstream was not planned, fall back to persisted
  model truth (`DERIVED`), then to the source world, so a gap degrades to a stated
  number rather than to nothing.

This is how `Expected Revenue → Demand Quantity` works now: an execution
dependency, not "whichever DERIVED observation is newest". The registry refuses
an input that declares `RUN_OUTPUT_IF_PLANNED` for a metric no active calculation
produces, and `verify:calculations` requires every Meridian input on a
model-produced metric to declare it.

Every trace input records `boundTo: 'RUN_OUTPUT' | 'SOURCE_OBSERVATION'`, so a
reader can tell "the number my run computed one step earlier" from "what the
business had on file".

### A run consumes its own derived output

```
source world (actual / forecast / assumption)
  -> calculation run
    -> same-run derived output
      -> downstream calculations
```

The first implementation re-queried the node every time and appeared to work
because a run's own write always has the latest record time. It is accidental. Two
runs in flight — a scheduled recalculation overlapping a manual one — and a step
consumed the other run's output. The values happened to match, which is worse
rather than better: the trace cited an observation its run did not produce, so the
run's internal consistency could not be demonstrated.

Run outputs are now held in the execution frame, keyed by node. An `UNCHANGED`
step contributes too: it wrote nothing, but confirmed the existing observation as
this run's answer for that node. The concurrency regression test and
`verify:lineage` both create two interleaved runs, because the single-run case is
consistent by accident and a check against it has no teeth.

### Decision: two lenses, not one `asOf`

```
effectiveAsOf     what business time is being modelled
recordedThrough   what HELM was allowed to KNOW when the run began
```

A source observation is eligible only if **both** hold:

1. **Knowledge** — `recordedAt <= recordedThrough`. Record time only. Not
   `observedAt`: a source can assert something at 09:00 that HELM does not learn
   until 20:16, and a run that began at 20:15 could not have known it.
2. **Effect** — a point-in-time claim must have `effectiveAt <= effectiveAsOf`.
   Period claims are exempt: being about a future period is what a forecast is.

The two must not be collapsed. A Q4 forecast Finance files at 20:16 is valid for
the December a 20:15 run is modelling, and that run still must not see it — or a
run's inputs depend on how long the run took. A later run sees it, which is
correct.

`recordedThrough` defaults to the clock **once, at run start**. That default is
the whole mechanism: it pins the boundary before the first read. It gives a
deterministic knowledge boundary **without** a long-lived transaction,
serializable isolation or event sourcing; the record-time cutoff is sufficient
because observations are append-only and every one carries a record time.

*Limitation.* The cutoff bounds what enters a run, not what the store physically
contains. A run reading through the cutoff sees a consistent world only because
observations are never updated in place; an adapter that mutated observations
would break the guarantee, which is one more reason they are append-only.

### Within a tier: order, then ambiguity

1. **Order — which claim speaks to the latest moment?** Valid time descending
   (`effectiveAt`, else `periodStart`).
2. **Tie-break — which belief is current?** Record time descending. A later
   record of an equally-valid claim supersedes; that is what record time is for.
3. **Genuine ambiguity** — identical in valid time *and* record time — is
   `AMBIGUOUS_INPUT`, never an arbitrary pick.

*Known limitation.* Two forecasts for different future periods on one node would
be separated by step 1 and the further-out one would win. The node's
`timeHorizon` and each input's declared `horizon` keep periods apart today.

### What the fingerprint covers

A step's `inputFingerprint` covers the calculation reference, the horizon, the
scenario and each input's observation id and **canonical** value (`0.7`, `0.70`
and `0.700` are one number and fingerprint identically). It deliberately excludes
both lenses: they selected the inputs, they are not inputs, and including the old
`asOf` made every derived value permanently stale the moment the clock moved.

A freshness check re-resolves under the run's recorded **effective** lens and
policy, with the **knowledge** lens moved to now — because the question it
answers is "has anything been learned since?".

### Replay

Replay restores `effectiveAsOf`, `recordedThrough`, the policy, the scenario and
the calculation versions, and so reconstructs the original **input set**, not
merely the arithmetic. An observation recorded after the original's cutoff stays
invisible to the replay however long ago that was. A replay answers "what could
HELM know when this was executed?", which is what makes it evidence about a past
decision rather than a fresh run wearing an old run's id.

### Which time context an output is written with

The **metric**, not the node, decides. A metric's `timeBehavior` says whether it
is a stock (`effectiveAt`) or a flow (`periodStart`/`periodEnd`); the node's
`timeHorizon` only decides how long a flow's period is.

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
