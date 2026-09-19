# ADR-0008: Deterministic engines before AI; AI behind a grounded, vendor-neutral port

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

The brief requires deterministic engines before AI (§8), an LLM provider
abstraction (§9), grounding for every AI recommendation (§4), and that HELM never
present hallucinated business facts as truth.

The existing build is already fully deterministic, deliberately: eight pure
engines, no LLM anywhere. Memoire goes further and enforces AI-freedom with a
`verify:no-ai` script. The ecosystem's trust posture is explicit and consistent.

The pressure to invert this is real and will arrive early. An LLM can produce a
plausible management narrative on day one, while a propagation engine takes three
phases. The plausible narrative is also worthless for management decisions,
because a number a manager cannot audit is a number they cannot defend to a board
— and one they should not act on.

## Problem

How is AI introduced so it adds interpretation without ever becoming the source of
a business fact, and without coupling HELM to one vendor?

## Options considered

1. **AI-first.** LLM reads source data and answers management questions. Fast to
   demo, structurally unable to satisfy §17 auditability or §18 explainability. A
   number with no formula behind it cannot produce source, inputs, assumptions and
   confidence, because it never had them.
2. **AI as a thin narration layer over deterministic results.** All numbers from
   engines; AI phrases them. Safe and useful, but underuses the model — it cannot
   generate options, critique assumptions, or find non-obvious relationships.
3. **Deterministic kernel, AI runtime above it, single interface for both.** Every
   quantitative claim comes from a registered calculation. AI operates on kernel
   context to summarize, explain, generate candidate options, critique, retrieve
   lessons and synthesize debate. Probabilistic and ML methods enter later *as
   calculation kinds*, behind the same `Calculation` contract.
4. **Two parallel systems**, deterministic and AI, with users choosing. Two truths,
   no reconciliation. Worst option.

## Decision

**Option 3.**

### Layering

- **Layer 2 (kernel) contains no AI.** `verify:no-ai-in-kernel` asserts that no
  kernel package imports an LLM client or model SDK. This mirrors Memoire's
  `verify:no-ai` and is the load-bearing guard.
- **Layer 3 (Intelligence Runtime) may use AI**, only through the `LlmProvider`
  port ([kernel-interfaces.md §8](../architecture/kernel-interfaces.md#8-llm-provider-port-phase-11)).
  No vendor SDK appears outside its adapter.

### The grounding contract

An AI call receives a `GroundedContext` assembled **by the kernel**, under the
principal's scope. It contains entities, observations, explanations, assumptions
and lessons — each with an id.

**A response citing an id absent from its context is rejected by the runtime, not
flagged.** A rejection is a bug report; a warning is a habit users learn to
ignore. This single mechanical rule is what makes "never present hallucinated
business facts as truth" enforceable rather than aspirational.

### Division of labour

| AI may | AI may not |
| --- | --- |
| Summarize signals and changes | Produce a number that is not from a calculation |
| Explain a computed chain in prose | Assert a business fact absent from its context |
| Generate *candidate* options for human review | Approve a decision |
| Critique assumptions and surface missing ones | Change a decision's state |
| Retrieve and relate historical lessons | Write to the ontology or value graph |
| Synthesize a multi-agent debate | Be the last step before an irreversible action |

### Probabilistic methods are calculations, not AI

Monte Carlo, optimisation and ML predictions arrive as `expression_kind` values on
`helm_calculations`, implementing the same `Calculation` interface with the same
mandatory `trace`. A Monte Carlo result still reports its inputs, its method and
its confidence interval. This is why the interface requires `trace` unconditionally
rather than making it optional for "complex" methods — there is no such exemption.

### Every AI output carries

Data used · assumptions · reasoning summary · uncertainty · affected entities ·
expected value impact · risks · provenance. Missing any of these is a failed
response, not a degraded one.

## Consequences

**Good.** Auditability survives the arrival of AI. Vendor swaps are adapter work.
Determinism remains the default, so a failure in the AI layer degrades
explanation, never correctness. Probabilistic sophistication has a defined path in
that does not require loosening the contract.

**Bad.** Slower to a compelling demo. Grounded context assembly is real
engineering — retrieval, scope filtering, token budgeting. Citation validation
rejects some responses that a human would have judged acceptable.

**Risk — pressure to skip to Phase 11.** Mitigation: the phase gates in
[roadmap.md](../architecture/roadmap.md), and the fact that grounding is
impossible before Phase 3 exists. There is nothing to ground against.

**Risk — the runtime becomes a bypass.** Someone lets an agent write to the graph
"just for convenience". Mitigation: agents receive read-only context objects;
writes go through kernel commands that require an actor and record an event.

## Migration implications

- No change now. HELM stays AI-free through Phase 10.
- Phase 3's `Calculation` interface is designed with `expression_kind` from the
  start, so Monte Carlo needs no contract change later.
- Phase 11 adds `packages/agent-runtime` with the `LlmProvider` port and at least
  two adapters, so vendor-neutrality is tested rather than assumed — the same
  two-adapter discipline as [ADR-0004](0004-graph-abstraction-layer.md).
- Phase 11 requires an API service for provider keys: trigger 1 in
  [ADR-0003](0003-supabase-postgres-system-of-record.md). A provider key must
  never reach a client bundle.
- AI access controls
  ([security-model.md §5](../architecture/security-model.md#5-ai-access-controls-must-precede-phase-11))
  must exist before the first AI call, not after.
