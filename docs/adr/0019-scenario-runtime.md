# ADR-0019: The Scenario Runtime — branches of the model, not copies of the data

**Status** accepted · **Date** 2026-09-22 · **Deciders** Architecture ·
**Phase** 4 · **Depends on** [ADR-0017](0017-calculation-semantics.md),
[ADR-0020](0020-period-identity.md), [ADR-0014](0014-bitemporal-lite.md)

## Context

HELM could compute one future: the enterprise as the source systems describe it,
propagated through the value model. Management does not decide against one
future. It decides between several, and the question it actually asks is *"if we
expedite, what else moves, and what does that cost somewhere the expediting team
never looks?"*

A "scenario" feature is easy to build badly. The three bad shapes are well
known:

1. **Copy the data.** Duplicate the observations, edit the copies, compute.
   The copy diverges from the baseline the moment anything is ingested, and
   nobody can say whether a difference came from the scenario or from the drift.
2. **Fake observations.** Write the override into the observation table as a
   SCENARIO-layer fact. Now the source world contains statements nobody
   observed, and the lineage of every downstream number is a lie by omission.
3. **A second engine.** A scenario calculator beside the real one. The two
   drift, and the scenario number stops being a prediction about the same
   business.

Phase 4 had to avoid all three while producing genuinely distinct futures over
the same Meridian data.

## Decision

### 1. A scenario is a branch of the model

A scenario holds **no values**. It holds a fork point, a set of periods, and a
sealed list of explicit overrides. Running it re-executes the existing
propagation engine against the existing source world, with the overrides applied
as an **input overlay** at resolution time.

Nothing is copied. Nothing is written into `helm_value_observations`. The
baseline is not touched, and the same baseline can be forked any number of times.

### 2. The resolution stack

Every input a calculation asks for is resolved through one ordered stack:

| Order | Source | When |
| --- | --- | --- |
| 1 | **run output** | the upstream value this run already computed (`RUN_OUTPUT_IF_PLANNED`) |
| 2 | **scenario override** | the overlay holds an entry for this node |
| 3 | **source world** | the observation the policy and the two lenses select |
| 4 | **missing** | nothing speaks to it — the step BLOCKS and says why |

An override is an overlay entry, resolved in the engine, recorded on the traced
input, and visible in the explanation. Two operations exist:

- `SET` binds the value directly.
- `ADD` reads the baseline value **under the same order, lens and period** and
  sums, recording both the delta and the baseline it moved from.

### 3. Outcomes are derived, never stated

An override on a node the model computes is refused
(`OVERRIDE_TARGETS_COMPUTED_NODE`) — at the runtime when it is added, and again
at the engine when an overlay is handed in. "Set gross margin to 38%" is not a
scenario; it is a wish. The `/scenarios` explorer only offers nodes the model
does not compute, so the refusal is rarely reached in practice and is there for
everything that is not the UI.

### 4. The fork point is pinned

A revision records `effectiveAsOf`, `recordedThrough` and the observation
policy, and every run of that revision executes exactly those. Two consequences:

- **REPLAY** re-executes the same revision at the same boundary and must
  reproduce the same numbers. It is evidence, not a refresh.
- **REBASE** is a different question and gets a new revision, a new fingerprint
  and a visible comparability warning: *"simulated at a different boundary …
  differences mix the scenario's effect with what was learned in between."*

Refreshing in place would destroy the only thing that makes a scenario
defensible later — that the numbers can be reproduced from what was known when
they were produced.

### 5. Revisions are immutable once sealed

A scenario's editable surface is one DRAFT revision. Sealing fixes the
overrides, the model reference and the fingerprint. After that the revision
never changes: an edit produces a new revision, and the old one keeps its runs.
Enforced in the store **and** in the database (`helm_scenario_revisions_guard`,
`helm_scenario_overrides_guard`), because "the app promised" is not an audit
trail.

### 6. Inheritance is bounded, and shadowing is recorded

