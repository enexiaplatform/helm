# ADR-0001: Record architecture decisions

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

HELM is intended to become enterprise management infrastructure with a long
life: an ontology, a value graph, a propagation engine, governance, and a
learning loop. Several of its decisions are expensive to reverse — the tenancy
model, the persistence choice, the graph representation, the Memoire boundary.

The existing codebase demonstrates the problem. It contains genuinely good and
deliberate decisions — reference-plus-snapshot integration, append-only audit,
RLS-in-the-data-layer — recorded only in a single prose document and in code
comments. The *reasoning* survived by luck. A future engineer, or a future
session of this work, could plausibly undo any of them without noticing they
were load-bearing.

## Problem

How does HELM keep architectural intent legible over a long build, across many
sessions, so that decisions are revisited deliberately rather than eroded
accidentally?

## Options considered

1. **Prose architecture document only.** One file, edited as things change. Cheap
   to start; loses history, and "why not the other way?" disappears on first
   edit. This is the current state, and it is already insufficient.
2. **Code comments only.** Close to the code, but invisible at design time and
   unable to record rejected alternatives.
3. **ADRs — one immutable record per decision.** Standard practice; small
   overhead per decision; preserves rejected options and consequences;
   supersession keeps history readable.
4. **ADRs plus executable contracts.** ADRs record intent; `verify:*` scripts
   assert the parts that can be mechanically checked, so drift fails the build
   rather than accumulating.

## Decision

**Option 4.** ADRs in `docs/adr/`, numbered sequentially, in the format in
[README.md](README.md). Where a decision is mechanically checkable, it is paired
with a contract script ([ADR-0010](0010-test-and-contract-strategy.md)).

Rules:

- An ADR is written **before** implementing a foundational change.
- An accepted ADR is not substantively edited; it is superseded.
- Documents that describe *current* architecture link to the ADRs that produced
  it, so the "what" always reaches the "why".
- The brief's §20 list defines what counts as foundational; README.md restates it.

## Consequences

**Good.** Rejected options and their reasons survive. A future change starts from
recorded intent rather than reconstructed guesswork. Pairing with contract tests
means the important half of each decision is enforced, not merely documented.

**Bad.** Overhead per decision. An over-eager reading produces ADRs for trivia —
mitigated by the explicit scope list.

**Risk.** ADRs drift out of date while code moves on. Mitigated by supersession
and by the phase checklist item "architecture docs written or updated".

## Migration implications

None. The pre-existing `docs/architecture.md` is preserved as
[implemented-mvp.md](../architecture/implemented-mvp.md) — an accurate record of
what was built, now positioned as history rather than as the plan. The decisions
it records are restated as ADRs 0003, 0005 and 0011 so they carry forward
explicitly.
