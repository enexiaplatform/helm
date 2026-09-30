# ADR-0021: The Decision Runtime — what management decided, and what it decided against

**Status** accepted · **Date** 2026-09-23 · **Deciders** Architecture ·
**Phase** 5 · **Depends on** [ADR-0019](0019-scenario-runtime.md),
[ADR-0020](0020-period-identity.md), [ADR-0011](0011-reconcile-decision-and-value-models.md),
[ADR-0008](0008-deterministic-before-ai.md)

## Context

After Phase 4, HELM could compute many futures over one pinned baseline. It
could not say what anybody was deciding. A scenario answers *"what would
happen if"*; it does not answer *"what are we choosing between, on what
grounds, and what did we accept by choosing it?"*

A decision feature is easy to build badly, and the bad shapes are familiar:

1. **`chosenScenarioId`.** A decision becomes a foreign key on a scenario.
   Everything management actually reasoned about — the question, the options
   nobody modelled, the criteria, the dissent — has nowhere to live.
2. **A decision score.** Criteria are weighted, summed and printed as
   "Decision Score 87". The number is arithmetic dressed as judgement: it hides
   which criterion drove it, invents weights nobody stated, and makes the model
   the decider.
3. **An approval workflow.** The decision object becomes a routing slip:
   `pending_approval`, `approved`, `rejected`. What survives is *who signed*,
   not *why*. HELM had exactly this before Phase 5
   (see [decision engine assessment](../archive/decision-engine-assessment.md)).
4. **A copy of the economics.** The alternative stores its own revenue, margin
   and cash figures. They are stale the moment the model moves, and nothing can
   say whether two alternatives were ever computed on the same basis.

Phase 5 had to avoid all four and produce a record a reviewer can still
interrogate in a year.

## Decision

### 1. A decision is a first-class object with one question

`Decision` holds a **management question** — one sentence, interrogative, in
the words of the person deciding — plus its scope, trigger, owner, horizon
(four distinct dates), reversibility and knowledge boundary. It does not hold a
chosen scenario. It does not hold values.

The lifecycle is about **preparation**, not permission:

```
DRAFT → INVESTIGATING → MODELLING → READY_FOR_DECISION → COMMITTED
      → EXECUTING → COMPLETED → REVIEWED          (CANCELLED from any open state)
```

`COMMITTED` is reachable only by committing. There is no `setState` path into
it, in the runtime or in the database.

### 2. Alternatives reference futures; they never contain them

An alternative is `MODELLED`, `UNMODELLED` or `WITHDRAWN`.

- `MODELLED` carries `scenarioId`, `scenarioRevisionId` **and** `scenarioRunId`
  — the exact simulation whose values it is read from. Both the runtime and a
  database CHECK constraint refuse a MODELLED alternative without all three,
  and the guard refuses a run that has not completed, belongs to another
  scenario revision, or belongs to another organization.
- `UNMODELLED` carries no run and **must** say why in prose. "We have no model
  of a second distributor" is a true statement about the enterprise model. An
  alternative full of zeros is a lie about it.

Every number shown against an alternative is read from that alternative's own
`FutureState` at display time. The decision layer stores no economics of its
own, so it cannot disagree with the model.

### 3. Criterion evaluation — facts against stated lines, never a total

A criterion is what management said matters, in one of five styles:

| Style | Meaning | Outcomes it can produce |
| --- | --- | --- |
| `HARD_CONSTRAINT` | a line that must not be crossed | `SATISFIED` / `VIOLATED` |
| `TARGET` | a line management is aiming at | `MEETS_TARGET` / `MISSES_TARGET` |
| `PREFERENCE` | directional, with no line | `STATED` |
| `QUALITATIVE` | judgement a person must author | `ASSESSED` / `NOT_ASSESSED` |
| `OPTIONAL_WEIGHTED` | participates in a weighted view, if one exists | `STATED` |

Evaluation states a fact about a stated line — "30.517% against a target of
35%" — and nothing else. There is no aggregate, no per-alternative total and no
ordering. A criterion HELM cannot evaluate returns `UNKNOWN` **with the reason**
(the metric is BLOCKED, the alternative has no future state, the metric is not
modelled). It never defaults to pass, and it never substitutes zero.

Qualitative criteria are read **only** from authored assessments, each carrying
its author and rationale. With no assessment the answer is `NOT_ASSESSED`; HELM
does not hold opinions about strategic relationships.

**Weights are not mandatory and have no default.** A weighted view is produced
only when management has recorded a `ManagementWeighting` — a named method, a
named author, a rationale — and a database constraint makes a weight storable
only on an `OPTIONAL_WEIGHTED` criterion. Without one, asking for a weighted
view is refused rather than answered with an invented method.

### 4. The trade-off space — differences, never a verdict

Against a reference alternative, every other alternative's criteria are
classified `GAIN`, `CONCESSION`, `SAME` or `UNRESOLVED`, each line carrying the
two values and the exact delta. `UNRESOLVED` is used wherever a comparison
would be dishonest: a blocked metric, an unmodelled alternative, or two futures
that model different periods.

