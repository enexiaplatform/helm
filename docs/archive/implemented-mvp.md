# HELM — Implemented MVP (Architecture Record, 2026-08-08)

> **Archive.** This describes the pre-kernel application, which has been retired: the engines, pages and tables it discusses were replaced by the layers in [the architecture](../architecture/helm-architecture.md). It is kept as history and is not a description of HELM today.

> **Historical record.** This documents the decision-workspace build as it
> shipped on 2026-08-08, under HELM's earlier positioning as a "managerial
> decision operating system". Everything described here is implemented and still
> running.
>
> It is **not** the current plan. HELM's architecture was restated in Phase 0
> (2026-09-19) as enterprise management infrastructure — see
> [helm-architecture.md](../architecture/helm-architecture.md),
> [domain-model.md](../architecture/domain-model.md) and [roadmap.md](../architecture/roadmap.md). The decisions
> recorded below that carry forward are restated as
> [ADR-0003](../adr/0003-supabase-postgres-system-of-record.md),
> [ADR-0005](../adr/0005-namespace-all-helm-tables.md) and
> [ADR-0011](../adr/0011-reconcile-decision-and-value-models.md).
>
> Per [ADR-0001](../adr/0001-record-architecture-decisions.md), this file is not
> rewritten as the model evolves. It is history.

HELM is the **system of decision** for managers, sharing one database and one
identity system with Memoire (the **system of record** for commercial work).
This document records what was found during discovery, the decisions taken, and
why. It is a record, not a plan — everything here is implemented.

## 1. What discovery found (2026-08-08)

- Memoire is a **single-user** product. Every table carries `user_id` and RLS
  `auth.uid() = user_id`. There are no organization, team, or role tables.
  The Commercial Kernel (`src/domain/commercialKernel/types.ts`) deliberately
  passes a `scope` object into every domain rule so a workspace dimension can
  be added later — that seam is what HELM uses.
- The shared Supabase project (`mlmpcpkucurylkrobain`) is **production**, with
  real commercial data (1,085 accounts, 132 opportunities). Migrations must be
  strictly additive. Nothing in HELM alters or drops a Memoire table.
- Memoire's storage has two patterns: relational tables for records with a
  lifecycle (`accounts`, `opportunities`, `commercial_*`) and
  `(user_id, id, payload jsonb)` collections for artifacts. HELM's decision
  records have lifecycles, approvals, and audit requirements, so they are
  relational.
- Memoire is deliberately AI-free (enforced by `verify:no-ai`). Its policy
  engine produces deterministic, *explainable* recommendations: reason code,
  reason text, evidence ids, threshold, severity. HELM adopts the same
  standard for its signal and diagnosis layer.

## 2. Tenancy: the organization layer is new shared core

HELM introduces true multi-tenancy as **new shared-core tables** that Memoire
can adopt later without change:

- `organizations` — the tenant. Base currency, fiscal-year start.
- `organization_memberships` — user ↔ org with a role
  (`admin` > `manager` > `member` > `viewer`). Roles are ranked; the data
  layer compares ranks, so new roles slot in without policy rewrites.
- `org_units` — flexible hierarchy (`company`, `business_unit`, `region`,
  `country`, `territory`, `team`, `department`) via `parent_id`. No fixed
  depth is assumed.
- `org_unit_memberships` — user ↔ unit, with `is_manager`.

**Isolation lives in the data layer.** Every HELM table carries `org_id` and
RLS policies call two `SECURITY DEFINER` helpers (`is_org_member`,
`has_org_role`) — the standard Supabase pattern that avoids recursive-policy
lookups. Org A's data is invisible to Org B at the Postgres level regardless
of what the frontend does. Writes require `member`+, approvals and
governance-sensitive updates require `manager`+, structure changes require
`admin`.

A person may belong to many organizations with different roles; the app keeps
an active-org context and every query is org-scoped.

## 3. Boundary with Memoire: reference + snapshot, never copy

HELM does not duplicate commercial entities. When a decision draws context
from Memoire (e.g. "Analyze this opportunity"), HELM stores:

- the **reference** (`memoire_opportunity_id`, `memoire_account_id`), and
- an **immutable snapshot** of the relevant fields at analysis time
  (`context_snapshot jsonb`).

Rationale: Memoire remains the system of record and keeps evolving; the
decision record must preserve *what the manager saw when deciding* (historical
decision integrity, §11 of the brief). Live data is re-read for display;
the snapshot is what the decision is judged against.

Write-back is an explicit action: approving a decision can create a
`commercial_events` row (and a follow-up `plan_items` entry) in the deciding
user's Memoire workspace — same database, same user identity, RLS-safe. The
event carries `source_type: 'system_rule'` and a `helm://decision/<id>` source
URL so Memoire's timeline shows the decision provenance.

## 4. Domain model: the Decision is the aggregate root

