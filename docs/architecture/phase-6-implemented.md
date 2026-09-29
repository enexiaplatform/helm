# Phase 6 implemented — Decision Authority Graph & Governance Runtime

**Date** 2026-09-28 · **Status** complete ·
**ADR** [0022](../adr/0022-decision-authority-graph.md) ·
**Security** [security-model](security-model.md) ·
**Previous** [phase 5](phase-5-implemented.md)

Phase 5 answers *what did management decide, based on what?* Phase 6 answers a
different question about the same record: *was the person who committed
authorized to, over this enterprise scope, with these computed consequences,
under the authority in force at that moment — and if not, whose authority does
it need?*

The commitment is never touched. The answer is a separate, immutable
**authority evaluation** bound to the commitment's fingerprint.

---

## 1. The model

```
Person ──OCCUPIES (valid time, SUBSTANTIVE | ACTING)──▶ Role ◀── rule holder
                                                          │
Authority policy (DOA-2026-04 v1, bitemporal, immutable)  │
  └─ Authority rule ── holder role · decision types · acts (PREPARE … OVERRIDE_POLICY)
                        · scope (dimension → entities) · lines on computed consequences
                        · escalation role · independence · effect GRANT | RESTRICT | REQUIRE_APPROVAL

Commitment (Phase 5, dfp_…) ──touches──▶ entities (from its consequences, the chosen
                                         scenario's overrides, declared subjects)
                                         ──anchoring edges──▶ Country · BU · Region · Customer …
      │
      └─ Authority evaluation (aev_…) ── AUTHORIZED | REQUIRES_APPROVAL | ESCALATED |
             │                           NOT_AUTHORIZED | INDETERMINATE
             └─ Required approval (generated) ── Approval act (APPROVE | REJECT | RETURN)
                                                     └─ Governance state (projection)
```

Package: **`@helm/authority-runtime`**, the new top of the kernel
(`shared → … → decision-runtime → authority-runtime`). The decision runtime does
not know it exists; `verify:phase-boundary` fails if it ever imports it.

| Module | Job |
| --- | --- |
| `types.ts` | the vocabulary: decision types, acts, scope dimensions, policies, rules, occupancies, delegations, evaluations, approvals, state |
| `scope.ts` | derive a commitment's scope from the graph; per-entity coverage; precedence by specificity |
| `conditions.ts` | exact-decimal lines on computed consequences; `UNKNOWN` never passes |
| `policy.ts` | what was in force, and who held what, at an instant (both lenses) |
| `engine.ts` | the pure, deterministic Authority Engine and the explanation |
| `delegation.ts` | delegation bounds: never more than the delegator holds |
| `state.ts` | the governance-state projection |
| `visibility.ts` | decision **visibility** — kept apart from authority |
| `runtime.ts` | assembles the engine's input from existing records; records evaluations and acts |
| `inMemoryStore.ts` · `postgres.ts` · `conformance.ts` | two stores, one contract |
| `meridianGovernance.ts` | the DEMO GOVERNANCE POLICY, roles, people and proof decisions |

## 2. Legacy approval-rule assessment

`helm_approval_rules` (Phase 0): `decision_type`, `threshold_amount`,
`required_role ∈ {manager, admin}`, `active`. Empty; read by nothing since
Phase 5.

| Verdict | Why |
| --- | --- |
| **REPLACE** (and retire the table) | `threshold_amount` is a number someone types, compared with nothing HELM computed — a second copy of the economics that decides who signs (brief §12). `required_role` is an org *rank*, which is access control, not decision authority (§2). There is no scope, no act, no validity, no provenance, no version. Nothing about it survives into the new model. |

It is kept (additive discipline), marked `RETIRED` by a table comment, and its
write policy is dropped so nothing can write to it. `helm_authority_policies`
and `helm_authority_rules` replace it.

## 3. Database

One additive migration, `20260928100000_helm_decision_authority.sql`, applied to
the shared Supabase project in seven named parts.

