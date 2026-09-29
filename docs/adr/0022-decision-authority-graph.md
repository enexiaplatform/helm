# ADR-0022: The Decision Authority Graph — who may commit what, over which scope, under which consequences

**Status** accepted · **Date** 2026-09-28 · **Deciders** Architecture ·
**Phase** 6 · **Depends on** [ADR-0021](0021-decision-runtime.md),
[ADR-0019](0019-scenario-runtime.md), [ADR-0014](0014-bitemporal-lite.md),
[ADR-0015](0015-value-graph-specialized-storage.md), [ADR-0016](0016-decimal-arithmetic.md)

## Context

Phase 5 records what management committed to and why. It deliberately says
nothing about whether the person committing was allowed to: every decision and
commitment carries `authorityStatus: NOT_EVALUATED`, pinned in the type and by a
database CHECK.

Phase 6 answers that second question. It is easy to answer badly, and the bad
shapes are familiar:

1. **RBAC.** "Managers may approve." Access control answers *can this user open
   this screen?* It cannot answer *can the Vietnam Commercial Director commit an
   inventory reallocation that ties up 1.7B VND of cash for a strategic
   customer?*
2. **An approval form.** The commitment gets `approval_amount`, `approval_margin`
   and `status = APPROVED`. The amount is typed by the person asking, so it is a
   second, unaudited copy of the economics — and the one that decides who signs.
3. **A manager's-manager chain.** Escalation follows the reporting line. Real
   authority is matrixed: a country GM and a finance director may both be
   required, and neither is the other's manager.
4. **A mutable verdict.** The commitment row is updated to `APPROVED`. The
   historical act and the governance judgement become one field, and nobody can
   say which policy, which threshold, or which version of the commitment was
   judged.

`helm_approval_rules` (Phase 0) is shapes 1 and 2 at once: a manually entered
`threshold_amount` against an org-rank `required_role`.

## Decision

### 1. Authority is a separate judgement applied to an immutable commitment

```
Decision → Commitment (Phase 5, immutable, fingerprinted dfp_…)
         → Authority evaluation (Phase 6, immutable, fingerprinted aev_…)
               AUTHORIZED | REQUIRES_APPROVAL | ESCALATED | NOT_AUTHORIZED | INDETERMINATE
         → Required approvals (generated from the evaluation)
         → Approval acts (APPROVE | REJECT | RETURN_FOR_RECONSIDERATION)
         → Governance state (a projection, never stored as truth)
```

The commitment is never touched. Its `authority_status` column stays
`NOT_EVALUATED` for ever, and now means exactly that: *the act of committing
carries no authority verdict*. The canonical evidence of authority is an
`AuthorityEvaluation` bound to the commitment's id **and fingerprint**.

This supersedes [security-model.md §4.4](../architecture/security-model.md)'s
plan to refuse a commitment INSERT through RLS when the actor lacks authority.
Refusing the row would destroy the historical record of an unauthorized act.
HELM keeps the act and records the governance judgement on it — which is also
the only way an audit can find unauthorized commitments afterwards.

### 2. Authority attaches to roles; people occupy roles over time

`Person → OCCUPIES → Role → HAS_AUTHORITY → decision right`

Roles are `Role` entities in the enterprise graph (Phase 1). A **role
occupancy** binds an authenticated identity to a role for a valid-time window,
as `SUBSTANTIVE` or `ACTING`. Authority rules name the role. When another
person takes the seat, the authority moves with it and no rule changes.

Acting is an occupancy, not a delegation: an acting Country GM holds the
Country GM's rules because they occupy the seat. A direct-person rule holder
exists in the type for genuine exceptions and ranks as more specific than a role
rule; the demo policy uses none.

Occupancies live in `helm_role_occupancies`, not as `HOLDS_ROLE` edges, because
they bind an **authentication identity** (`auth.users`) that RLS must check,
while the graph's `HOLDS_ROLE` describes an enterprise **person** entity. The
graph edge stays descriptive; the occupancy is authoritative for governance.

### 3. Decision types and authority acts are data

A decision is classified once, on its **governance profile**, with a decision
type from a registry (`INVENTORY_ALLOCATION`, `PRICING`, `CUSTOMER_TERMS` are
seeded — the minimum the canonical cases need). A decision with no type is
`INDETERMINATE` for authority, with the gap named.

Authority distinguishes acts: `PREPARE`, `RECOMMEND`, `COMMIT`, `APPROVE`,
`EXECUTE`, `OVERRIDE_POLICY`. Holding `PREPARE` and `RECOMMEND` for a decision
type does not confer `COMMIT`. This is the first place authority differs from
access control, and the evaluation says so in words.

### 4. Enterprise scope is derived from the graph, never typed in

A rule's scope is a set of constraints over dimensions — `ENTERPRISE`, `REGION`,
`COUNTRY`, `BUSINESS_UNIT`, `FUNCTION`, `PORTFOLIO`, `PRODUCT`, `SEGMENT`,
`CUSTOMER` (a named strategic account is a `CUSTOMER` constraint).

