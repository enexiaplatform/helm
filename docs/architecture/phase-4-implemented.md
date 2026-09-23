# Phase 4 implemented — Scenario Runtime & Branching Future States

**Date** 2026-09-22 · **Status** complete ·
**ADRs** [0019](../adr/0019-scenario-runtime.md), [0020](../adr/0020-period-identity.md) ·
**Terminology** [scenario-terminology](scenario-terminology.md) ·
**Legacy** [scenario-engine-assessment](scenario-engine-assessment.md)

Phase 4 gives HELM the ability to create, execute, compare and preserve several
internally consistent possible futures **without mutating the enterprise
baseline**. It adds no recommendation, no score, no ranking and no decision.

---

## 1. What a scenario is now

A scenario is a **branch of the model**, not a copy of the data:

```
Scenario  ── identity, lifecycle, optional parent
  └─ Revision ── fork point (effectiveAsOf · recordedThrough · policy)
                 periods · sealed once · fingerprinted
        └─ Override ── target node, SET|ADD, exact value, unit, period,
                       author, rationale, confidence, provenance kind
              ↓
        Simulation (ScenarioRun) ── one propagation-engine run per period
              ↓
        Future State ── a VIEW over value-graph observations + traces
```

Nothing is copied. No observation is written into the source world. The
baseline is the same machinery with no scenario and no overrides, which is what
makes a comparison between them honest.

## 2. The packages

| Package | Added in Phase 4 |
| --- | --- |
| `@helm/shared` | `period.ts` — `Period {start,end,grain}`, constructors, `periodKey`, `samePeriod`, `comparePeriods`, `periodContaining`; `fingerprint.ts` — `fnv1a64` |
| `@helm/value-graph` | 5 new metrics (`OrderQuantity`, `DemandCoverage`, `AllocatedInventory`, `UnservedDemand`, `RevenueAtRisk`); `WorkingCapital` revised to `CONTEXT_DEPENDENT` (v2); `canonicalScenarioExtension.ts` — 9 nodes, 12 links, **no observations** |
| `@helm/propagation-engine` | `ENGINE_VERSION 4.0.0`; period-aware selection; the input **overlay**; `SET`/`ADD` with baseline capture; period on runs and derived values; `rootMetricKeys`/`subjectEntityIds` so replay reproduces scope; `meridianValueModelV1_1.ts` (4 new calculations) |
| `@helm/scenario-runtime` | **new** — types, ports, overlay resolution, constraints, comparison, runtime, in-memory + Postgres stores, one conformance suite, the seven canonical Meridian scenarios |

## 3. The resolution stack

Each input a calculation asks for resolves through exactly one order:

| # | Source | Recorded as |
| --- | --- | --- |
| 1 | this run's own output | `boundTo: RUN_OUTPUT` |
| 2 | a scenario override in the overlay | `boundTo: SCENARIO_OVERRIDE` + an `OverrideTrace` |
| 3 | the source world under the policy and both lenses | `boundTo: SOURCE_OBSERVATION` |
| 4 | nothing speaks to it | the step BLOCKS and says why |

An `ADD` reads its baseline under the **same** order, lens and period, and the
trace keeps both: `Opex 240 000 000 override ADD · scenario override ADD
100 000 000 (external_signal) · inherited · shadows 1` sitting above
`Opex 140 000 000 ESTIMATE · stated by scm · ingested`.

Overrides on nodes the model computes are refused, twice — at the runtime and
at the engine.

## 4. Time

[ADR-0020](../adr/0020-period-identity.md) closes the Phase 3
"furthest-out forecast wins" defect. A period is a value with a grain and
half-open bounds; selection matches it exactly; with no period stated and more
than one interval present, the engine returns `AMBIGUOUS_PERIOD` instead of
guessing. Inputs declared `horizon: 'current'` are stocks and are read without a
period filter — the one deliberate carry-forward, declared per input.

Both Phase 3 lenses survive intact. A fork pins `effectiveAsOf` **and**
`recordedThrough`, so:

