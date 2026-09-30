# ADR-0029: Counterfactual worlds — anchored, labelled, never collapsed

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Phase** 10 · **Depends on** [ADR-0019](0019-scenario-runtime.md),
[ADR-0021](0021-decision-runtime.md), [ADR-0023](0023-management-digital-twin.md),
[ADR-0026](0026-enterprise-causal-graph.md), [ADR-0027](0027-causal-evidence-policy.md),
[ADR-0028](0028-management-genome.md) ·
`docs/architecture/decision-quality-vs-outcome.md`

## Context

HELM can say what management chose, what it expected, what happened and what it
believes caused it. The question a review then asks is the one the kernel has
been careful never to answer: *what might have happened had we chosen
differently?*

The ways to answer it badly are familiar:

1. **Re-running today's model on today's state.** The enterprise has already
   acted; its stock has moved, its cash has been spent. An alternative applied
   to *that* state is a different question, and it double-counts the decision
   that was actually taken.
2. **A single number.** "Had we expedited, profit would have been X." Fake
   certainty from a model that has never been validated against an intervention.
3. **Hindsight leaking into the past.** "Knowing what we know now" quietly
   replaces "what we could have known then", and a decision is judged on
   information it could not have had.
4. **Regret as a score.** A ranking of decisions by what they cost against an
   imagined alternative turns learning into blame (Decision Quality ≠ Outcome
   Quality).

## Decision

### 1. A counterfactual is not a scenario

A **scenario** is ex ante: what could happen if we choose A. A **counterfactual**
is ex post: *given* what actually happened, what might have happened had we
chosen B. They are different objects with different anchors, and neither
replaces the other. Nothing in the scenario runtime changes; a counterfactual
world is *computed with* it.

### 2. Four objects

- **`CounterfactualCase`** — identity, immutable, authored by a person: the
  decision and commitment it reviews, the question, the **intervention**, the
  **anchor**, the metrics compared (copied from what the commitment expected to
  move), scope, and the sensitivity classes those imply.
- **`CounterfactualIntervention`** — explicit, and different from what was
  chosen: `CHOOSE_ALTERNATIVE` (an alternative the decision recorded) or
  `OVERRIDES` (stated changes with rationale and provenance — "no discount").
  HELM never proposes an intervention.
- **`CounterfactualWorld`** — one computed world, append-only, for one
  retrospective lens (§4). It carries its method, boundary, model lineage,
  assumptions, hindsight inputs, estimability, causal support and uncertainty.
- **`CounterfactualComparison`** — derived at a lens, never stored: the actual
  world beside the counterfactual worlds, layered (§6).

A person's **`CounterfactualReview`** is a recorded reading of a comparison,
pinned to its fingerprint, with required limitations. "Completed" means a case
has a review; the Genome may reference it (§9).

### 3. Every counterfactual has an anchor, and the anchor is the past

The anchor is a twin snapshot known **at or before the decision boundary**. A
snapshot recorded later is refused as an anchor
(`counterfactual.hindsight_as_anchor`); today's state is never one. The world's
fork is the decision's own fork, so an alternative is evaluated on the world
management faced.

### 4. Two retrospective lenses, never conflated

| Lens | Answers | Built from |
| --- | --- | --- |
| `AS_KNOWN_THEN` | what alternative future could management reasonably have expected then? | the alternative's run **bound to the decision** (computed then), or — for an `OVERRIDES` intervention — a scenario forked at the decision's own boundary. Refused if the run was recorded after the boundary. |
| `WITH_HINDSIGHT` | knowing what we know now, how might the alternative have behaved? | the same alternative and the same anchor, plus **explicit hindsight inputs** |

A **hindsight input** is one fact learned after the boundary, stated as an
override with its source record (an outcome review, an observation, a claim), the
time it was learned, and a **person's statement of why it is independent of which
alternative was chosen** (`exogeneity`, required). HELM records the assertion and
shows it; it cannot verify it. It refuses two things mechanically: an input that
was already knowable at the boundary (that belongs in `AS_KNOWN_THEN`), and an
input that targets a value the *chosen* alternative changed (that is a
consequence of the actual choice, not news about the world). `WITH_HINDSIGHT`
without at least one input is refused: it would be `AS_KNOWN_THEN` renamed.
Hindsight brings *information*, never the *state* the actual decision produced.

### 5. Method, estimability and causal support — three separate statements

- **Method** is `MODEL_COUNTERFACTUAL`: the executable value model's arithmetic
  over the anchor state and the intervention. It is not causal truth and is never
  called that. A causal-inference method can later implement the same interface.
