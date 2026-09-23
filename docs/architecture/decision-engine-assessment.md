# The legacy Decision Engine: KEEP / ADAPT / MIGRATE / RETIRE

**Phase 5** · Companion to [ADR-0021](../adr/0021-decision-runtime.md)

Before Phase 5, HELM already had something called a decision engine. It was the
original product: `helm_decisions` with an eight-state status column, a decision
state machine, approval rules with thresholds, alternatives carrying their own
financial lines, a relevant-cost evaluator, a decision-memory pattern detector,
and a five-tab decision detail page.

The Phase 5 brief required an explicit assessment — **"the old engine must not
remain a parallel decision model"** — rather than a quiet rewrite. This is it.

## What the legacy engine actually was

**An approval workflow with a relevant-cost calculator attached.**

A `Decision` carried a free-text `recommendation`, a `decidedAlternativeId`, a
`decisionRationale` string, an `expectedMetrics` JSON array, an `outcomeScore`
of `better | as_expected | worse`, and a status that moved
`draft → analyzing → pending_approval → approved → executing → monitoring → closed`.
An `ApprovalRule` said that decisions of a given type above a given amount
required a manager or an admin. A `DecisionAlternative` held `financialLines`
(incremental revenue, relevant cost, opportunity cost, sunk-ignored,
allocated-ignored), free text for qualitative, strategic and risk, and a boolean
`isRecommended`.

It was competent at what it did — the relevant-cost logic is genuine managerial
accounting, and the state machine was honest about its transitions. What it was
not:

| Property Phase 5 needs | Legacy engine |
| --- | --- |
| Records **what is being decided** | Records a title and a decision *type* |
| Alternatives reference computed futures | Alternatives hold hand-entered financial lines |
| Criteria are explicit and evaluated as facts | No criteria; a free-text recommendation instead |
| Assumptions have owners and outcomes | `sensitivity` + `validated`, no owner |
| Disagreement is preserved | Nowhere to record it |
| Evidence is first-class | `contextSnapshot` JSON blob |
| Readiness is named gaps | No concept |
| Commitment is frozen and fingerprinted | `approved_at` plus mutable rows |
| Commitment ≠ approval | Commitment **is** approval, by construction |
| Nothing recommends | `recommendation`, `isRecommended` |

The last two are the reason this could not be an incremental upgrade. The legacy
model's centre of gravity is *permission*: its most important states are
`pending_approval`, `approved` and `rejected`, and its most important field is
`approved_by`. Phase 5's centre of gravity is *reasoning*, and Phase 5 is
explicitly **not** the authority system. The two models disagree about what a
decision is for.

## The assessment

