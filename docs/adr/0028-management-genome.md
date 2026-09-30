# ADR-0028: The Management Genome — organizational memory of situations, beliefs, choices and outcomes

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Phase** 9 · **Depends on** [ADR-0021](0021-decision-runtime.md),
[ADR-0023](0023-management-digital-twin.md), [ADR-0026](0026-enterprise-causal-graph.md),
[ADR-0027](0027-causal-evidence-policy.md) ·
`docs/architecture/decision-quality-vs-outcome.md`

## Context

HELM can now say what the enterprise decided, on what grounds, who had
authority, what happened, and what it believes caused it. Each of those is one
record in one layer. What HELM cannot do is answer the question a management
team actually asks before a hard call: *have we been here before — what did we
believe, what did we choose, what happened, and does a pattern show?*

There are familiar ways to build this badly:

1. **A knowledge base.** Meeting notes and post-mortems as text. Unstructured,
   unqueryable, and it copies what the kernel already holds.
2. **A performance ledger.** Aggregate outcomes per manager, or a "decision
   quality score". Punishes good decisions that met bad luck, rewards lucky
   ones, and turns organizational learning into personnel rating.
3. **AI memory.** A model summarizes history into "insights". Ungrounded,
   unreproducible, and confuses interpretation with the enterprise's own record.
4. **Universal laws.** "Expediting always overruns cost" from three cases.

## Decision

### 1. An episode is a durable container around ONE management experience

`ManagementEpisode` binds, **by reference** to immutable artifacts, everything
that experience produced: the decision and its commitment, the twin snapshot
before the decision, the committed future, the actual-state snapshot, the causal
beliefs held, the governance evaluation, the outcome reviews. It duplicates
none of them. Its own identity is small and immutable: the decision it wraps,
its title, its **situation features** (§2) and the **decision boundary** (the
knowledge boundary at which management decided). References are appended as
they arrive — an episode opens at commitment and gains its outcome later.

### 2. Situation is structured, not embedded

Similarity is defined over explicit features, derived from kernel records at
the decision boundary: decision type, scope placement (org-chain coordinates,
so "within Vietnam Pharma" is checkable), trigger type, reversibility,
constraint kinds the chosen future faced, the metrics the commitment expects to
move, the metrics the chosen scenario overrides, and the customer
classifications in scope. `findSimilar` takes the features a caller **requires**
to agree and returns every episode that agrees on them, chronologically, with
each feature's agreement shown. It returns no similarity score and no ordering
by resemblance. **Absence of information is not similarity**: a feature the
situation does not state (`notStated`) agrees with nothing, and the answer lists
it in `unstatedInTarget` and says an empty result then means "cannot tell", not
"nothing like it". An embedding index may one day *supplement* this; it may never
define similarity. A situation may only be read from a snapshot known at the
decision boundary; a later snapshot is hindsight and is refused as the situation
(`genome.hindsight_as_situation`).

### 3. Decision process and outcome are two sections, permanently apart

An episode view has a **process** section (alternatives considered and how many
were modelled, criteria, assumptions with owners and criticality, challenges and
whether they were open at commitment, evidence, dissent preserved) and an
**outcome** section (expected against actual, assumption results, intent status,
governance state, trajectory). There is no combined field and no quality score:
a good process can meet a bad outcome and a poor one can get lucky
(Decision Quality ≠ Outcome Quality). `verify:phase-boundary` forbids the words.

### 4. Hindsight never rewrites the decision

An episode's causal beliefs are read at two lenses and shown apart: **at the
decision** (claims known at the decision boundary) and **since** (claims
recorded later). In the Rohto episode no fulfilment-cost claim existed on the
day of the decision; they arrived in January. The episode says so.

### 5. A pattern is a checkable hypothesis, never a law

`ManagementPattern` = **conditions** (situation features that must hold, so its
scope is explicit) + a **characteristic** (one of three observable kinds:
`OUTCOME_VS_EXPECTATION` — a metric landed below/above/at its committed value;
`ASSUMPTION_OUTCOME` — an assumption of a given criticality was
disproved/confirmed; `PROCESS_FEATURE` — e.g. a critical assumption had no owner
at commitment) + a **statement** and **limitations** (both required). Patterns
are revised append-only and retired, never edited.