Factual **dominance** is stated where it exists — "under the current model, A is
better than C on every comparable criterion" — always qualified by the model it
holds under, and always followed by the fact that whether it settles anything is
management's call. Dominance is never turned into a ranking, an ordering or a
recommendation, and the canonical decision deliberately commits to an
alternative that dominates nothing.

Comparability is checked, not assumed: alternatives modelled at different
knowledge boundaries produce a stated warning, because the difference between
them mixes the alternative's effect with what was learned in between.

### 5. Readiness — named gaps, never a score

`evaluateReadiness` returns `READY`, `READY_WITH_GAPS` or `NOT_READY` with a
list of gaps, each one a sentence a person can act on. Gaps are `BLOCKING` (no
owner, no alternatives, no criteria, nothing modelled) or `GAP` (an unmodelled
alternative, a partial future state, an unowned critical assumption, an open
challenge, a violated hard constraint, mixed knowledge boundaries).

There is no percentage and no score. Readiness is **procedural completeness
only** and says so in its own statement: it never judges the choice, and a
`READY` decision is not a good decision.

### 6. The commitment — management's, frozen, fingerprinted

Committing does four things atomically:

1. Builds a **commitment snapshot**: every alternative with its scenario
   fingerprint, every criterion, assumption, evidence id and open challenge, and
   the knowledge boundary it was all read at. Fingerprint `dsn_<fnv1a64>_<len>`.
2. Records the **commitment**: the chosen alternative, a summary, structured
   rationale referencing criteria and evidence, explicitly accepted trade-offs
   (what was given up, in favour of what), expected outcomes **read from the
   chosen future state**, review triggers and action intents.
   Fingerprint `dfp_<fnv1a64>_<len>`, deterministic over that content.
3. **Seals** the revision. Its basis is now history.
4. Moves the decision to `COMMITTED`.

`authorship` can only be management-authored; the schema's CHECK does not admit
`HELM`, `SYSTEM` or `AI`. Committing over an open challenge is allowed and
requires an explicit acknowledgement, and the open challenge is recorded in the
frozen manifest — management may decide over disagreement, but not quietly.

After a commitment nothing refreshes. Re-simulating, rebasing or recording new
evidence leaves the manifest and its fingerprint byte-identical; evidence
recorded afterwards is kept and reported separately as evidence the decision
did not have.

### 7. Reconsideration, and what may still be learned

A committed decision is not edited. `reconsider` opens a **new revision** that
links back to the commitment it reconsiders, copies the criteria, assumptions,
challenges and evidence forward, and carries every alternative over as
`UNMODELLED` with the reason "not yet simulated at the new boundary". Nothing
is passed off as simulated when it has not been.

Exactly two things may be written against a sealed revision:

- an **assumption outcome** (`CONFIRMED`, `PARTIALLY_CONFIRMED`, `DISPROVED`,
  `UNKNOWN`), because that is learned afterwards and is the point of having
  written the assumption down;
- an **outcome review**: expected against actual, per expected outcome, with the
  variance stated. It reports; it does not grade.

### 8. Authority is not here

Every decision and every commitment carries `authorityStatus: NOT_EVALUATED`,
pinned by a CHECK constraint in the database as well as by the type. The words
`AUTHORIZED`, `REQUIRES_APPROVAL` and `ESCALATED` do not appear in the schema.

Commitment is not approval. HELM records that a named person committed, on what
grounds; whether they were permitted to is a different question, answered by a
decision-rights model that does not exist yet. Pinning the field now means those
commitments will not have to be rewritten when it does.

### 9. The canonical Meridian decision

One decision is built as data and exercised by every contract: *"How should
Meridian fulfil the Rohto order while balancing service, margin, cash and future
inventory optionality?"* — five alternatives over four computed futures and one
honestly unmodelled, six criteria in four styles, five assumptions (one
deliberately unowned), two challenges (one accepted as risk, one still open at
commitment), four pieces of evidence, and a management-authored commitment to
the alternative that dominates nothing.

It is the same shape as the canonical scenario set and the canonical value
chain: a real decision, with the awkward parts left in.

## Consequences

**Good**

- "Why did we choose this?" resolves to source facts: commitment → rationale →
  criteria → the chosen future → scenario assumptions → calculation traces →
  observations → provenance. Proven by `verify:decision-lineage`.
- A decision cannot silently disagree with the model, because it holds no
  economics of its own.
- The record survives the model moving underneath it, and says which of the two
  it is showing you.
- Nothing in the layer ranks, scores or recommends — enforced by a structural
  walk over the whole workspace, not by intent.

**Costs**

- More writing for the person deciding: a question, criteria, assumptions,
  rationale and accepted trade-offs are all typed by a human. That is the
  intended trade: HELM is preserving reasoning, and reasoning is not derivable.
- Reconsideration re-simulates from scratch. Nothing is inherited as
  still-valid, which is more work and the only honest default.
- Expected-vs-actual is only as good as the metrics the model carries. Where it
  carries none, the outcome review says so rather than inventing one.

**Deliberately absent** — decision authority and approval thresholds, AI
recommendation, ranking or optimization of alternatives, pattern learning across
decisions, causal inference, a universal decision score, and task management.
The phase-boundary contract fails the build if any of them appears.