| Part | Verdict | What happened |
| --- | --- | --- |
| `helm_decisions` **table** | **MIGRATE** | Extended in place. New columns: `management_question`, `kernel_state`, `trigger_type`, `trigger_refs`, the four horizon dates, `reversibility`, `reversal_window_days`, `knowledge_boundary`, `effective_as_of`, `authority_status`. A row is a kernel decision exactly when it has a management question and a knowledge boundary (`helm_decisions_kernel_coherent`); legacy rows have neither and keep their own rules. Nothing dropped. |
| `helm_decision_alternatives` | **MIGRATE** | Extended with `revision_id`, `status`, `scenario_id`, `scenario_revision_id`, `scenario_run_id`, `unmodelled_reason`, plus a coherence constraint and a guard that refuses an incomplete, still-running or foreign simulation. `financial_lines` and `is_recommended` retained and `COMMENT`-marked RETIRED. |
| `helm_decision_assumptions` | **MIGRATE** | Extended with `revision_id`, `owner_id`/`owner_label`, `criticality`, `confidence`, `source`, `outcome`, `outcome_note`. `sensitivity` and `validated` retained and marked RETIRED. |
| `helm_decision_events` | **KEEP** | Already append-only since Phase 1 (SELECT + INSERT policies only). Adopted unchanged as the kernel decision timeline; it took the same RLS `auth.uid()` hoist Phases 2 and 4 applied elsewhere. |
| `helm_actions` | **MIGRATE** | Extended into action intents: `revision_id`, `commitment_id`, `target_system`, `intent_status`. The `writeback` column is retained and marked RETIRED — HELM no longer writes into another system. |
| `helm_approval_rules` **table** | **KEEP (unused)** | Left exactly as it is, with no kernel rows and no kernel reader. Approval thresholds are an authority concept; Phase 6 decides whether this table is the right shape for one. Deleting it now would destroy a design input and any rows a tenant has. |
| `src/domain/decisionStates.ts` | **RETIRE** | Deleted with its test. `canTransition`/`requiresApproval` encode approval routing, which Phase 5 must not have. The kernel's `decisionTransitions` replaces the lifecycle half; the authority half has no replacement *by design*. |
| `DecisionStatus`, `decisionStatusLabels` | **RETIRE** | Deleted. `legacyStateMapping` in the kernel maps the six lifecycle statuses to kernel states and maps `pending_approval`, `approved` and `rejected` to **null**, deliberately: they are authority states and have no kernel equivalent. |
| `src/domain/engines/decisionMemory.ts` | **RETIRE** | Deleted with its tests. It detected patterns across closed decisions (`MEM-OPTIMISM`, systematic under-delivery by decision type). Phase 5 **preserves the material** a Management Genome will need and explicitly does not learn from it (brief §36); a detector that runs today would be learning from three sample decisions. |
| `relevantCost.ts` → `evaluateAlternative`, `rankAlternatives` | **RETIRE** | Deleted. They computed a net figure per alternative and ordered them, which is precisely the ranking Phase 5 forbids. |
| `relevantCost.ts` → `allocationTrap` | **KEEP** | Untouched. It is a costing check used by the Economics surface and the signal rules; it was never part of the decision engine. |
| `ApprovalRule`, `DecisionAction`, `DecisionEvent`, `FinancialLine`, `ExpectedMetric`, `OutcomeScore` types | **RETIRE** | Deleted from `src/domain/types.ts`, along with their demo data, mappers and store slices. The kernel types carry an author, a rationale, a confidence and a provenance where these carried none. |
| `decisionTypes` / `DecisionType` / `decisionTypeLabels` | **KEEP** | A decision *category* is still useful vocabulary and is not a judgement. The kernel does not require one. |
| `DecisionsPage` | **ADAPT** (route kept, contents replaced) | Same route, same navigation slot. It now lists management questions and preparation states read through `DecisionRuntime`. |
| `DecisionDetailPage` | **ADAPT** (route kept, contents replaced) | `/decisions/:id` is now the Decision Workspace. The five legacy tabs (Analysis, Alternatives, Assumptions, Approval, Outcome) are gone; the workspace is one page because a decision is one argument. |
| `MemoryPage` | **ADAPT** | Now reads kernel commitments and outcome reviews. It shows the record and detects nothing (see [decision quality vs outcome quality](decision-quality-vs-outcome.md)). |
| `AttentionPage` "Open decision" button | **ADAPT** | Now "Frame a decision": it opens a modal that asks for the management question and creates a kernel decision with `triggerType: 'SIGNAL'` and the signal as a trigger reference. A signal is not a decision, and HELM will not write the question for you. |
| `SettingsPage` approval-rules panel | **RETIRE** | Replaced by a "Decision authority" panel stating that `authorityStatus` is `NOT_EVALUATED` and that decision rights belong to the authority model. |
| `writebackDecisionToMemoire` | **RETIRE** | Deleted. It wrote a `commercial_events` row into Memoire when a decision was approved. Phase 5 writes nothing outward; a commitment produces **action intents** naming the system that should act, and `DecisionCommittedEvent` defines what a connector would carry. |
| `listMemoireOpportunities` | **KEEP** | The read side of the Memoire bridge is unchanged and still one-way. |

## Why not keep both

A parallel model would have been cheap for a week and expensive forever. Two
decision objects means two answers to "what did we decide", two timelines, two
sets of RLS policies and an unanswerable question every time they disagree.
More concretely, the legacy model would have kept `recommendation` and
`isRecommended` alive in the UI — the exact thing the Phase 5 boundary contract
fails the build over.

What was kept is what cannot be recovered: **columns and rows**. Every legacy
column still exists, is still readable, and is commented with what replaced it.
What was removed is **code with no kernel meaning**: the approval state machine,
the ranking functions, the pattern detector, the write-back.

## What a reader should check

- `npm run verify:phase-boundary` fails if `recommendBest`, `decisionScore`,
  `autoApprove`, `authorityThreshold`, `optimizeAlternatives`, `counterfactual`
  or `agentDebate` appears anywhere in the source.
- `npm run verify:decision-schema` asserts the Phase 5 migration is additive,
  that the retired columns are still present, and that `AUTHORIZED`,
  `REQUIRES_APPROVAL` and `ESCALATED` are not storable.
- `grep -rn "domain/decisionStates\|decisionMemory\|rankAlternatives" src/`
  returns nothing.
- `git show <phase-4-commit>:src/domain/decisionStates.ts` still shows the old
  state machine. Nothing was rewritten out of history.
