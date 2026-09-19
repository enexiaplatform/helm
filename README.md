# HELM

**The Enterprise Management Infrastructure**

> Connect the enterprise. Model how value is created. Simulate what comes next.
> Govern decisions. Learn from every outcome.

> Memoire records what happened. HELM decides what to do about it.

HELM is the management control plane above operational systems. It consumes
commercial, transactional, operational, economic and organizational truth, and
produces **management truth**: what requires attention, why, what it costs
elsewhere, who may decide, and what the organization learned last time.

It shares one database and one identity system with
[Memoire](../Memoire/README.md) (the commercial system of record), while keeping
strict application boundaries: Memoire owns commercial execution, HELM owns
managerial attention, analysis, decisions, and learning.

## Documentation

| Document | Contents |
| --- | --- |
| [Product vision](docs/product/vision.md) | what HELM is, is not, and who it serves |
| [System overview](docs/architecture/system-overview.md) | the four layers and their invariants |
| [Domain model](docs/architecture/domain-model.md) | ontology, value graph, managerial tier |
| [Enterprise Value Ontology](docs/domain/ontology.md) | the seed entity, relationship and metric taxonomy |
| [Kernel interfaces](docs/architecture/kernel-interfaces.md) | the contracts every kernel package exposes |
| [HELM vs Memoire](docs/architecture/helm-vs-memoire.md) | the non-negotiable boundary |
| [Data flow](docs/architecture/data-flow.md) | sense → diagnose → simulate → decide → learn |
| [Security model](docs/architecture/security-model.md) | isolation, scope, authority, known gaps |
| [Roadmap](docs/architecture/roadmap.md) | 16 phases, status, and gates |
| [Canonical scenario](docs/domain/canonical-scenario.md) | the acceptance test for the kernel |
| [ADRs](docs/adr/README.md) | architectural decisions and their reasoning |
| [Discovery findings](docs/architecture/discovery-findings.md) | what the repo and shared database actually contain |
| [Implemented MVP](docs/architecture/implemented-mvp.md) | record of the decision-workspace build |

## Current state

Phase 0 (architecture foundation) is complete. What is **implemented** today is
the decision workspace described below — a deterministic management-accounting
system with an auditable decision lifecycle. The ontology, value graph and
propagation engine that make it *enterprise infrastructure* are Phases 1–3 and
come before any new surface. See the
[roadmap](docs/architecture/roadmap.md) for honest per-phase status.

## The operating loop (as implemented today)

```text
SENSE → DIAGNOSE → SIMULATE → DECIDE → EXECUTE → CONTROL → LEARN
```

- **Attention** — the decision inbox. Deterministic signal rules (allocation
  traps, negative segment margins, budget variances, stock-out and expiry
  risk, capacity bottlenecks, overdue outcome reviews) ranked by severity.
  Every signal carries its rule code, threshold, measured value, and evidence.
- **Decisions** — durable decision records built from templates (pricing,
  special order, make-vs-buy, keep-vs-drop, inventory commitment, …).
  Alternatives carry structured financial lines; the relevant-cost engine
  computes the incremental comparison and shows exactly which sunk and
  allocated numbers were excluded and why. Explicit assumptions, a state
  machine with configurable approval thresholds, and an append-only audit
  trail.
- **Scenarios** — a what-if lab over a P&L baseline: variants, break-even,
  profit deltas, and a ±10% tornado showing which assumption deserves the
  argument.
- **Economics** — the margin ladder per cost object (company, business unit,
  brand, product, customer): contribution margin → segment margin → reported
  net, with the allocation trap flagged in both directions.
- **Operations** — capacity/bottleneck diagnosis (utilization, flow rate,
  Little's Law) and inventory as capital (safety stock, reorder point, EOQ,
  stock-out and expiry exposure, DOI/DSO/DPO/CCC).
- **Memory** — the outcome ledger (expected vs actual vs lesson) and
  deterministic patterns across closed decisions ("inventory commitments
  systematically under-deliver", "forecast quality keeps appearing in
  lessons").

## Multi-tenancy

HELM introduced the shared organization layer (`organizations`,
`organization_memberships`, `org_units`, `org_unit_memberships`) as new core
tables Memoire can adopt later. Every HELM table carries `org_id`; Postgres
RLS policies call `SECURITY DEFINER` membership helpers, so tenant isolation
is enforced in the data layer, not the frontend. Roles are ranked
(`admin > manager > member > viewer`); approvals and governance writes are
role-gated in both the database and the state machine.

`helm_decision_events` is append-only by construction — it has INSERT and
SELECT policies and deliberately no UPDATE or DELETE, so decision history
cannot be rewritten from a client.

## Memoire interop

- **Read**: the signed-in user's Memoire opportunities are offered as decision
  context. HELM stores a *reference plus an immutable snapshot* of what the
  manager saw — never a copy.
- **Write**: when an approved decision starts executing, HELM appends a
  `commercial_events` row to the user's Memoire timeline with
  `source_url: helm://decision/<id>` provenance.

## Deterministic by design

All management math lives in pure, unit-tested engines
(`src/domain/engines/`): CVP, relevant cost, scenario/sensitivity, inventory,
capacity, cost-object economics, signal rules, and decision-memory patterns.
No LLM sits between data and a number; every recommendation is explainable
back to a rule, a threshold, and evidence. An AI interpretation layer can be
added later behind the same contracts.

## Tech stack

React 19 + Vite + TypeScript + Tailwind, Zustand, Supabase (Postgres + Auth +
RLS) — the Memoire stack, shared project `mlmpcpkucurylkrobain`.

## Local setup

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` with the shared Supabase project's URL and anon
key. Migrations live in `supabase/migrations/` (already applied to the shared
project; strictly additive to Memoire's schema).

No account? The auth screen offers **"Explore the demo organization"** —
Meridian Life Sciences Vietnam, a deterministic in-memory dataset staging
eight managerial situations (a key-account discount request, two allocation
traps, a genuine loss-maker, a capacity bottleneck, stock-out and expiry
risks, a budget variance, and a decision history with systematic forecast
optimism). Demo data never syncs.

## Verification

```bash
npm test        # engine + state machine unit tests
npm run build   # typecheck + production build
npm run lint
```
