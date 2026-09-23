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
Memoire (the commercial system of record, a separate repository — see
[HELM vs Memoire](docs/architecture/helm-vs-memoire.md)), while keeping
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
| [Phase 4 implemented](docs/architecture/phase-4-implemented.md) | the scenario runtime as built, with its debt |
| [Phase 5 implemented](docs/architecture/phase-5-implemented.md) | the decision runtime as built, with its debt |
| [Scenario terminology](docs/architecture/scenario-terminology.md) | what scenario, revision, override, simulation, future state and comparison mean here |
| [Scenario engine assessment](docs/architecture/scenario-engine-assessment.md) | KEEP / ADAPT / MIGRATE / RETIRE for the pre-kernel CVP what-if |
| [Decision terminology](docs/architecture/decision-terminology.md) | what decision, revision, alternative, criterion, assumption, challenge, evidence, readiness and commitment mean here |
| [Decision engine assessment](docs/architecture/decision-engine-assessment.md) | KEEP / ADAPT / MIGRATE / RETIRE for the pre-kernel approval workflow |
| [Decision quality ≠ outcome quality](docs/architecture/decision-quality-vs-outcome.md) | why HELM records both and grades neither |
| [Meridian Value Model v1](docs/domain/meridian-value-model-v1.md) | the nine calculations, worked, with what each assumes |
| [Meridian Value Model v1.1](docs/domain/meridian-value-model-v1-1.md) | the four scenario calculations: order quantity, coverage, unserved demand, revenue at risk |
| [Value links vs calculation dependencies](docs/architecture/value-links-vs-calculation-dependencies.md) | why HELM keeps two graphs |
| [Engine integration assessment](docs/architecture/engine-integration-assessment.md) | which pre-kernel engines become calculations, and when |
| [Projection decisions](docs/architecture/projection-decisions.md) | which domain tables become ontology entities, and why |
| [Scenario / Decision integration](docs/architecture/scenario-decision-integration.md) | the contract Phases 4–5 implement against |
| [Identity resolution](docs/architecture/identity-resolution.md) | canonical identity now, entity resolution later |
| [Implemented MVP](docs/architecture/implemented-mvp.md) | record of the decision-workspace build |

## Current state

Phases 0 (architecture foundation), 1 (enterprise ontology), 2 (enterprise
value graph), 3 (value propagation), 4 (scenario runtime) and 5 (decision
intelligence) are complete.

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

Four engineering surfaces expose the kernel: `/ontology`, `/value-graph`,
`/calculations` and `/scenarios`.

HELM now *branches*. A scenario is a branch of the model — a pinned fork point
plus a sealed set of explicit overrides — and simulating it re-runs the same
propagation engine against the same source world, so several internally
consistent futures exist side by side without touching the baseline. The
`/scenarios` explorer shows the assumptions, the outcomes they produce, the
feasibility of each, and the lineage of every number.

HELM now also *remembers deciding*. A decision is a management question with
the alternatives that were considered, the criteria management stated, the
assumptions somebody owns, the disagreement somebody voiced, and a commitment
that freezes all of it and fingerprints it. An alternative holds no numbers of
its own — it references the scenario run that computed its future — so "why did
we choose this?" resolves through the rationale and the criteria and the chosen
future state all the way to a source fact.

What HELM still does not do is *choose*, *rank* or *permit*. It states how each
alternative stands against management's own criteria, names what each one gives
up, and records the choice a person made. Nothing is scored, nothing is
recommended, and every commitment carries `authorityStatus: NOT_EVALUATED` —
whether the decider was authorized is Phase 6's question.
`verify:phase-boundary` fails the build if any of that appears early. See
[phase-5-implemented.md](docs/architecture/phase-5-implemented.md) and the
[roadmap](docs/architecture/roadmap.md).

```bash
npm install
npm run dev      # app + Ontology, Value Graph, Calculation and Scenario explorers
npm run check    # typecheck, lint, tests, and the 25 architecture contracts
```

## The operating loop (as implemented today)

```text
SENSE → DIAGNOSE → SIMULATE → DECIDE → EXECUTE → CONTROL → LEARN
```