```
helm_decisions            the durable decision object (state machine below)
├─ helm_decision_alternatives   options with structured financials + qualitative factors
├─ helm_decision_assumptions    explicit assumptions, each testable/sensitive
├─ helm_decision_events         append-only audit trail (never updated, never deleted)
├─ helm_actions                 execution instructions (owner, due date, write-back)
└─ helm_scenarios (optional)    what-if models attached to the decision
helm_signals              explainable attention items (rule code, evidence, threshold)
helm_cost_objects         profitability lenses (company/unit/brand/product/customer/channel)
helm_economics            period economics per cost object (revenue, variable, traceable/allocated fixed)
helm_inventory_items      demand, lead time, stock, expiry — inventory-as-capital
helm_processes            managerial process map: activities, capacity, utilization
helm_approval_rules       configurable thresholds → required approver role
helm_org_settings         working assumptions (currency, service level, WACC-ish hurdle…)
```

**Decision state machine** (enforced in one command module, mirroring
Memoire's kernel discipline — pages never mutate state directly):

```
draft → analyzing → pending_approval → approved → executing → monitoring → closed
                          ↘ rejected                                   (reviewed)
```

Every transition writes a `helm_decision_events` row with actor and payload.
Expected outcome is captured **before** approval; actual outcome and the
lesson at close. That pairing — context + reasoning + expectation + result —
is the decision-memory moat, and it is queryable (`review_after`,
`expected_outcome`, `actual_outcome`, `lesson`).

## 5. Deterministic engines, separated from interpretation

All management math lives in pure TypeScript modules under
`src/domain/engines/`, unit-tested, no I/O, no UI, no LLM:

- `cvp.ts` — contribution margin, break-even, target profit, margin of
  safety, operating leverage, multi-product weighted-mix CVP.
- `relevantCost.ts` — incremental analysis between alternatives; classifies
  sunk / allocated / committed costs as irrelevant, applies opportunity cost;
  used by the decision templates (special order, make-vs-buy, keep-vs-drop…).
- `scenario.ts` — applies variable deltas to a baseline P&L; one-way
  sensitivity (tornado) over the assumption set.
- `inventory.ts` — safety stock, reorder point, EOQ, turnover, DOI, DSO,
  DPO, cash-conversion cycle, stock-out and expiry risk.
- `capacity.ts` — utilization, bottleneck detection, flow rate, Little's Law.
- `economics.ts` — cost-object margin ladder: revenue → variable →
  contribution → traceable fixed → **segment margin** → allocated fixed →
  net. Flags the allocation trap (negative net, positive segment margin).
- `signals.ts` — the rule engine. Every signal carries `ruleCode`, plain
  reason, the threshold it was judged against, severity, evidence refs, and a
  recommended next step (usually "open a decision"). Rules never write.
- `decisionMemory.ts` — pattern detection over closed decisions
  (e.g. systematic forecast bias by unit) — deterministic, evidence-listed.

AI stance: the ecosystem's trust posture is deterministic-first. The MVP's
"intelligence" is fully explainable rules. An LLM layer (diagnosis narrative,
assumption suggestions) can be added behind the same signal/diagnosis
contracts later; nothing in the schema assumes or requires it.

## 6. Information architecture

Six destinations, executive-first:

- **Attention** — the decision inbox: signals ranked by severity, decisions
  waiting on you (drafts, approvals, overdue reviews), target gaps. The
  answer to "what requires my attention in the next 10 minutes".
- **Decisions** — the workspace. Templates: Special Order, Pricing,
  Make-vs-Buy, Keep-vs-Drop, Inventory Commitment, Investment, Resource
  Allocation, Custom. Tabs: Frame → Analysis → Scenarios → Governance →
  Outcome.
- **Scenarios** — the what-if lab (CVP baseline + variants, compared side by
  side), attachable to a decision.
- **Economics** — cost-object profitability with the full margin ladder and
  allocation-trap flags.
- **Operations** — capacity/bottleneck view and inventory-as-capital view;
  both feed signals rather than being execution tools.
- **Memory** — closed decisions: expected vs actual, lessons, detected
  patterns.

## 7. Demo strategy

Demo mode is a deterministic in-memory organization (a Vietnamese life-science
distributor, mirroring the ecosystem's real domain) that exercises every
surface: a discount request on a large deal, a product that looks unprofitable
only because of allocated cost, a service team near capacity, stock-out and
expiry risks, a budget variance, and a make-vs-buy case. Demo data **never
syncs to the cloud** (Memoire's rule, kept). Real organizations start with
onboarding: create org → invite roles → optionally link Memoire data.

## 8. What HELM deliberately does not do (MVP)

- No planning/budgeting module yet (schema anticipates it; `helm_economics`
  has `kind: actual | budget | forecast`).
- No org-unit-level row security yet: visibility inside an org is
  role-gated, unit-tagged, and filterable, but the hard wall is the org.
  Unit-level RLS is a policy addition, not a redesign.
- No LLM calls, no chat surface.
- No duplication of CRM/task features that Memoire owns.
