# Phase 3 — Value Propagation Engine (implemented record)

What was built, the decisions taken during implementation, the deviations and
the debt. A record, not a plan.

**Delivered 2026-09-20.** Branch `phase-1-enterprise-ontology`, building on
Phase 2 (`fe1c700`).

## 1. What exists now

### `@helm/propagation-engine`

| Module | Contents |
| --- | --- |
| `types.ts` | 20 error codes, 4 observation preferences, 3 input binding kinds, calculation/run/step/trace/explanation types |
| `registry.ts` | calculation validation — units, metrics, governance, versions, duplicate and conflicting definitions |
| `dependencyGraph.ts` | build, DFS cycle detection, deterministic Kahn ordering, `downstreamOf` |
| `engine.ts` | the engine: observation selection, input resolution, planning, execution, fingerprinting, freshness, replay, `explain()` |
| `meridianValueModelV1.ts` | 9 governed calculations — the first executable management model |
| `port.ts` | `PropagationEngine` and `CalculationStore` interfaces |
| `inMemoryStore.ts` / `postgres.ts` | two adapters, one conformance suite |
| `conformance.ts` | the shared adapter contract, 11 tests |

### `@helm/shared` additions

| Module | Contents |
| --- | --- |
| `decimal.ts` | BigInt fixed-point at scale 12, four rounding modes ([ADR-0016](../adr/0016-decimal-arithmetic.md)) |
| `quantity.ts` | unit-safe algebra; the wrong operation is not available |

### Database — 3 new tables, all additive

```
helm_calculations       governance metadata; NO executable code
helm_calculation_runs   one execution, with the full context that reproduces it
helm_calculation_steps  the append-only trace, including the steps that failed
```

Plus a widened `helm_provenance.subject_kind` CHECK (`calculation_run`,
`calculation_step`), a replaced CHECK on `helm_value_observations`
(`calculation_run_id` now permitted on DERIVED and SCENARIO and nothing else),
a foreign key for that column, and two integrity triggers that compute nothing.

29 `helm_*` tables live, 109 policies.

### Application

One new route, `/calculations` — the Calculation Explorer. Shows the governed
model, the execution order, the trace with formulas rendered in real numbers,
the positions declared uncomputable, and `explain()` as an indented derivation
down to source facts.

### Executable contracts

Six new, each negative-tested: `verify:calculations`,
`verify:calculation-graph`, `verify:propagation`, `verify:lineage`,
`verify:phase-boundary`, `verify:docs`. Fifteen in total across the four phases.

`verify:lineage` deliberately creates two interleaved runs rather than asserting
into a single sequential one: same-run consistency is accidentally true when
nothing races, so a contract that only checked the easy case would have had no
teeth.

---

## 2. Decisions taken during implementation

### 2.1 BigInt fixed-point, not floats ([ADR-0016](../adr/0016-decimal-arithmetic.md))

The motivating case is HELM's own demand calculation: `0.7 × 12` is
`8.399999999999999` in IEEE-754. Worth being precise about the scale of the
problem, because it is easy to overstate — many large products *are* exact in
float. The argument is the unpredictability, not universal wrongness.

### 2.2 Code holds logic, the database holds governance ([ADR-0017](../adr/0017-calculation-semantics.md) §1)

`helm_calculations` stores key, version, owner, rationale, effective date, the
declared inputs as data, and the human-readable expression. It stores no
executable code, because there is no evaluator and the brief forbids one.
`verify:calculations` asserts the two halves agree.

### 2.3 DERIVED outranks FORECAST in the BASELINE preference

**This was originally the other way round, and the canonical chain proved it
wrong.** With `FORECAST` first, changing the opportunity probability
recalculated expected revenue — and then demand read the *stated* forecast
instead, so nothing downstream of the change moved. The model computed and
propagated nothing.

The principle: if HELM can compute a number, the computed one is the baseline,
because it is the only one that can be explained. A stated forecast is the
fallback for what HELM cannot compute. `ACTUALS_FIRST` still puts a measurement
ahead of a model.

### 2.4 Eligibility is record time; ordering is valid time

The first implementation judged both on valid time, which excluded every Q4
forecast from every run in September — making forecasting impossible. The two
kinds of time answer two different questions:

* **Was this known at `asOf`?** Record time (`observedAt`, else `recordedAt`).
* **Which claim speaks to the latest moment?** Valid time.
* **Which belief is current?** Record time again, as the tie-break. A
  recalculated derived value has the same valid time as the one it supersedes.

Genuine ambiguity — identical in both — is an error, never an arbitrary pick.

### 2.5 `asOf` is not part of the input fingerprint

