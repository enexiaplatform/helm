# Scenario terminology

Six words do most of the work in Phase 4, and three of them are words other
systems use for something else. This page fixes what each one means in HELM.
The same definitions appear at the top of
`packages/scenario-runtime/src/types.ts`, so code and prose cannot drift.

## The six terms

| Term | Means | Does **not** mean |
| --- | --- | --- |
| **Scenario** | A defined hypothetical: a named set of changes to the enterprise model, forked from a baseline. An identity with a lifecycle. | A copy of the enterprise state. A plan. A proposal. A decision. |
| **Revision** | One specific set of those changes together with the fork point they apply to. Immutable once SEALED. | A draft that keeps changing under its own runs. |
| **Override** | One explicit change to one input — target, value, unit, period, author, rationale, confidence, provenance. | A correction to the source world. An observation. |
| **Simulation** | Executing the enterprise model under a revision: one propagation-engine run per modelled period. Recorded as a `ScenarioRun`. | A forecast. A commitment. A separate scenario engine. |
| **Future State** | The management/value state a simulation produced — a **view** over value-graph observations and calculation traces. | A second state model stored beside the baseline. |
| **Comparison** | The differences between future states, per metric and dimension, each with origin and confidence. | A ranking. A score. A recommendation. |

## The baseline is a modelled state too

The baseline is not a special case with its own code path. It is the same run
record and the same future-state view, distinguished only by carrying no
scenario and no overrides. This is what makes a comparison honest: both sides
were produced the same way, at the same boundary, by the same model.

It also means the baseline never needs a fake scenario observation to be
comparable — which was the trap Phase 4 §15 called out.

## Words used elsewhere that HELM avoids

| Word | Why it is avoided |
| --- | --- |
| *Version* (of a scenario) | Ambiguous between the revision, the model version and the engine version. All three exist; each is named. |
| *Snapshot* | Suggests copied data. A revision pins a **boundary**, not a copy. |
| *What-if* | Fine in conversation; too loose for a type. The pre-kernel CVP page used it for something much smaller (see [scenario-engine-assessment](../archive/scenario-engine-assessment.md)). |
| *Best case / worst case* | Implies an ordering HELM does not compute. Scenarios are named for what they change, not for how good they look. |
| *Recommendation* | Phase 4 produces none. The verify contract `verify:phase-boundary` fails the build if the word starts appearing in scenario code. |

## Related vocabulary already fixed by earlier phases

- **Truth layers** SOURCE / MODEL / EXECUTION and the observation policies —
  [ADR-0017](../adr/0017-calculation-semantics.md).
- **The two lenses** `effectiveAsOf` (business time) and `recordedThrough`
  (knowledge time) — [ADR-0014](../adr/0014-bitemporal-lite.md).
- **Period** as a value with a grain and half-open bounds —
  [ADR-0020](../adr/0020-period-identity.md).
- **Fork point**, **replay** and **rebase** —
  [ADR-0019](../adr/0019-scenario-runtime.md) §4.
