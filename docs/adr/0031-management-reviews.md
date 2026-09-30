# ADR-0031: Management reviews — the operating cadence as a pack of references

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Depends on** [ADR-0014](0014-bitemporal-lite.md),
[ADR-0021](0021-decision-runtime.md), [ADR-0023](0023-management-digital-twin.md),
[ADR-0025](0025-sensitivity-and-scenario-visibility.md),
[ADR-0028](0028-management-genome.md), [ADR-0029](0029-counterfactual-worlds.md)

## Context

Management runs on a cadence: a weekly look, a monthly review, a quarterly
business review, a strategic session. Every kernel layer answers one question
about the enterprise; the review is where a team asks *all* of them together,
records what it did, and carries what is unfinished to the next one.

The usual way to build this is meeting-notes software: an agenda, minutes, action
items, attendees. It would give HELM a second, hand-typed account of the
enterprise that immediately disagrees with the first — and make a review something
a person can rewrite after the fact.

## Decision

### 1. A review binds; it does not decide, and it owns one thing

A **`ManagementReview`** has a cadence (`WEEKLY`, `MONTHLY`, `QUARTERLY`,
`STRATEGIC`), a scope, a period label, an **opening twin snapshot** (two times,
[ADR-0014](0014-bitemporal-lite.md)) and the **fingerprint of its preparation
pack**. Its **items** are *references* to objects that already exist — an
attention item, a decision, a commitment, an assumption, an action intent, an
episode, a pattern, a lesson, a counterfactual case, a causal claim. The one
thing a review owns is a **`QUESTION`**: a sentence someone raised. Recording that
management *committed* in a review is a reference to a commitment the decision
runtime made earlier; the review commits nothing. A role must fit its kind (only
a commitment is `COMMITTED`; only a decision is `FRAMED` or `RECONSIDERED`).

### 2. The pack is computed, never stored as truth

`prepare` composes what changed since the previous review **closed**, what
matters, what is off-track (expected against actual, current against the
committed future), what is uncertain, what decisions are required, which
assumptions are challenged, which outcomes arrived, and what memory the genome
and counterfactual layers hold — all read from the kernel **at the review's own
lens**. Nothing is ranked, weighted or totalled, and a layer that is not
connected is listed under `unavailable` rather than shown empty. `unavailable` is
not part of the fingerprint: connecting a source later must not rewrite a closed
review.

### 3. Closing leaves nothing hanging

`closeReview` requires **exactly one disposition per item** — `RESOLVED`,
`CARRIED_FORWARD` or `DROPPED` — each with a reason, and stores a closing
snapshot and the closing pack fingerprint. A closed review is memory: it takes no
more items and cannot be closed twice.

### 4. Carry-forward is by reference

The next review of the same scope follows a **closed** review (the schema and the
runtime both refuse otherwise) and inherits what was carried forward as the **same
references**, tagged with the item they came from — never a copy. It is prepared
with the change *since the previous closing state*, not since "last time".

### 5. A closed review is reproducible

`reproduce` recomputes the pack from the kernel at the review's own lens and
compares fingerprints. A later outcome review, decision or claim cannot change
what a closed review said management saw: this is asserted after recording a
terrible outcome long after both canonical reviews closed
(`verify:review-runtime`). Read at a lens before it closed, a review is `OPEN`;
before it opened, it is not known.

### 6. Read whole or not at all

A review's sensitivity classes are those of its **opening snapshot**, so one
restricted item withholds the whole review from a viewer who is not cleared, and
its unit audience follows its grants. An item that rests on a decision the viewer
cannot see is withheld from a review they can read, and `preparedFor` says how much
was withheld while keeping the pack's fingerprint. Visibility is not authority.
The policies are **row-based** (`review_row_visible`) so `INSERT … RETURNING`
works; the by-id helper is used only by *other* tables' policies.

## Consequences

- The canonical proof is two reviews: Review 1 is lived inside the twin story
  (the issue appears; management sees, explores, decides, commits, governs);
  Review 2 comes after the outcome, the causal claims, the genome and the
  counterfactual review.
- There is no agenda, no minutes, no attendee list and no person view: a review
  cannot become a way to compare managers.
- The Postgres review store is proven by contract and a rolled-back live proof;
  its conformance suite is **skipped**, not passed (deployment gate, blocker B).

## Alternatives rejected

- **Meeting-notes objects.** Rejected: a second account of the enterprise.
- **Storing the pack.** Rejected: a stored pack can be edited; a fingerprint of a
  computed pack cannot be reproduced falsely.
- **Copying items on carry-forward.** Rejected: the copy drifts from the object.
