# Intelligence runtime — layer reference

`@helm/intelligence-runtime` · [ADR-0032](../../adr/0032-governed-intelligence-runtime.md) ·
[ADR-0008](../../adr/0008-deterministic-before-ai.md) ·
migration `20260930150000_helm_intelligence_audit.sql` ·
[architecture](../helm-architecture.md)

A provider-neutral, governed reader over the kernel. It retrieves, explains,
compares and drafts; it cannot write enterprise truth.

## What exists

| Part | File | Contract |
| --- | --- | --- |
| Tools | `tools.ts` | 15 `READ_ONLY` domain tools (see the ADR) built by `createGovernedTools` over read facets of each runtime |
| Templates | `templates.ts` | versioned templates: `explain-twin-change`, `summarize-assumptions`, `explain-decision`, `summarize-causal-evidence`, `find-similar-situations`, `explain-counterfactual`, `draft-management-brief`, `ask-helm` |
| Gathering | `gather.ts` | runs a plan (at most 8 calls) through the catalogue, as the caller; refuses what is not a tool, what lacks an argument or has an extra one; says what was `WITHHELD` |
| Grounding | `grounding.ts` | `groundDraft`: classes vs evidence kinds, fabricated figures, recommendations, questions, hypothesis status, counterfactual wording, run-local ids; `RECOMMENDATION` is the one guard that names a recommendation |
| Provider | `provider.ts` | the port (`id`, `model`, `modelVersion`, `synthesize`, optional `plan`) and `createReferenceProvider` — rule-based, no model, no network |
| Runtime | `runtime.ts` | `run(scope, caller, { task, params })`, `listRuns`, `getRun`, `catalogue` |
| Audit | `port.ts`, `inMemoryStore.ts`, `postgres.ts` | `insertRun`, `getRun`, `listRuns`; `helm_ai_runs` is append-only |

Tasks: `EXPLAIN_TWIN_CHANGE`, `SUMMARIZE_ASSUMPTIONS`, `EXPLAIN_DECISION`,
`SUMMARIZE_CAUSAL_EVIDENCE`, `FIND_SIMILAR_SITUATIONS`, `EXPLAIN_COUNTERFACTUAL`,
`DRAFT_MANAGEMENT_BRIEF`, `ASK_HELM`; the council adds `COUNCIL`
([agent-council](agent-council.md)).

## Statement classes

`SOURCE_FACT`, `MODEL_RESULT`, `SCENARIO`, `CAUSAL_CLAIM`, `COUNTERFACTUAL_RESULT`,
`MANAGEMENT_ASSUMPTION`, `MANAGEMENT_RECORD` (all grounded in the kernel), then
`AI_INFERENCE`, `SUGGESTION` and `UNKNOWN`. A
source fact is never stated as a model result nor the reverse; anything the evidence
does not carry is `AI_INFERENCE`, marked qualified.

## The reference provider

Deterministic: it composes statements from the evidence it was handed, caps each section
(five entries per section in a brief, saying how many are omitted), turns unresolved
items into questions ("What would resolve…?") and never expresses a preference. It is
what the demo, the tests and the contracts run on — and it proves the *governance*, not
the quality a language model would add.

## Where it appears

Inside the layers rather than beside them: `/twin` (explain a change), `/decisions/:id`
(assumptions, explanation), `/causal`, `/genome`, `/counterfactuals`, the review brief on
`/reviews`, the Cockpit brief, and Ask HELM. Each panel reads as the viewer.

## Proof

64 package tests (1 skipped) · `verify:intelligence-schema`, `-grounding`, `-governed`
· mutations on the reasoning-trace pin, own-run reads, recommendation removal,
fabricated figures, hypothesis status, catalogue enforcement, plan bounds, decision
visibility and clearance in two tools · live migration proven with controls.

## Debt

No language-model adapter has been exercised. Postgres conformance skipped (blocker B).
Tool results are bounded by design; very large enterprises would need pagination in the
tools, not in the AI.