Because conditions and characteristic are structured, HELM can **classify** any
episode against a pattern from its own records: `SUPPORTS` (in scope, shows the
characteristic), `CONTRADICTS` (in scope, observable, does not show it),
`OUT_OF_SCOPE`, or `NOT_OBSERVABLE` (no outcome yet). A person links an episode
to a pattern as SUPPORTING, CONTRADICTORY or CONTEXTUAL, and **the link must be
consistent with the classification**: HELM refuses to record support for an
episode its own records contradict, or outside the pattern's scope, or with no
outcome yet. HELM never links an episode itself.

### 6. Pattern status is a policy over recurrence — `helm-genome-pattern@1`

Derived at a lens, never stored, with reasons and **coverage** (how many
recorded episodes match the conditions, how many are linked, which matching
episodes nobody has linked):

| Condition | Status |
| --- | --- |
| retired | RETIRED |
| any linked CONTRADICTORY episode | CONTESTED |
| ≥ 3 SUPPORTING episodes of distinct decisions, across ≥ 2 contexts, no contradiction | SUPPORTED |
| ≥ 2 SUPPORTING episodes of distinct decisions, no contradiction | RECURRING |
| otherwise | EMERGING — one case or none is labelled weak |

A *context* is what the episode was about (its scope anchors); three episodes in
one context stay RECURRING. Two episodes of the same decision are one case. A
contradictory episode is never outvoted: CONTESTED holds however many episodes
support the pattern.

Recurrence is what a pattern *is*, so counting is inherent here, unlike causal
evidence (ADR-0027); that is why the thresholds are stated, named and
versioned, and why every status carries the limitation that episodes are the
ones **recorded** — the enterprise's memory, not the enterprise's whole
history. No probability is computed.

### 7. Lessons are authored, reviewed, and inert

A `Lesson` is a management-authored claim with a scope, at least one evidence
reference (an episode or a pattern), an author and a record time. Its review
status (PROPOSED → ENDORSED / DISPUTED / RETIRED) is derived from append-only
reviews; **an author cannot endorse their own lesson**. A lesson changes no
policy, calculation, causal claim or authority rule; nothing consumes it
automatically.

### 8. No person is rated

Situation features and pattern conditions have no person dimension; nothing
aggregates by committer, owner or reviewer; there is no per-manager view. The
Genome learns how the *organization* meets situations.

### 9. Storage, visibility and time

Seven append-only tables, database-stamped record time, no client UPDATE or
DELETE, row-based read policies (ADR-0026 lesson). A pattern or lesson is read
whole or not at all: its unit audience, the classes it carries, and every
episode (hence every decision) it rests on. Every read takes the twin's
two-time lens: an episode, a link or a review counts only from the moment it was
recorded, so "what did we know about this pattern in March?" is a
reconstruction.

### 10. What Phase 9 leaves open on purpose

The reference role `COUNTERFACTUAL_CASE` is not in the vocabulary yet: it
belongs to Phase 10 and will be added by a widening migration when there is a
counterfactual to point at. Two independent layers hold the "a stance agrees
with what HELM observed" invariant (the runtime policy and the store; the
database repeats it as a CHECK), so removing one does not silently remove the
guarantee — the mutation suite breaks both to prove the contract notices.

## Consequences

- HELM can answer "have we seen this before?" from structured records, with
  the reasoning shown and the limitations stated.
- Patterns are hypotheses a person owns; HELM verifies they are consistent with
  the episodes but does not discover them.
- The Genome is only as complete as the episodes recorded; coverage says so.
- No AI pattern generation, counterfactual (Phase 10), recommendation,
  employee ranking or automatic policy change.

## Alternatives rejected

- **Embeddings as similarity** — unexplainable; may supplement, never define.
- **A decision-quality score** — see the standing distinction.
- **Auto-discovered patterns** — HELM would be presenting its own inference as
  the enterprise's memory (AI interpretation ≠ enterprise truth).
- **One combined episode outcome field** — erases process vs outcome.
