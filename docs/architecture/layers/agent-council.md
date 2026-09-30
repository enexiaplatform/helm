# Agent council — layer reference

`@helm/agent-runtime` · [ADR-0033](../../adr/0033-agent-council.md) ·
[architecture](../helm-architecture.md) · builds on
[intelligence-runtime](intelligence-runtime.md)

Several management perspectives over one gathered truth, with disagreement shown and
nothing decided.

## What exists

| Part | File | Contract |
| --- | --- | --- |
| Perspectives | `perspectives.ts` | eight definitions (`COMMERCIAL` `FINANCE` `SUPPLY_CHAIN` `OPERATIONS` `RISK` `STRATEGY` `PEOPLE` `ENTERPRISE_VALUE`), each with words, dimensions, metric keys and a **coverage rule** deciding whether HELM has data for it; `relevantTo(p, evidence)` |
| Council | `council.ts` | `createCouncil({ provider, tools, store, clock }).convene(scope, caller, { question, decisionId?, reviewId?, perspectives? })` — the only method |
| Composer | `provider.ts` | `createReferencePerspectiveProvider` — rule-based; a language-model composer implements the same port |
| Types | `types.ts` | `PerspectiveOutput` (sections `OBSERVATIONS`, `CONCERNS`, `CHALLENGED_ASSUMPTIONS`, `TRADE_OFFS`, plus supporting evidence, unknowns, questions, grounding), `Tension`, `CouncilResult` |

## What `convene` returns

`perspectives` (canonical order), `notInstantiated` (People, with its reason — and
any perspective the data does not support), `silent` (supported but nothing relevant),
`evidence` (the one pool), `sharedEvidence`, `tensions`, `missingEvidence`,
`orchestratorRunId`, `accountable: 'HUMAN_MANAGEMENT'` and a notice that the council
"does not vote, rank, weigh or choose". Nothing in it is named consensus, vote, score,
rank, weight, preference, recommendation or verdict — at any depth.

## Behaviour worth knowing

- The evidence is gathered **once**, as the caller, through the governed tools; a caller
  without clearance or decision visibility is handed less and told what was not read.
- A perspective is grounded against **its own subset**; a perspective that recommends
  or invents a figure is held to `groundDraft`.
- A tension exists only where an alternative gains for one perspective and concedes for
  another; both sides are shown with their lines and *"nothing is netted"*.
- Every perspective and the orchestrator write a `helm_ai_runs` record; the
  orchestrator makes no statement of its own.

## Proof

20 package tests · `verify:council` · mutations on People never being spoken for, tensions
never netted, and a perspective seeing only its own subset · `verify:boundaries` fails
on any vote, tally, consensus, negotiation or debate function.

## Debt

The composer is rule-based; the council has not been exercised with a language model. No
perspective for People exists until HELM holds people data — and the design forbids
scoring or ranking a person even then.