- **REPLAY** — same revision, same boundary, must reproduce the numbers.
- **REBASE** — a new revision at today's knowledge, a new fingerprint, and a
  comparability warning on every delta that uses it.

## 5. The canonical futures

Seven scenarios over the Meridian baseline (Rohto Q4 tender 4.2B VND at 70%,
four own units in HCMC, eight consignment units at Distributor D). Every number
below is produced by the propagation engine, not written down:

**Baseline (2026-Q4)**

| Value | |
| --- | --- |
| Expected Revenue — Rohto | 2 940 000 000 VND |
| Order Quantity | 12 units |
| Demand Quantity | 8.4 units |
| Inventory Requirement | 12.385714 units |
| Inventory Gap | 8.385714 units |
| COGS | 1 822 800 000 VND |
| Gross Margin | 977 200 000 VND |
| Gross Margin % | 33.2381 % |
| Working Capital | 2 687 700 000 VND |
| Cash Impact | −1 710 500 000 VND |
| Demand Coverage | 32.2953 % |
| Revenue at Risk | **BLOCKED** — no allocation is stated, and "nothing allocated" is not the same fact as "not yet decided" |

**The branches**

| Scenario | What it states | What the model computes |
| --- | --- | --- |
| **A** Expedite supply | lead time 7d, +8 units air-freighted, +80M freight | coverage **96.8858 %**, GM 897 200 000, GM% **30.517**, cash −1 790 500 000 |
| **A+** Expedite, and price the urgency *(child of A)* | inherits A; ASP 385M, freight +100M (shadows A's +80M) | coverage **100 %**, GM% **35.4731**, cash −1 400 450 000 |
| **B** Reallocate distributor stock | D's 8 consignment units transfer, +25M transfer cost | coverage 96.8858 %, GM 952 200 000, GM% 32.3878 |
| **C** Offer the alternative analyzer | ASP 330M, unit cost 238.7M, 12 units on hand | demand **8.909091**, GM% **22.9048**, WC 3 135 650 000, still **breached by 0.727273 units** |
| **D** Delay Rohto delivery to 2027-Q1 | opportunity value 0 in Q4, no Q4 fulfilment cost | Q4 revenue **0**, Q4 GM% **BLOCKED** (divide by zero, stated as such), Q1 revenue 2 940 000 000, Q1 GM% **38**, constraint **breached by 4 units** |
| **P** Commit own stock to Rohto | 4 units to Rohto, 0 to the provincial tender | Rohto unserved **8 units** → at risk **1 960 000 000**; tender unserved 8.857143 → at risk **1 395 000 000** |
| **T** Preserve own stock for the tender | 0 units to Rohto, 4 to the tender | Rohto unserved **12 units** → at risk **2 940 000 000**; tender unserved 4.857143 → at risk **765 000 000** |

P and T are the shared-resource pair (§30–31). The same four units cannot serve
both; HELM shows what each commitment forecloses and does not choose.

D is the multi-period proof (§55): the two quarters compute independently, and
the comparison refuses to compare across them —
*"models different periods: values for a period only one state models are
unresolved, never compared across periods."*

## 6. Comparison

`ScenarioComparison` returns the matrix, a `ValueDelta` per (node, period,
state) with both sides' origin and confidence, the assumption deltas that
produced them, unresolved rows with reasons, feasibility results, completeness,
and comparability warnings. A movement is interpreted only through the metric's
declared directionality. Nothing is summed across dimensions, weighted or
ordered. Every comparison carries this sentence:

> Differences between modelled future states. HELM does not rank, score or
> recommend: each difference is shown with its origin and confidence,
> incomplete results are marked rather than filled in, and the choice between
> states remains a management decision.

Assumption deltas and outcome deltas are presented as **separate tables** in the
explorer (§48), because "we assumed 12 units" and "therefore margin fell 2.7
points" are different kinds of statement.

## 7. Feasibility, not optimization

Two constraints ship with the Meridian frame: *Rohto order ships from own
stock* and *Allocations fit own stock*. Each returns SATISFIED, BREACHED (with
the amount) or **UNKNOWN with the reason** — e.g. *"Cannot judge allocations fit
own stock in 2026-Q4: Allocated Inventory for Rohto Q4 tender is UNAVAILABLE
(nothing in the source world speaks to this under the state's boundary)."*
No constraint proposes an allocation, and none is satisfied by default.

## 8. Database

One additive migration, `20260922090100_helm_scenario_runtime.sql`, applied to
the shared Supabase project in nine named parts.

| Object | |
| --- | --- |
| `helm_scenarios` | **migrated in place** — new columns, widened lifecycle, identity guard; legacy `baseline` / `variants` / `decision_id` retained and `COMMENT`-marked RETIRED |
| `helm_scenario_revisions` | fork point + periods + sealing; one DRAFT per scenario (partial unique index); never deleted; sealed rows frozen |
| `helm_scenario_overrides` | immutable; removable only from a DRAFT; exact-decimal `value` CHECK; overlap refusal; `STRUCTURAL_OVERRIDE` **not storable** |
| `helm_scenario_runs` | context immutable, `period_runs` append-only and validated against `helm_calculation_runs.scenario_revision_id`, completes once |
| `helm_scenario_constraint_results` | append-only, one verdict per (run, constraint, period), recordable only after the run completes |
| `helm_calculation_runs` | + `period_start/end/grain`, `scenario_revision_id`, `root_metric_keys`, `subject_entity_ids`; scenario-coherence CHECK widened |

Business logic stays in code. The triggers enforce **integrity only** —
immutability, tenancy, coherence — and never compute a business value.

### Applied to the shared database

Pre-flight and post-flight on `mlmpcpkucurylkrobain`:

| | before | after |
| --- | --- | --- |
| Memoire `accounts` | 1 106 | 1 106 |
| Memoire `opportunities` | 128 | 128 |
| Memoire functions | 9 | 9 |
| Memoire function fingerprint | `eef6a68b…` | `eef6a68b…` (identical) |
| `helm_*` tables | 29 | 33 |
| `helm_*` policies | 101 | 112 |
| system value metrics | 32 | 37 |
| system calculations | 9 | 13 |

**37 server-side assertions** were then run inside a transaction that
deliberately aborts. All 37 refusals held, and the harness carries a built-in
control — one deliberately *legal* statement that must be recorded — because the
first version of the harness silently swallowed its own failures and reported a
clean pass. The control caught it. After the rollback, `organizations`,
`helm_entities`, `helm_value_nodes` and all four scenario tables were verified
back at zero rows and the Memoire function fingerprint unchanged.

Supabase advisors afterwards: **no new security findings** (the two remaining
warnings are Memoire's own org-membership helpers and an Auth setting, both
pre-existing). Three new `auth_rls_initplan` performance warnings were fixed the
same way Phase 2 fixed the earlier tables — `auth.uid()` hoisted into
`(select auth.uid())` — and the migration file updated to match.

## 9. The `/scenarios` explorer

A technical instrument, not the GM cockpit:

- **Fork strip** — business time, knowledge boundary, policy, mode, baseline
  fingerprint; period selector with *"periods are never compared across one
  another"* stated next to it.
- **Branch view** — the baseline and every scenario as cards, children nested
  under parents, five branch metrics with signed deltas toned by the metric's
  directionality, breaches called out, and `unresolved` (never a fabricated
  zero) where a delta cannot be stated.
- **Scenario panel** — assumptions table with inherited / shadowed / *not
  modelled* flags, add-override form limited to nodes the model does not
  compute, Seal · Simulate · New revision · Rebase · Replay · Archive, the
  validation report, and the revision list with fingerprints.
- **Comparison** — the statement above, then the assumption delta table, then
  the outcome delta matrix with origin chips and confidence, then feasibility,
  completeness and comparability.
- **Lineage** — click any value: future state → calculation → inputs →
  override (author, rationale, confidence, inherited, shadows) → baseline
  observation → source provenance.

Verified in the browser end to end: a third-generation branch was created,
given an `ADD +4` that correctly **shadowed** its ancestor's `+8` (coverage
71.0496 %, breached by 2.909091 units — not the 100 % that stacking would have
produced), sealed, simulated, replayed, rebased, and the rebase immediately
produced the comparability warning on every one of its deltas.

## 10. Contracts

| Contract | Asserts |
| --- | --- |
| `verify:scenario-schema` | 4 scenario tables guarded, history immutable, sealed revisions frozen, migration additive |
| `verify:scenario-runtime` | 7 futures + baseline through **one** engine, outcomes derived, Delay breached by 4, comparison chooses nothing |
| `verify:scenario-isolation` | baseline untouched, outputs tagged to their run, concurrent futures separate, no output read as another's input, tenants walled |
| `verify:scenario-time` | period identity, no period guessing, mismatch surfaced, fork pinned, replay ≠ rebase |
| `verify:scenario-lineage` | 55 scenario values explained to source, 56 override nodes resolved, canonical fingerprints |
| `verify:phase-boundary` | *(updated)* no recommendation, no decisions, no authority, no causal inference, no optimization, no agent debate, no management surface — across 26 files |

Every contract was mutation-tested: each assertion was broken on purpose and
each one failed. `npm run check` is green — **377 tests (373 pass, 4 skipped),
20 contracts**, lint and production build clean.

## 11. Performance

Measured in memory over the canonical Meridian graph (48 value nodes,
13 calculations), Node 24 on the development machine:

| | |
| --- | --- |
| stack build (entity graph + value chain + extension) | 12.1 ms |
| define 7 scenarios (create + overrides + seal) | 6.3 ms |
| baseline simulation, 1 period | 7.5 ms |
| 7 scenario simulations | 11.8 ms total (1.2–2.7 ms each) |
| 50 scenarios defined **and** simulated | 76.6 ms (**1.53 ms each**) |
| comparison | 0.7 ms |

The shape is what the design predicts: **cost is linear in (scenarios ×
periods)**, each unit being one full propagation. There is no caching and no
sharing of intermediate results between branches — two scenarios that override
the same node still compute everything twice. That is deliberate for now:
sharing work between branches is exactly where a scenario engine starts telling
small lies, and the scenario fingerprint exists so that memoization can be added
later with a provable key.

Against Postgres the propagation itself is unchanged; the cost moves to
round-trips per node, which is the same characteristic Phase 3 recorded. No
cloud measurement is quoted here because no organization has yet onboarded to
the shared database — inventing a number would be worse than not having one.

## 12. Debt carried forward

| Debt | Why it is not fixed here |
| --- | --- |
| **Postgres conformance suites skip** | They need test-branch credentials that do not exist. Four suites are skipped, not passing. Flagged since Phase 2 and still flagged. |
| **Structural overrides** | Interface declared, storage refused. Executing a structural change needs a per-revision model projection the engine does not have. |
| **Period arithmetic** | No roll-up, split, carry-over or revenue-recognition schedule. D moves the whole order to Q1 because that is the only honest thing v1.1 can say. |
| **`recordedThrough <= started_at`** is not a DB constraint | Enforced in the runtime (`checkFork` refuses a future knowledge boundary); the database would need a non-immutable CHECK. |
| **Aggregation** | The engine still sums; `WEIGHTED_AVERAGE`, `MIN`, `MAX` are declared on metrics and not yet executed. |
| **Unindexed foreign keys** on the new tables | Advisor INFO, matching the existing pattern across all 87 such keys in the shared database. Tables are empty; indexing is a Phase 5 question. |
| **No memoization** | See §11. |
| **WorkingCapital directionality revised** | `LOWER_IS_BETTER` → `CONTEXT_DEPENDENT` (metric version 2). Anything that read the old directionality should be re-read. |

## 13. What Phase 4 deliberately does not do

No scenario is recommended. Nothing is scored or ranked. No scenario is
approved, and none creates a commitment. No decision authority is assigned and
no business action is executed. Attaching a scenario revision to a decision —
and everything that follows from it — is Phase 5.