`asOf` is the lens that selects inputs, not an input. Including it made every
derived value in HELM permanently stale the moment the clock moved. The
fingerprint covers the calculation reference, horizon, scenario and the exact
input observations and values.

### 2.6 A run consumes its own derived output

Downstream steps take the observation **this run** produced, not whichever
DERIVED observation is newest on the node. Re-querying worked only because a
run's own write has the latest record time; two interleaved runs broke it, and a
step consumed the other run's output. The values happened to match, which is
worse rather than better — the number was right by luck and the trace cited an
observation its run did not produce. See [ADR-0017](../adr/0017-calculation-semantics.md).

Not provided: snapshot isolation over the source world. Two runs at the same
`asOf` can still read different facts if one is recorded between their reads.
Both are correct as of that `asOf`; replay is the mitigation.

### 2.7 The metric decides the time context, not the node

Working capital is a balance even when it is the balance implied by a quarter's
demand. Deriving the observation's time context from the node's horizon wrote a
period onto a stock, and the value graph correctly refused it.

### 2.8 Every input declares its horizon

An opportunity's value is a `current` fact; the revenue it implies is a
`quarter` figure. Leaving that implicit made the engine silently drop
`current`-horizon inputs from quarterly runs. Each input now says which horizon
it wants, and a metric that exists only at another horizon produces
`TIME_CONTEXT_MISMATCH` — "expected revenue exists, but only for the quarter" —
rather than a bare missing-input error that sends a reader hunting for data that
was never missing.

### 2.9 The ontology decides what a category is

Scope compatibility was checked against a hand-maintained list of entity type
keys inside the engine. It is now the injected `OntologyRegistry`: a calculation
that says it applies to "commercial" subjects means what the ontology means, and
a new entity type does not require an edit to the engine.

### 2.10 A derived value's provenance names the RUN

The provenance record has to exist before the observation that points at it, and
`helm_provenance` is append-only, so a placeholder subject could never be
corrected. The subject is the calculation run; the reverse direction is served
by the step, which is indexed by the observation it produced and is the richer
lineage record. `getObservationProvenance` falls back to the observation's own
`provenance_id`, so "where did this number come from?" has one answer for every
observation type.

### 2.11 The CalculationStore has no provenance methods

Giving it its own meant two provenance stores in memory and one table in
Postgres — a divergence the conformance suite could not paper over. Provenance
for a value observation belongs to the port that owns the observation.

---

## 3. Deviations from the Phase 3 plan

### 3.1 The canonical value chain was extended

Phase 2's fixture had no value position for COGS, cash impact, per-product
working capital, gross margin % at deal level, the competing tender's
probability, or the selling-price assumption. Six nodes, sixteen links and two
observations were added: **39 nodes, 55 links, 42 observations**.

Four of the new nodes carry no observation at all. That is deliberate — the
enterprise genuinely has those value positions and nothing in the operational
systems states them. They are the holes an executable model fills, and declaring
them in the fixture is what keeps the calculation layer from inventing value
positions of its own.

`InventoryGap` moved from a `current` to a `quarter` horizon: a gap measured
against a quarter's requirement is a quarter's number.

### 3.2 `inventory_requirement` aggregates across opportunities

Two opportunities sell SKU-X. Without aggregation the calculation reported
`AMBIGUOUS_INPUT` and stopped. With it, the requirement is
`Σ (8.4 + 3.985714285714) = 12.385714285714` against 4 units on hand — which is
where Phase 2's structural contention becomes a quantity.

### 3.3 An aggregated input records its components

`Σ 12.385714285714 = 12.385714285714` is a true and useless trace. The trace now
carries the individual claims and renders `Σ (8.4 units + 3.985714285714 units)`.
`verify:lineage` enforces it.

### 3.4 `PropagationResult` carries what the run declined to compute

Originally only the plan did, which made "declared uncomputable" invisible to
anyone looking at a run. A silent absence reads as forgotten.

### 3.5 Two Phase 2 gaps found and fixed

* **`getLatestObservation` had no tie-break.** Two observations with the same
  valid time were ordered by storage order. Both adapters now share one
  `byRecency` comparator: valid time, then record time.
* **The in-memory adapter accepted a `scopeKind` Postgres would reject.** Found
  by a Phase 3 test using `'FUNCTION'` instead of `'function'`. Both adapters
  now validate scope kind and horizon, with a conformance test.

### 3.6 A trigger bug found by the live proof

`helm_calculation_run_integrity` read `entity_type_key` from `helm_entities`,
which stores the type by id. Found only when running against the real database;
fixed in the generator and applied.

### 3.7 `verify:schema` learned about superseded constraints