| Object | |
| --- | --- |
| `helm_decision_types` | registry: `INVENTORY_ALLOCATION`, `PRICING`, `CUSTOMER_TERMS` |
| `helm_authority_policies` | DOA versions; `UNIQUE (org, key, version)`; insert-only |
| `helm_authority_rules` | immutable; role holders are `et_role` entities; conditions checked as exact decimals |
| `helm_role_occupancies` | auth identity ↔ Role entity, valid time; ended once, never deleted |
| `helm_delegations` | bounded, time-limited; needs a seat behind it; revoked once |
| `helm_decision_governance_profiles` | decision type + declared subjects; insert-only |
| `helm_decision_visibility` | DATA VISIBILITY grants to org units |
| `helm_authority_evaluations` | insert-only; fingerprint must match the commitment; actor must be `committed_by`; an `AUTHORIZED` basis must be a rule the actor held at the act |
| `helm_required_approvals` | only from `REQUIRES_APPROVAL` / `ESCALATED` evaluations of the same fingerprint |
| `helm_approval_acts` | one per requirement; approver = `auth.uid()` (RLS); seat or delegation re-checked; separation of duties |
| `helm_can_see_decision()` · `helm_can_see_revision()` · `helm_visible_org_units()` | SECURITY DEFINER visibility helpers |
| every decision table | read, write, seal, resolve and draft-delete policies re-created **scoped** |

`helm_decision_commitments.authority_status` is untouched: still pinned to
`NOT_EVALUATED` by its Phase 5 CHECK, and now documented as meaning *the act of
committing carries no verdict*.

### Applied to the shared database

| | before | after |
| --- | --- | --- |
| Memoire `accounts` | 1 106 | 1 106 |
| Memoire `opportunities` | 129 | 129 |
| Memoire functions | 9 | 9 |
| Memoire function fingerprint | `eef6a68b…` | `eef6a68b…` (identical) |
| `helm_*` tables | 42 | 52 |
| `helm_*` policies | 136 | 158 |
| org-wide "Members read" policies left on decision tables | 14 | **0** |

