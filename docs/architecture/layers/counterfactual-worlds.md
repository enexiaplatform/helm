# Counterfactual worlds — layer reference

`@helm/counterfactual-runtime` · [ADR-0029](../../adr/0029-counterfactual-worlds.md) ·
migration `20260930120000_helm_counterfactuals.sql` ·
[architecture](../helm-architecture.md) · principle:
[decision quality ≠ outcome quality](../decision-quality-vs-outcome.md)

The question a review asks after an outcome: *what might have happened had we
chosen differently?* — answered without regret, without a single number, and
without letting hindsight stand in for what was knowable.

## What exists

| Object | Meaning |
| --- | --- |
| `CounterfactualCase` | immutable, authored: the decision and commitment reviewed, the question, an explicit **intervention** (`CHOOSE_ALTERNATIVE` or `OVERRIDES`), the **anchor** (a twin snapshot recorded *before* the decision boundary), the metrics compared, scope and the classes those imply |
| `CounterfactualWorld` | one computed world, append-only, for one retrospective lens — `AS_KNOWN_THEN` or `WITH_HINDSIGHT` — with method `MODEL_COUNTERFACTUAL`, boundary, model lineage, assumptions, hindsight inputs, estimability, causal support and uncertainty |
| `CounterfactualComparison` | derived at a lens, never stored: **four layers** — expected at commitment, actual, alternative as known then, alternative with hindsight — and exactly **two named differences**, each between layers of the same kind |
| `CounterfactualReview` | a person's recorded reading of a comparison, pinned to its fingerprint, with required limitations |

Runtime port: `openCase`, `estimate`, `recordReview`, `getCase`, `listCases`,
`compare`, `viewAt`, `projectForViewer`. Stores: in-memory reference and Postgres,
one conformance suite.

## Rules it keeps

- **Anchored in the past.** A case cannot be anchored to a state recorded after the
  decision boundary — the database checks `anchor_recorded <= boundary_recorded`.
- **Two lenses, computed apart.** `AS_KNOWN_THEN` holds no hindsight input;
  `WITH_HINDSIGHT` holds at least one, each with a source, a learned-at *after* the
  boundary and a written exogeneity statement — and neither moves the anchor.
- **Never collapsed.** No probability, score, regret, verdict or interval is stored;
  a reading is worded "a model estimate, not what would have happened".
- **`NOT_ESTIMABLE` invents nothing.** An alternative that was never modelled has no
  numbers and says why; an actual nobody reviewed is `UNAVAILABLE`, not estimated.
- **Causal support is derived at each world's own lens**, per input and metric,
  never from a formula, and carries no number.
- **Read whole.** A case is read only by someone who can read its units, every class
  of what it compares, and the decision it reviews.
- **Below it nothing changes.** Decisions, snapshots, claims, formulas, runs and
  observations are identical after a counterfactual review (`verify:genome-process-outcome`,
  `verify:counterfactual-causal-support`).

## Where it is used

The genome may reference a case by id (`COUNTERFACTUAL_CASE`), which is why this
layer sits *below* the genome. A review binds a case as an item; the AI explains a
case as an estimate; the app shows it at `/counterfactuals`.

## Proof

72 package tests (1 skipped: Postgres conformance) · `verify:counterfactual-schema`,
`-runtime`, `-temporality`, `-causal-support`, `-security` · mutations on the pinned
anchor, the lens split, the estimability rule and the class rule · live migration
applied and proven in a rolled-back server proof with controls.

## Debt

Postgres conformance not run in an isolated environment (blocker B). Interventions
are limited to alternatives the decision recorded and explicit overrides; there is no
multi-step counterfactual and no attempt at causal identification — by design.
