# Discovery Findings (Phase 0, 2026-09-19)

> **Archive.** This describes the pre-kernel application, which has been retired: the engines, pages and tables it discusses were replaced by the layers in [the architecture](../architecture/helm-architecture.md). It is kept as history and is not a description of HELM today.

What the repository, the shared database, and the sibling Memoire codebase
actually contain — established by inspection, not assumption. Every
architectural decision in `docs/adr/` traces back to a finding here.

## 1. HELM already exists, and it is not a throwaway

`E:\Antigravity project\Helm` holds a working, green application:

| Signal | Measured |
| --- | --- |
| Source files | 32 (`src/`), 7,318 lines total incl. tests + SQL |
| Unit tests | 40 passing, 8 suites (`node --test`) |
| Build | clean (`tsc -b && vite build`, 5.4s) |
| Lint | clean (`eslint .`) |
| Migrations | 1, applied to the shared project |
| Version control | **none — no `.git` directory** |

Stack: React 19 + Vite 8 + TypeScript 6 + Tailwind 3, Zustand,
`@supabase/supabase-js`, React Router 6. Tests run via `node --test` importing
`.ts` directly (Node 24 type stripping, enabled by `erasableSyntaxOnly`).

## 2. What is already built — and how it maps to the phase plan

The existing build is a **deterministic managerial-accounting decision
system**. Measured against the 15-phase plan, it has already delivered
significant parts of the *upper* layers while the *foundational* layers are
absent:

| Brief phase | Status in repo | Evidence |
| --- | --- | --- |
| P1 Enterprise Ontology | **absent** | no entity/relationship abstraction anywhere |
| P2 Value Graph | **absent** | no value nodes, links, or propagation paths |
| P3 Propagation Engine | **absent** | engines compute *within* a domain, never across |
| P4 Scenario Engine | **substantial** | `engines/scenario.ts`, `helm_scenarios`, variants + tornado |
| P5 Decision Engine | **substantial** | `helm_decisions` + alternatives/assumptions/events/actions, state machine in `domain/decisionStates.ts` |
| P6 Authority Graph | **partial** | `helm_approval_rules` = amount threshold → role. No scope, geography, BU, chain, or escalation |
| P7 Digital Twin | **absent** | no enterprise-state snapshot concept |
| P8 Causal Graph | **absent** | no hypothesis/evidence/confidence structures |
| P9 Management Genome | **partial** | `engines/decisionMemory.ts` detects patterns over closed decisions; no situation/context matching, no `find_similar_*` API |
| P10 Counterfactual | **absent** | — |
| P11–12 AI / Agents | **absent by design** | no LLM anywhere, deliberately |
| P13 Memoire Connector | **partial, and real** | `services/memoireBridge.ts` reads opportunities, writes `commercial_events`. Direct client calls, no event contract, no adapter interface |
| P14 GM Cockpit | **partial** | `pages/AttentionPage.tsx` is a signal inbox, not a cockpit |
| P15 Review Loop | **absent** | — |

**The honest summary:** HELM today is a strong *decision workspace* with eight
deterministic engines and an auditable decision lifecycle. It is not yet an
*enterprise value graph*. The value-creation spine the brief puts at the centre
— Opportunity → Revenue → Demand → Inventory → Working Capital → Margin →
Cash → Enterprise Value — exists nowhere in code. Each engine reasons inside
its own silo; nothing propagates across them.

That is precisely the gap Phases 1–3 close, and it is why building the Country
GM Cockpit now would produce charts over disconnected silos.

## 3. Reusable assets (keep, do not rewrite)

These are genuinely aligned with the brief and must survive the restructure:

- **Eight pure engines** (`src/domain/engines/`, 1,058 lines): `cvp`,
  `relevantCost`, `scenario`, `inventory`, `capacity`, `economics`, `signals`,
  `decisionMemory`. No I/O, no React, no LLM, unit-tested. These *are*
  "deterministic engines before AI" (§8) already realised.
- **The explainability contract**: every `Signal` carries `ruleCode`,
  `thresholdLabel`, `measuredLabel`, `evidence[]`, plain `reason`. This is the
  brief's §18 standard, already enforced by types.
- **The auditability contract**: `relevantCost.ts` returns `excludedLines`
  alongside `includedLines`, so a manager sees which numbers were ignored and
  why. This is §17, already realised.
- **The decision state machine** (`domain/decisionStates.ts`) matching the
  brief's Phase 5 lifecycle, with append-only `helm_decision_events`.
- **Tenant isolation in the data layer**: RLS via `is_org_member` /
  `has_org_role` / `org_role_rank` `SECURITY DEFINER` helpers, ranked roles.
- **Reference + immutable snapshot** as the cross-system integration pattern
  (`memoire_opportunity_id` + `context_snapshot jsonb`), so a decision records
  what the manager saw, not a copy of a foreign system's row.

## 4. Conflicts with HELM's stated direction