**30 server-side assertions**, run in one transaction that deliberately aborts,
with two legal controls that must succeed (an `AUTHORIZED` evaluation on a rule
the actor held; the Country GM's own approval from the GM seat). Fixture users,
org, units, decisions and governance rows were verified back at zero afterwards.

| Proved server-side | |
| --- | --- |
| user A (Pharma BU) reads the Pharma decision and commitment; **not** the Industrial decision | RLS |
| user B (Industrial BU) reads the Industrial decision; **not** the Pharma one, nor its evaluations | RLS |
| the Country GM (member of the country unit) reads both | RLS, subtree |
| the creator reads their decisions; a member of no granted unit reads none; the authority structure is readable by members | RLS |
| A cannot record an approval in the Country GM's name; cannot append to the timeline of a decision A cannot see | RLS |
| evaluation of a foreign fingerprint · actor ≠ committer · `AUTHORIZED` on a rule never held · `INDETERMINATE` naming no gap | refused |
| requirement from an `AUTHORIZED` evaluation · self-approval by the committer · approval without the seat · act on another fingerprint · reason-less rejection · second act | refused |
| evaluation edited · policy edited · non-exact threshold · occupancy ended twice · seatless delegation · commitment given a verdict | refused |

Advisors afterwards: three new **security WARN**s of the same class as the five
pre-existing ones (SECURITY DEFINER helpers callable by signed-in users — RLS
needs them; each only answers a question about the caller's own access); **no
`auth_rls_initplan`** warnings; 40 `unindexed_foreign_keys` and 9 `unused_index`
INFOs on the new, empty tables.

## 4. Canonical proofs

All run in memory over the real Phase 1–5 stack, by the test suites and the
contracts.

**Rohto governance proof** (`verify:authority-runtime`, `verify:approval-lineage`):

1. The Rohto commitment (B — Reallocate) is committed by the demo **Commercial
   Director**, by identity.
2. The engine reads the chosen run's future state: cash impact **−1 735 500 000
   VND**, demand coverage **96.8858 %**, GM **32.3878 %** — the node, period and
   run are named.
3. Scope is derived from the graph: Rohto Q4 tender → *is held by* → Rohto
   Vietnam; → *sells* → SKU-X → *belongs to* → Diagnostics Portfolio → *is owned
   by* → Pharma BU → *belongs to* → Vietnam → Southeast Asia.
4. `commercial-director-inventory-allocation` (DOA-2026-04 v1, DEMO): Vietnam ✓,
   Pharma BU ✓, cash ≥ −1 000 000 000 **exceeded** → **REQUIRES_APPROVAL**.
5. Required authority: **Country GM Vietnam**, independent of the committer — its
   rule covers Vietnam, cash ≥ −3.0B ✓ and coverage ≥ 90 % ✓ (a multi-metric
   rule, each line explained on its own).
6. The Country GM's approval act is recorded, seat resolved from occupancy.
7. Governance state **APPROVED**; policy result still `REQUIRES_APPROVAL`.
8. The commitment is **byte-identical** before and after.
9. The approval resolves: act → requirement → evaluation → rule → DOA v1 →
   Country GM seat and scope → commitment → chosen run → cash impact →
   calculation trace → a source fact from Memoire / SCM.

**Direct authorization**: the Rohto 2027-Q1 call-off, a computed future of
−705 600 000 VND, same actor, same rule → **AUTHORIZED**, no approval.

**Scope failure**: a Vietnam-stock allocation that also serves the Thailand
Pharma BU → **NOT_AUTHORIZED** although the cash line passes; only the Regional
MD's authority spans both countries. **BU failure**: the same for the Vietnam
Industrial BU; the Country GM's country-wide rule reaches it.

**Threshold boundary**: 999 999 999 / 1 000 000 000 / 1 000 000 001 VND on both
signs and all four comparators; a difference at the 22nd decimal place decides.

**Delegation**: the Country GM delegates COMMIT, Vietnam Pharma, ≤ 2.0B, 25 Sep →
5 Oct, "on leave". Inside → **AUTHORIZED** through the delegation. After the
window, above the line (−2.46B), outside the scope (Industrial), recorded after
the act, after revocation, or once the delegator left the seat → no authority.
Six over-reaching delegations (regional scope, looser line, dropped line, other
type, other act, no end) are refused at creation.

**Separation of duties**: the Commercial Director, later appointed *acting*
Country GM, tries to approve their own commitment → refused, and the refusal is
on the timeline. As acting GM they may commit a *new* commitment within the
seat's authority — acting is an occupancy, not a delegation.

**Policy change**: DOA-2026-10 v2 (valid from 1 Oct) raises the Commercial
Director's line to 2.0B. The September commitment, re-evaluated, is still judged
by v1; its stored evaluation and its approval still cite v1. An October
commitment of the same −1.7355B is **AUTHORIZED** under v2.

**Reconsideration**: an `AUTHORIZED` F1, reconsidered and recommitted as F2 → F2
starts `NOT_EVALUATED`. An approved F1 does not approve F2; F2 needs its own act.

**Material change**: re-simulating the chosen scenario with the re-labelling
cost (Finance's open challenge) moves cash to ≈ −2.84B; `materialChange` reports
that it crosses the Finance line and that re-evaluation is required. It does not
re-evaluate.

## 5. Precedence, deny and unknowns

- An explicit `RESTRICT` exception (e.g. a named strategic account) beats a
  `GRANT` of the same holder.
- Among one holder's grants the most specific decides: person over role, then
  the narrowest constrained dimension, then the number of dimensions. A person
  in two seats may exercise either; seats are decided separately.
- Equally specific rules that disagree → `INDETERMINATE` (`RULE_CONFLICT`).
  Insertion order is never used, and both orders are tested.
- `INDETERMINATE` whenever a decision type, actor, role, policy, rule, scope
  anchor or consequence value is missing — each named. A `BLOCKED` value never
  passes.
- Escalation follows the policy's named roles; beyond the last one it is
  `INDETERMINATE`. HELM does not assume a CEO.

## 6. The surfaces

- **`/decisions/:id`** gains *Was this within authority?*: the policy result and
  the approval progress side by side, the consequences read from the chosen
  future, **"Why does this require approval?"** as a first-class disclosure,
  each requirement with its reason and independence, the approval request
  (question, chosen future, consequences, trade-offs, uncertainty, authority
  reason), and approve / return / reject. In the demo an act is recorded as one
  of the fictional seat-holders, labelled as such; a person without the seat, or
  the committer, is refused with the reason.
- **`/governance`** (Kernel instrument): roles and occupancies, each DOA version
  and its rules, delegations, every evaluation and every approval act.
- **`/decisions`**: a commitment waiting on approval says whose.
- **`/settings`**: "Decision authority" now describes the model and links to it.

## 7. Contracts

| Contract | Proves |
| --- | --- |
| `verify:authority-schema` | 9 tables guarded and write-once, no typed economics, evaluations bound to fingerprint and committer, approvals bound to identity and seat, SoD, commitment untouched, every decision table scoped, retired rules unwritable, additive |
| `verify:authority-runtime` | the Rohto proof end to end, direct authorization, INDETERMINATE on missing data, a new fingerprint starts unevaluated, evaluations immutable, nothing ranked |
| `verify:authority-scope` | derived scope with paths, Thailand and Industrial refused though the cash fits, per-entity coverage, above-level OUTSIDE, unplaceable INDETERMINATE, exception beats grant in any order |
| `verify:authority-threshold` | exact boundaries, values from the chosen run, multi-metric lines explained apart, UNKNOWN never passes, no typed amounts |
| `verify:authority-delegation` | six over-reaching delegations refused; window, line, scope, revocation, back-dating, seat; intersection; acting ≠ delegation |
| `verify:approval-lineage` | act → … → source observation, timeline in order |
| `verify:decision-visibility` | A ✗ Industrial, B ✗ Pharma, GM ✓ both; shared not copied; deny by default; SQL twin on every decision table; visibility and authority never import each other |
| `verify:phase-boundary` | *(updated)* authority confined to its package; no automated act, governance simulation, notification platform or digital twin anywhere |

`node scripts/lib/mutate.mjs` now breaks **42 invariants** (24 of them Phase 6),
one at a time; every one is caught by a named assertion of the contract that
claims it.

## 8. Performance

In memory, canonical stack, Node 24, `node scripts/lib/bench-authority.mjs`
(two runs agreed within 5 %):

| | |
| --- | --- |
| evaluate — assemble, engine, record (first / re-evaluation) | 8.3 ms / 4.7 ms |
| scope resolution alone (5 touched entities, graph walk) | 3.9 ms |
| threshold evaluation (every condition of 6 rules) | 0.05 ms |
| pure engine (6 rules, scope and thresholds) | 0.09 ms |
| recordApproval (identity, seat, SoD, sequence) | 0.75 ms |
| governance state projection | 0.02 ms |
| explainApproval (act → … → source observation) | 2.5 ms |

The engine is trivial; the cost is the graph walk that derives scope and the
scenario explanations that lineage reads. No database timing is quoted.

## 9. Debt carried forward

| Debt | Why it is not fixed here |
| --- | --- |
| **Verdicts are computed client-side** | ADR-0003 defers an API service. The database checks identity, immutability, fingerprint, committer and that an `AUTHORIZED` basis was held; it cannot re-derive a threshold. A server-side authority runtime is required before real organizations rely on it. |
| **Postgres conformance suites skip** | Six suites now need Supabase branch credentials; none were fabricated. The server-side proof above is the substitute evidence. |
| **Cloud decision path not exercised end to end** | Still no signed-in test identity on a branch. The DB layer is proven by the rolled-back proof; the app's cloud flow is not. |
| **Matrix approvals are not delegable** | A `REQUIRE_APPROVAL` holder can approve only in person; delegating it needs its own bounding rule. |
| **Scenarios are not decision-scoped** | A scenario bound to a restricted decision is still readable org-wide. Sensitivity classes are Phase 7. |
| **SECURITY DEFINER helpers in `public`** | Callable over RPC like the five pre-existing ones; move them to a non-exposed schema. |
| **Decision types are global keys** | An organization's own type would collide across tenants; needs an `(org, key)` identity. |
| **Customer classification** | Rules name customers; a "tier = key" condition is not modelled. |
| **Approval expiry** | `validUntil` is honoured by the projection; nothing sets it from execution dates yet. |
| **Unindexed foreign keys** | 40 INFOs, matching the existing pattern; tables are empty. |

## 10. What Phase 6 does not do

No policy simulation, no notification delivery, no automatic re-evaluation, no
automated approval, commitment or escalation, no digital twin, causal
inference, genome, counterfactual, recommendation, optimization or agents. The
commitment is never changed.