- **Attention** — the signal inbox. Deterministic rules (allocation traps,
  negative segment margins, budget variances, stock-out and expiry risk,
  capacity bottlenecks) ranked by severity. Every signal carries its rule code,
  threshold, measured value and evidence. "Frame a decision" carries a signal
  across as a decision *trigger* and asks a person for the management question;
  HELM does not write it.
- **Decisions** — one management question each, with the alternatives
  considered, the futures the model computed for them, the criteria management
  stated and how each alternative stands against each one, the trade-offs, the
  assumptions and their owners, the recorded disagreement, and the commitment
  with its frozen evidence manifest. Nothing is ranked or recommended.
- **Scenarios** — the scenario explorer: fork point, sealed overrides with their
  authors and rationales, simulated future states, feasibility, comparison and
  the lineage of every number.
- **Economics** — the margin ladder per cost object (company, business unit,
  brand, product, customer): contribution margin → segment margin → reported
  net, with the allocation trap flagged in both directions.
- **Operations** — capacity/bottleneck diagnosis (utilization, flow rate,
  Little's Law) and inventory as capital (safety stock, reorder point, EOQ,
  stock-out and expiry exposure, DOI/DSO/DPO/CCC).
- **Memory** — every commitment with what it rested on, what was accepted by
  choosing it, what was expected, and — once somebody reviews it — expected
  against actual with the variance stated. It detects no patterns and grades
  nothing: [decision quality is not outcome
  quality](docs/architecture/decision-quality-vs-outcome.md).

## Multi-tenancy

HELM introduced the shared organization layer (`organizations`,
`organization_memberships`, `org_units`, `org_unit_memberships`) as new core
tables Memoire can adopt later. Every HELM table carries `org_id`; Postgres
RLS policies call `SECURITY DEFINER` membership helpers, so tenant isolation
is enforced in the data layer, not the frontend. Roles are ranked
(`admin > manager > member > viewer`); governance writes are role-gated in the
database. Decision *rights* — who may decide what — are not modelled yet, and
nothing in HELM claims they are.

`helm_decision_events` is append-only by construction — it has INSERT and
SELECT policies and deliberately no UPDATE or DELETE, so decision history
cannot be rewritten from a client.

## Memoire interop

- **Read**: the signed-in user's Memoire opportunities are offered as decision
  context. HELM stores a *reference plus an immutable snapshot* of what the
  manager saw — never a copy.
- **Write**: nothing. The Phase 1 write-back was retired in Phase 5. A
  commitment instead produces **action intents** naming the system that should
  act, and `DecisionCommittedEvent` defines the payload a connector would carry.
  Building that connector is a later phase; the boundary is the deliverable
  here.

## Deterministic by design

All management math lives in pure, unit-tested code: the kernel packages
(`packages/`) hold the propagation engine, the scenario runtime and the decision
runtime, and the pre-kernel engines (`src/domain/engines/`) still serve the
workspace surfaces — CVP, the allocation trap, inventory, capacity, cost-object
economics and the signal rules. The CVP what-if that used to be called the
scenario engine was retired in Phase 4
([assessment](docs/architecture/scenario-engine-assessment.md)); the approval
workflow that used to be called the decision engine was retired in Phase 5
([assessment](docs/architecture/decision-engine-assessment.md)).

No LLM sits between data and a number, and HELM produces no recommendation at
all: every signal traces to a rule, a threshold and evidence, and every decision
traces to the criteria management stated and the futures the model computed. An
AI interpretation layer can be added later behind the same contracts.

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
npm run verify:scenario-schema     # scenario tables guarded, history immutable, migration additive
npm run verify:scenario-runtime    # seven futures + baseline through one engine; nothing is chosen
npm run verify:scenario-isolation  # baseline untouched, futures separate, tenants walled
npm run verify:scenario-time       # period identity, pinned forks, replay is not rebase
npm run verify:scenario-lineage    # every scenario value traces to an override or a source fact
npm run verify:phase-boundary      # no recommendation, decisions, authority or optimization
npm run verify:docs                # every relative link in the documentation resolves
```

The `verify:*` scripts make architectural invariants executable: a violation
fails the build rather than surviving review.