1. **Domain logic is silo-shaped, not value-shaped.** Engines take
   hand-assembled inputs (`detectSignals({costObjects, economics, inventory,
   processes, decisions})`). There is no shared representation through which a
   change in one domain reaches another. Propagation cannot be bolted on top —
   it needs a graph underneath.
2. **The kernel is not a kernel.** It lives inside the Vite app
   (`src/domain/`). Nothing else — a worker, a connector, an API, a test
   harness — can consume it without inheriting the app's build. The brief's §8
   ("business logic never inside UI components") is honoured; its §13 (kernel
   as independently consumable packages) is not.
3. **Authority is a single amount threshold.** `helm_approval_rules` is
   `(decision_type, threshold_amount) → required_role`. The brief's §2.6 needs
   scope, geography, BU, risk threshold, action type, approval chain, and
   escalation path. That is a redesign, not a column addition.
4. **Ontology types are hard-coded TypeScript unions.** `decisionTypes`,
   `costObjectKinds`, `orgUnitTypes` are `as const` arrays mirrored by SQL
   `CHECK` constraints. Extending the enterprise model therefore requires a
   code change *and* a migration — the opposite of §2.1's "the ontology must be
   extensible".
5. **The Memoire bridge is a direct client call, not a contract.**
   `memoireBridge.ts` issues `supabaseClient.from('opportunities')` inline. The
   brief's §13 needs a published event contract (`opportunity.updated`,
   `competitor.detected`, …) behind an adapter interface, so ERP/Finance/SCM can
   be added without touching the kernel.
6. **No version control.** A 7,300-line codebase sharing a production database
   has no `.git`. Restructuring without it is unacceptable risk. **This is the
   highest-priority remediation and it blocks the physical migration.**

## 5. The shared database — hard constraints

Supabase project `mlmpcpkucurylkrobain` (`memories`, ap-south-1) is shared with
Memoire and holds **live production data**:

| Memoire table | Rows |
| --- | --- |
| `accounts` | 1,106 |
| `stakeholders` | 1,752 |
| `import_row_results` | 3,069 |
| `product_events` | 473 |
| `plan_items` | 216 |
| `sales_activities` | 132 |
| `opportunities` | 127 |
| `order_milestones` | 25 |
| `sales_assets` | 24 |
| `opportunity_outcomes` | 20 |
| `account_merges` | 17 |
| `commercial_events` | 13 |
| `nudges` | 12 |

All 4 org-layer tables and all 14 `helm_*` tables **exist and are empty
(0 rows)**. Two consequences, pulling in opposite directions:

- Memoire's schema is **untouchable**: additive migrations only, forever.
- HELM's own schema has **no data to preserve**. Phases 1–3 may reshape
  `helm_*` tables freely. This is a narrow, closing window — use it before the
  first real organization onboards.

### 5.1 A name collision that must be designed around

`public.entities` and `public.relationships` **already exist** — they are
Memoire's user-scoped semantic-capture tables, complete with pgvector
`embedding` columns:

```
entities(id, user_id, entity_type, name, description, attributes jsonb,
         tags[], created_at, updated_at, embedding vector)
relationships(id, user_id, source_entity_id, target_entity_id,
              relationship_type, created_at)
```

The brief's Phase 1 asks for tables named `entities` and `relationships`
(§10). **Those names are taken, by user-scoped tables with incompatible
semantics** (`user_id` + RLS `auth.uid() = user_id`, no `org_id`). HELM's
ontology is org-scoped, temporal, and provenance-bearing.

Decision: every HELM table is `helm_*`-prefixed without exception. See
[ADR-0005](../adr/0005-namespace-all-helm-tables.md).

### 5.2 pgvector is already available

The `embedding vector` columns prove pgvector is installed. Phase 9's semantic
retrieval over the Management Genome needs no new infrastructure.

## 6. Memoire — what the sibling codebase teaches

`E:\Antigravity project\Memoire`: 437 source files, 131 unit-test files, and
~130 `verify:*` scripts wired into one `npm run check`.

The transferable practice is **executable architecture contracts**. Memoire
does not merely document rules like "no AI dependency" or "sample and live data
never mix" — it asserts them in scripts that fail the build (`verify:no-ai`,
`verify:sample-live-separation`, `verify:data-isolation`). Architecture that is
only prose erodes; architecture that is a failing test does not.

HELM adopts this. The brief's §19 ("do not consider a phase complete if…") and
§20 (ADR discipline) become `verify:*` scripts, not good intentions. See
[ADR-0010](../adr/0010-test-and-contract-strategy.md).

Memoire also confirms the integration seam: `src/domain/commercialKernel/`
passes a `scope` object into every rule (`resolveCommercialScope.ts`)
specifically so a workspace/org dimension could be added later. That seam is
what HELM's org layer plugs into.

## 7. Toolchain confirmed present

`node v24.14.0`, `npm 11.9.0`, `pnpm 10.30.3`. The brief's preferred pnpm
workspace is available today; no installation step blocks Phase 1.