- **Estimability**: `ESTIMATED`, or `NOT_ESTIMABLE` with reasons — an unmodelled
  alternative has no executable representation and HELM will not invent a
  future; a value the model blocks stays blocked.
- **Causal support** is a *separate* judgement of whether the enterprise has
  evidence for the links from what the intervention moves to what is compared,
  read from the Causal Graph **at the world's own lens**: `MODEL_ONLY`,
  `PARTIALLY_SUPPORTED`, `CAUSALLY_SUPPORTED` or `CONTESTED`, per (moved input,
  compared metric) pair, with the claims cited. A claim must be SUPPORTED at the
  lens and APPLY to the case's scope. The known value dependency is shown apart
  and never counted (CALCULATION_DEPENDENCY ≠ CAUSAL_RELATIONSHIP). Even
  `CAUSALLY_SUPPORTED` leaves the number a model result: HELM has no
  identification engine, and says so.

This is why the two lenses differ in support as well as in value: a claim
recorded after the boundary supports the `WITH_HINDSIGHT` world and does not
exist for `AS_KNOWN_THEN`.

### 6. Layers are kept apart

A comparison is four layers per compared metric, never a single delta:

| Layer | Source |
| --- | --- |
| `EXPECTED_AT_COMMITMENT` | what the commitment expected of the chosen alternative |
| `ACTUAL` | what the outcome reviews recorded |
| `ALTERNATIVE_THEN` | the `AS_KNOWN_THEN` world |
| `ALTERNATIVE_WITH_HINDSIGHT` | the `WITH_HINDSIGHT` world |

Only two differences are ever computed, each between layers of the same kind:
*expected vs alternative-then* (both ex ante) and *actual vs alternative-with-
hindsight* (both ex post). A cell HELM cannot fill is `UNAVAILABLE` with a
reason — never estimated. There is no regret figure, no "better", no ranking of
alternatives and no verdict on the decision. Each world states a **model
change** flag when the model has changed since the alternative was first
computed.

### 7. No fake certainty

Wording is fixed: *under model version …, with assumptions …, the estimated
counterfactual value of X is …*. Uncertainty is listed, not a number: input
confidences the model carries, the assumptions and hindsight inputs the estimate
rests on, what the model does not represent (customer response, second-order
effects), and the causal support above. No probability, interval or expected
regret is computed, and `verify:phase-boundary` forbids the words.

### 8. Storage, visibility and time

Three append-only tables (`helm_counterfactual_cases`, `_worlds`, `_reviews`),
database-stamped record time, no client UPDATE or DELETE, row-based read
policies (ADR-0026's lesson). A case is read whole or not at all: its unit
audience, every sensitivity class of the metrics it compares and of what the
intervention moves, and the decision it reviews; worlds and reviews follow their
case. Every read takes the twin's two-time lens: a world or review counts only
from its record time, so "what did we conclude about this alternative in March?"
is a reconstruction.

### 9. The Genome references a review, and never absorbs it

An episode may bind a `COUNTERFACTUAL_CASE` reference (a widening migration adds
the role). It must review **the episode's own decision** and carry only classes
the episode already carries — an episode is read whole, so it can reference only
what its readers may read. The episode view shows counterfactuals in **their own
section**, beside and never inside how management decided or what happened: a
counterfactual does not rewrite either. Historical decisions, commitments and
outcome reviews are never altered.

### 10. What computing a world may write

Creating a world needs a scenario. The counterfactual runtime may create and
execute scenarios **labelled as counterfactual** (metadata and key prefix), as
any scenario author does — a new child of the alternative's scenario, or a new
root — and nothing else below it: no commitment, observation, decision,
authority or causal write, and no rebase or new revision of the alternative's
own scenario. Scenario ≠ Baseline: a counterfactual scenario is never a
baseline and is never bound to a decision.

## Consequences

- HELM can say which alternative world is being evaluated, what differs from
  reality, which historical state anchors it, whether the estimate is merely
  model-based or has causal support, and what uncertainty remains.
- The two lenses stay separable in the data, the API and the screen.
- A counterfactual over an unmodelled alternative is `NOT_ESTIMABLE`, honestly.
- The Genome can point at completed reviews without letting hindsight rewrite an
  episode.

## Alternatives rejected

- **Re-run today's state with the alternative** — double-counts the actual decision.
- **A single "what if" number or a regret score** — see the standing distinction.
- **Letting hindsight inputs be inferred** — HELM would be asserting exogeneity,
  which it cannot know; a person states it, and the record shows who.
- **Storing the comparison** — it is derived; storing it would freeze one
  reading of layers that must stay separable.
- **Automatic counterfactuals for every decision** — HELM would be authoring
  the questions; a review is a person's.