Its rule allowed a dropped CHECK only if the same name was re-added. Phase 3
replaces `helm_value_obs_no_calculation` ("always NULL") with
`helm_value_obs_calculation_coherent` ("only on DERIVED or SCENARIO") — keeping
the old name would have left a constraint asserting the opposite of what it
enforced. The rule now permits replacement on the same table and still refuses
removal. Negative-tested.

---

## 4. Test results

```
277 tests, 274 pass, 3 skipped (Postgres conformance — needs credentials)
15 verify contracts, all passing, each negative-tested
typecheck clean, lint clean
```

New this phase: 20 quantity tests, 14 canonical propagation tests, 46 engine
semantics tests, 11 CalculationStore conformance tests.

The canonical proof:

| Claim | Result |
| --- | --- |
| The whole chain computes | 11 calculated, 0 blocked, 0 failed |
| Probability 70% → 90% | Expected Revenue 2.94B → **3.78B**, demand 8.4 → **10.8** |
| Unit cost +10% | COGS, margin, working capital and cash move; **revenue, demand, requirement and gap do not** |
| Re-running unchanged | 0 calculated, all UNCHANGED |
| History | both derived values survive; the old one is never overwritten |
| Staleness | STALE without mutating the recorded value |
| Replay | identical fingerprints, identical numbers |
| Exactness | `8.4`, `12.385714285714`, `2687699999.999938` — no drift |
| Contention | 12.39 units claimed against 4 available; gap 8.39 |

---

## 5. Security

The Phase 3 migration is strictly additive and touches only `helm_*` objects. No
Memoire table, policy, index, trigger or function is altered or dropped.
Memoire was verified byte-identical before and after: **1 106 accounts, 127
opportunities**, unchanged.

Eleven server-side assertions were run against the live database inside a
transaction that deliberately aborts, so nothing was committed and
`organizations` — a Memoire-owned table — was never durably modified:

* a DERIVED observation may carry a calculation run; an ACTUAL may not
* a CALCULATED step without its observation, formula and fingerprint is refused
* a BLOCKED step must explain itself in more than a few words
* a step cannot claim a metric its value node does not carry
* exactly one step may claim a derived observation
* a baseline run cannot name a scenario
* a scenario run must point at a Scenario entity
* only one version of a calculation may be ACTIVE
* a calculation with no inputs is refused

Traces are append-only in the database, not only in code: `helm_calculation_steps`
has SELECT and INSERT policies and nothing else.

No new security advisories. One pre-existing warning remains from Phase 1 —
`helm_write_entity` has a mutable `search_path` — flagged rather than fixed,
because it is outside this phase.

---

## 6. Technical debt

| Debt | Why it exists | When |
| --- | --- | --- |
| The Postgres conformance suite is unrun | needs a Supabase branch and a signed-in user; credentials cannot be fabricated | when a test branch exists |
| Aggregation is SUM only | the value graph models 8 aggregation behaviours; the engine implements one | Phase 4, with `MAX` for bottlenecks |
| No consolidation model | BU and enterprise roll-ups are declared uncomputable rather than faked | Phase 7 |
| Two forecasts for different future periods on one node would resolve by "furthest out wins" | the horizon filter keeps periods apart today; the case does not arise | before multi-period forecasting |
| No snapshot isolation over the source world | two runs at the same `asOf` can read different facts if one lands between their reads; both are correct as of that `asOf` | when runs are scheduled rather than manual |
| A calculation can reference a metric pair with no value link | the semantic model can fall behind the executable one, unflagged | a future verifier |
| `metricKeyOf` in the Postgres store is a linear scan | the registry has 32 metrics | when it matters |
| Eight pre-kernel engines remain unintegrated | assessed individually, not wrapped — see [the assessment](engine-integration-assessment.md) | Phases 4, 5, 7, 8, 10 |

---

## 7. What Phase 3 proved, and did not

**Proved.** A change to one source fact propagates through nine calculations
across three entity types and two graphs, deterministically, exactly, and
explains itself down to the Memoire record that asserted it. The cost branch and
the revenue branch are genuinely independent — a unit cost change does not touch
revenue, and the test that asserts it would fail if an undeclared dependency were
introduced. History is never rewritten. A run replays to the same numbers.

**Did not prove.** That the model is *right*. Nine calculations with an average
definition confidence of 0.87 are a v1 that admits to being crude in exactly two
places. The model computes correctly; whether it represents Meridian's economics
well enough to decide with is a question for the people who own the numbers, and
the rationale and confidence fields exist so they can judge it.

**Did not attempt.** Scenario comparison, decisions, authority, management
surfaces, optimization. `verify:phase-boundary` fails the build if any of them
appear.