A commitment's scope is **derived**: from the value nodes behind its modelled
expected outcomes and the chosen scenario's overrides, HELM takes each node's
subject entity and walks declared **anchoring edges** (`BELONGS_TO`, `HELD_BY`,
`SELLS`, `POSITIONS` outward; `OWNS`, `INCURS` inward) to collect the entities it
sits within, typed by dimension. A decision's governance profile may add
declared subjects; it can never remove derived ones.

Coverage is **per touched entity**, never flattened: a rule covers a commitment
only if, for every dimension the rule constrains, **every** touched entity lies
within the rule's allowed entities in that dimension. So Vietnam-Pharma
authority does not reach an Industrial BU entity, a Vietnam rule does not reach
a regional pool that sits above Vietnam, and a commitment spanning scopes no
single holder covers needs more than one authority. A touched entity HELM
cannot anchor makes the scope unknown, and the result `INDETERMINATE` — never
"allowed because nothing said no".

### 5. Thresholds are read from the computed consequences

A rule condition names a value metric, a comparator and an exact decimal line:
`CashImpact ≥ −1 000 000 000 VND`. The value is read from the **chosen
scenario run's future state** — through the commitment's frozen expected
outcome for that metric, which names the node and period — and never from a
number anyone typed. There is no `approval_amount`, `approval_margin` or
`approval_cash` anywhere in the schema.

Comparison is exact (ADR-0016). A metric the future state has as `BLOCKED`, one
it does not model, one that is ambiguous (several nodes, no expected outcome
naming one) or one in a different currency is `UNKNOWN`, and an `UNKNOWN`
condition makes the rule unestablished — the result is `INDETERMINATE`.

### 6. The evaluation: deterministic, total, explained

For act `COMMIT` by the committing identity at the commitment's time:

1. **Gaps first.** No decision type, no known actor, no policy in force, no
   rule for the decision type at all, a touched entity without anchor, or an
   actor with no role and no delegation → `INDETERMINATE`, with each missing
   field named.
2. **The actor's authority.** Rules held through the actor's occupancies at the
   act time. None of them grants `COMMIT` for this type over this scope, and no
   valid delegation does either → `NOT_AUTHORIZED` (with who *does* hold it, for
   information).