A child scenario pins a **specific sealed revision** of its parent and inherits
that revision's overrides, up to `MAX_INHERITANCE_DEPTH = 2` ancestors. Where
child and ancestor override the same node, **the child wins** and the shadowed
override is recorded — the explorer shows "shadows 1" and the tooltip names what
was displaced. A child's `ADD +4` does not stack on an ancestor's `ADD +8`; it
replaces it, and the reader can see that it did.

Unbounded inheritance was rejected: a chain deep enough to be interesting is
also deep enough that nobody can say what the effective assumption is.

### 7. The fingerprint

`sfp_<fnv1a64>_<length>` over organization, fork point, periods, engine version,
calculation `key@version` list, and the effective overrides after inheritance
(node, operation, canonical value, unit, currency, confidence), sorted. Names,
rationale and authorship are excluded — they change no number. Values go through
the Phase 3 canonical numeric form, so `0.9`, `0.90` and `0.900` are one
fingerprint. The fork point is **inside** the fingerprint: the same overrides
against a different baseline boundary are not the same simulation.

### 8. Comparison states differences; it does not resolve them

`ScenarioComparison` holds a matrix (every value node × period × state), a
`ValueDelta` per row with both sides' origin and confidence, and the assumption
deltas that produced them. A movement is interpreted **only** through the
metric's own declared directionality (FAVORABLE / UNFAVORABLE / NEUTRAL /
CONTEXT_DEPENDENT). Nothing is summed across dimensions, weighted, scored or
ranked. A delta that cannot be stated says why instead of showing a zero.

Working Capital was revised to `CONTEXT_DEPENDENT` in this phase: under a
service objective, less working capital is not better.

### 9. Feasibility is not optimization

`ScenarioConstraintResult` answers *"does this future fit within a stated
limit?"* with SATISFIED / BREACHED / UNKNOWN, a breach amount, and an
explanation. It never proposes an allocation and never searches for one. Where
the inputs to a constraint are not modelled, the answer is UNKNOWN with the
reason — not SATISFIED by default.

### 10. Structural change is deferred, honestly

`STRUCTURAL_OVERRIDE` exists in the type system as a declared interface and is
**refused by the database** (`override_type` excludes it). Adding or removing
model structure inside a branch would need a per-revision model projection the
engine does not have. Declaring the interface and refusing to store one is the
honest form of "not yet"; a column that accepts a structural override which
nothing executes is not.

## Consequences

**Good.** One engine, one set of semantics, one lineage story. A scenario's
numbers can be traced value → calculation → inputs → override (with its author,
rationale and confidence) → baseline observation → source provenance, and the
`/scenarios` explorer does exactly that. Reproducibility is a property of the
design rather than a discipline.

**Cost.** Every scenario costs a full propagation per period — see the
performance note in [phase-4-implemented](../architecture/layers/scenario-runtime.md).
Nothing is cached yet; the fingerprint exists so that it can be.

**Refusals users will meet.** Overriding a computed node; simulating a draft
revision; editing a sealed revision; a run whose boundary drifts from its
revision's; a scenario under the `SCENARIO` observation policy (the overlay and
the legacy scenario layer are two answers to one question, so the combination is
refused rather than silently ordered).

## Alternatives considered

**Copy-on-write observation sets.** Rejected — bad shape 1 above, plus it makes
the source world's size a function of how many what-ifs someone tried.

**Scenario observations in the SCENARIO truth layer.** Rejected — bad shape 2.
It was tempting because Phase 3 already had the layer. The layer stays for
externally-supplied scenario data; a branch does not use it.

**A scenario calculation service.** Rejected — bad shape 3, and explicitly out
of scope per the Phase 4 brief.

**Storing computed scenario values on the value nodes.** Rejected: scenario
outputs live in their own run and are read as a *view* over the value graph
(`FutureState`), so the enterprise baseline a manager reads is never polluted by
somebody's what-if.
