# ADR-0032: The intelligence runtime — a governed, provider-neutral reader that cannot write enterprise truth

**Status** accepted · **Date** 2026-09-30 · **Deciders** Architecture ·
**Depends on** [ADR-0008](0008-deterministic-before-ai.md),
[ADR-0025](0025-sensitivity-and-scenario-visibility.md),
[ADR-0026](0026-enterprise-causal-graph.md),
[ADR-0027](0027-causal-evidence-policy.md),
[ADR-0029](0029-counterfactual-worlds.md), [ADR-0031](0031-management-reviews.md)

## Context

[ADR-0008](0008-deterministic-before-ai.md) put deterministic engines first and
promised an AI layer behind a grounded, vendor-neutral port. The kernel now
exists, so the promise can be kept. The failure modes are specific:

1. **An AI that queries the database.** It sees whatever the connection sees, not
   what the *person asking* may see.
2. **Fluent fabrication.** A number no tool returned, a hypothesis stated as fact,
   a model estimate stated as a source fact.
3. **A recommendation in disguise.** "The best option is…", "management should
   approve…" — HELM never recommends.
4. **A write path.** An AI that can call `commit` is an automated management act.
5. **An audit trail that holds the model's reasoning**, which is unreviewable,
   vendor-specific and not enterprise truth.

## Decision

### 1. Interpretation is not enterprise truth

Everything the AI produces is *interpretation*: statements, questions and
unknowns, each classed and grounded. It is stored as an audit record, not as a
fact, and nothing in the kernel ever reads it back as one. Every answer carries
the notice that it is not enterprise truth.

### 2. Tools are domain interfaces, and read-only

The AI reads HELM through a catalogue of **fifteen governed tools** —
`getEnterpriseState`, `getManagementAttention`, `getDataCoverage`,
`compareTwinSnapshots`, `explainValue`, `getValueDependencies`,
`getScenarioComparison`, `getDecision`, `explainDecision`, `getGovernanceState`,
`getCausalClaims`, `getGenomePatterns`, `getSimilarEpisodes`, `runCounterfactual`
(reads a stored case), `getReviewPack`. Every tool is `access: 'READ_ONLY'`; none
is named for a query or a write; a plan naming anything else (a query, an
approval, a listing of tables), missing an argument or adding one is **refused and
audited**. A plan is bounded at eight calls and says when it was cut.

### 3. It reads as the caller

Each tool receives the caller — their clearance, their units, which decisions they
may see — and uses each layer's **own** projection: a value above the clearance of
the caller is not returned, evidence resting on a decision they cannot see is
withheld, a review they may not read is not read for them. What is withheld is
**said** (`unknowns`, `WITHHELD` tool outcomes), never silently dropped. The
provider is handed **plain JSON** — no function, runtime, store or client — so
there is nothing to write with.

### 4. Grounding is enforced by the runtime, not trusted

A provider returns a draft; `groundDraft` decides what survives:

- every enterprise statement has a **class** (`SOURCE_FACT`, `MODEL_RESULT`, `SCENARIO`,
  `MANAGEMENT_ASSUMPTION`, `CAUSAL_CLAIM`, `COUNTERFACTUAL_RESULT`, …) that must
  agree with the kind of the evidence it cites; a wrong class is **reclassified**,
  a mixed one **downgraded to `AI_INFERENCE`**;
- a **figure** that appears in no cited evidence is a fabricated number — the
  statement is **removed**;
- a **recommendation** is removed however it is classed; a `SUGGESTION` must be a
  question or an evidence request;
- an unsupported claim is marked `AI_INFERENCE`, qualified;
- a hypothesis stated as fact is **downgraded** (a causal claim keeps the status
  its evidence carries); a counterfactual not worded as an estimate is downgraded;
- evidence ids are **local to a run**, so borrowed evidence is not evidence.

The report says what was removed and why.

### 5. Provider-neutral, no vendor in the runtime

The provider is `{ id, model, modelVersion, synthesize, plan? }`. A deterministic
**reference provider** (no model, no network) ships and is what the tests, the
demo and the contracts run on; a language-model adapter implements the same port
and is composed at the edge. No source file in the runtime names a vendor
(`verify:intelligence-governed`).

### 6. The audit cannot hold a reasoning trace

`helm_ai_runs` is append-only and stores: who asked, the task, the template and
version, the **hash** of what was asked, the provider identity, the tool calls,
the evidence references, the grounding report, and an output that is *exactly*
`statements`, `questions`, `unknowns` (schema-enforced), plus counts and a
fingerprint. A provider that returns `reasoning` or `thoughts` has them discarded
before storage. A person reads their own runs; an admin reads all. A failed
provider call is still audited.

## Consequences

- Running every AI task leaves decisions, commitments, snapshots, claims, episodes,
  cases, reviews and observations **byte-identical** — asserted, not promised.
- The AI is useful *inside* the layers (explain a twin change, summarize
  assumptions, explain a decision, summarize causal evidence, find similar
  situations, explain a counterfactual, draft a review brief) and through Ask HELM,
  and it is never a place management goes to be told what to do.
- A real language-model provider has **not** been exercised: the reference
  provider proves the governance, not the model's quality.

## Alternatives rejected

- **Text-to-SQL.** Rejected: it reads as the connection, not as the caller.
- **Trusting the prompt to forbid recommendations.** Rejected: a prompt is a
  request; `groundDraft` is a guarantee.
- **Storing the chain of thought "for debugging".** Rejected: the schema has no
  place for it, on purpose.
