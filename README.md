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
| [Phase 1 implemented](docs/architecture/phase-1-implemented.md) | the enterprise ontology as built, with its debt |
| [Phase 2 implemented](docs/architecture/phase-2-implemented.md) | the enterprise value graph as built, with its debt |
| [Phase 3 implemented](docs/architecture/phase-3-implemented.md) | the propagation engine as built, with its debt |
| [Phase 3 hardening](docs/architecture/phase-3-hardening.md) | truth layers, run-bound lineage, the knowledge boundary, precision |
| [Meridian Value Model v1](docs/domain/meridian-value-model-v1.md) | the nine calculations, worked, with what each assumes |
| [Value links vs calculation dependencies](docs/architecture/value-links-vs-calculation-dependencies.md) | why HELM keeps two graphs |
| [Engine integration assessment](docs/architecture/engine-integration-assessment.md) | which pre-kernel engines become calculations, and when |
| [Projection decisions](docs/architecture/projection-decisions.md) | which domain tables become ontology entities, and why |
| [Scenario / Decision integration](docs/architecture/scenario-decision-integration.md) | the contract Phases 4–5 implement against |
| [Identity resolution](docs/architecture/identity-resolution.md) | canonical identity now, entity resolution later |
| [Implemented MVP](docs/architecture/implemented-mvp.md) | record of the decision-workspace build |

## Current state

Phases 0 (architecture foundation), 1 (enterprise ontology), 2 (enterprise
value graph) and 3 (value propagation) are complete.

HELM has a semantic kernel — entities and relationships that are org-scoped,
bitemporal, provenance-bearing and extensible without a migration — and a value
layer over it: metrics with machine-readable semantics, typed value links, and
observations that keep *what is*, *what we expect*, *what we want* and *what
might happen* apart. Enterprise value is modelled as several competing
dimensions, never one score.

Over that sits an executable model. Expected revenue is 2.94B **because HELM
multiplied 4.2B by 0.70**, and raising the probability to 90% moves it to 3.78B
and demand from 8.4 to 10.8 units — while leaving the cost branch untouched,
because nothing in it depends on probability. Every derived number explains
itself down to the Memoire record that asserted its inputs.

HELM keeps **what the business says** and **what its model computes** apart: if
Finance forecasts 5.00B and the model computes 4.70B, both stand, with the
variance between them, and neither silently becomes "the" number. Each run reads
one reproducible information boundary — nothing recorded after it began can
enter it — and replay reconstructs that boundary exactly.

Three engineering surfaces expose the kernel: `/ontology`, `/value-graph` and
`/calculations`.

What HELM cannot do yet is *compare*. It can compute one scenario; ranking them,
recommending between them and governing the decision that follows are Phases 4
and 5. `verify:phase-boundary` fails the build if any of that appears early. See
[phase-3-implemented.md](docs/architecture/phase-3-implemented.md) and the
[roadmap](docs/architecture/roadmap.md).

```bash
npm install
npm run dev      # app + Ontology, Value Graph and Calculation explorers
npm run check    # typecheck, lint, tests, and the 15 architecture contracts
```

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
npm run check   # typecheck + lint + tests + all 9 architecture contracts
```

Or individually:

```bash
npm test                      # unit, conformance and canonical-scenario tests
npm run typecheck             # tsc -b across the app and every package
npm run lint
npm run build                 # production build
npm run verify:architecture   # layering, kernel purity, no AI in the kernel
npm run verify:schema         # namespace, org scoping, RLS, append-only tables
npm run verify:ontology       # ontology integrity; migration matches the seed
npm run verify:graph          # canonical graph, bounded traversal, isolation
npm run verify:memoire-boundary
npm run verify:value-schema   # value tables, append-only observations, constraints
npm run verify:value-metrics  # metric semantics; migration matches the seed
npm run verify:value-graph    # canonical value chain, contention, no propagation
npm run verify:value-observations
npm run verify:calculations        # governance, code/metadata agreement, no code in the DB
npm run verify:calculation-graph   # acyclic, deterministic, incremental
npm run verify:propagation         # the canonical proof: 2.94B → 3.78B, branch isolation
npm run verify:lineage             # every derived number traces to stated facts
npm run verify:phase-boundary      # no scenario management, decisions, authority or optimization
npm run verify:docs                # every relative link in the documentation resolves
```

The `verify:*` scripts make architectural invariants executable: a violation
fails the build rather than surviving review.