3. **Precedence.** A matching `RESTRICT` rule (an explicit exception, e.g. "a
   named strategic account needs the Country GM") beats any `GRANT` for the
   same holder. Among covering `GRANT`s the **most specific** decides —
   person over role, then the deepest constrained dimension, then the number of
   constrained dimensions. Two equally specific rules that disagree are a
   policy conflict and yield `INDETERMINATE`. Insertion order never matters.
4. **Conditions** of the deciding rule, each explained on its own: value,
   comparator, line, `PASS` / `FAIL` / `UNKNOWN`.
5. **Delegation** can add authority the actor lacks; it never removes the
   actor's own.
6. **Escalation.** A failed or restricted rule names the role its excess goes
   to. That role's `APPROVE` rule is evaluated the same way; if it too is
   exceeded, its own escalation is followed. One step → `REQUIRES_APPROVAL`;
   more → `ESCALATED` to the first role whose authority covers it; no path, or a
   path through an unknown value → `INDETERMINATE`. HELM never assumes a CEO.
7. **Matrix requirements.** `REQUIRE_APPROVAL` rules add parallel or ordered
   approvals (a finance director above a cash line) regardless of who
   committed. An authorized commitment with a matching one becomes
   `REQUIRES_APPROVAL`.

Every evaluation records the rules considered, matched and rejected (with the
reason for each), each scope check, each threshold value, the delegation checks,
the required authorities, the escalation chain, the gaps, a completeness
diagnostic (`GOVERNABLE` / `GOVERNABLE_WITH_GAPS` / `NOT_GOVERNABLE`, never a
number) and the sentence-by-sentence explanation. No AI, no scoring, no
recommendation.

### 7. Authority is bitemporal; no retroactive authority

A DOA is a versioned **authority policy** (`key`, `version`, external reference
such as `DOA-2026-04`, provenance kind, valid time, record time). Its rules are
immutable. A new DOA version is a new policy with new rules; nothing is edited.
At an instant, the version in force is the latest `validFrom` at or before it.

Evaluation reads the authority state — policies, occupancies, delegations — **as
valid and as recorded at the act time**. A policy recorded tomorrow, even with a
back-dated validity, does not reach a commitment made today, and an evaluation
already recorded keeps the rule ids and policy version it used for ever.
An approver's authority is judged as of the approval act.

### 8. Delegation is bounded by the delegator

A delegation names delegator (identity and the role they occupy), delegate,
decision types, acts, scope, conditions, a validity window and a reason. It is
refused at creation if it reaches a decision type, act, scope dimension or
threshold the delegator's own authority does not cover — a Country GM cannot
delegate regional authority. At evaluation the delegate's effective authority is
the delegator's deciding rule **intersected** with the delegation, and only
while the delegator still occupies the role. Outside its window it does not
exist.

### 9. Approval is an act, and the engine and the runtime stay apart

The **engine** decides what is required. The **runtime** records acts. A
required approval is generated from an evaluation, never typed. An approval act
names the required approval, the evaluation, the commitment and its
fingerprint, the approver's identity, the role or delegation their authority
rests on, the decision (`APPROVE`, `REJECT`, `RETURN_FOR_RECONSIDERATION`),
conditions and comments. The approver's role is **resolved from occupancy**,
never accepted as text; the database checks it again.

Separation of duties: an approval requirement that must be independent of the
committer cannot be satisfied by the person who committed — even when that
person later occupies the approving role. The refusal is explicit.

A rejection deletes nothing: the commitment stands as history, and the answer
to it is a reconsideration (a new revision, a new commitment, a new fingerprint)
which needs its own evaluation. An old evaluation or approval never satisfies a
new fingerprint.

### 10. Governance state is a projection

`NOT_EVALUATED`, `AUTHORIZED`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`,
`RETURNED`, `ESCALATED`, `NOT_AUTHORIZED`, `INDETERMINATE` — derived every time
from the latest evaluation of *this* fingerprint and the acts against its
requirements. The policy result (`REQUIRES_APPROVAL`) and the workflow progress
(`PENDING` → `APPROVED`) are reported separately and never collapse into one
field.

Two hooks are built and deliberately not automated: an approval act may carry a
`validUntil`, after which it no longer satisfies its requirement; and
`materialChange` compares an evaluation's consequence values with another run of
the chosen scenario and reports whether re-evaluation is required. Nothing is
recomputed behind anyone's back.

### 11. Specialized storage, like the value graph

Roles, people and scope entities are semantic and stay in the enterprise graph.
Policies, rules, occupancies, delegations, evaluations, required approvals and
approval acts get specialized tables: they are versioned, bitemporal, append-only
and checked by RLS and guard triggers in ways a generic node/edge store cannot
express (ADR-0015's reasoning, applied again). Conditions and scope constraints
are JSON inside an immutable rule version rather than a table of their own:
they are never queried apart from their rule and never change without it.

### 12. Visibility is not authority

Reading a decision and having authority over it are separate checks with
separate data. **Decision visibility** is granted to organization units
(`helm_decision_visibility`), subtree-inclusive through `org_units`, and read
through `org_unit_memberships`. A decision is visible to org admins, its
creator, and members of any granted unit or an ancestor of one. A
cross-functional decision gets several grants — it is never copied. No grant
means creator and admins only. RLS enforces it on every decision table, the
authority tables that hang off decisions included.

A Finance Director may read a Commercial decision without authority to commit
it; a Commercial Director may hold authority over a decision type without
seeing a decision they were not granted. The two are exercised by different
contracts.

### 13. `helm_approval_rules` is replaced

Its semantics are a manually entered amount against an org rank — exactly
shapes 1 and 2. Verdict: **REPLACE** by `helm_authority_policies` and
`helm_authority_rules`; the table is kept (additive discipline), marked
RETIRED, and its write policy removed. It held no kernel rows and nothing reads
it.

## Consequences

**Good**

- "Who could commit this, and why does it need the Country GM?" is answered from
  the enterprise scope and the computed consequences, with the policy version,
  rule, threshold and value named.
- An approval resolves all the way down: act → requirement → evaluation → rule →
  role and scope → commitment → chosen run → consequence → calculation trace →
  source observation.
- History is never rewritten: a new policy, a new commitment or a rejection each
  adds a record.

**Costs**

- A decision must be classified with a decision type before it can be governed;
  an unclassified one is honestly `INDETERMINATE`.
- Scope derivation is only as good as the graph's anchoring edges. An entity the
  graph cannot place makes the result `INDETERMINATE`, which is the right
  failure but will surface modelling gaps as governance gaps.
- The evaluation is computed by the kernel wherever the kernel runs — in the
  browser today, because ADR-0003 defers an API service. The database guarantees
  identity, immutability, fingerprint consistency and that an `AUTHORIZED`
  basis rule is one the actor actually held; it cannot re-derive a threshold
  verdict. A server-side authority runtime is required before real
  organizations rely on it (named as debt).

**Deliberately absent** — governance simulation ("what if the DOA changed"),
notification delivery, automatic re-evaluation, AI, ranking, recommendation,
and any change to the commitment itself.

## Migration implications

One additive migration, `helm_*` only. `helm_decisions` and the Phase 5 decision
tables gain nothing but new SELECT policies; the commitment's CHECK pinning
`authority_status` to `NOT_EVALUATED` stays exactly as it is.
