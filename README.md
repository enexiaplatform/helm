# HELM

**The Enterprise Management Infrastructure**

> Connect the enterprise. Model how value is created. Simulate what comes next.
> Govern decisions. Learn from every outcome.

> Memoire records what happened. HELM decides what to do about it — with people.

HELM is the management control plane above operational systems. It consumes
commercial, transactional, operational, economic and organizational truth and keeps
**management truth**: what requires attention and why, what it costs elsewhere, who
may decide, what management believes about the causes, what the organization learned
last time — and how all of it looked at any moment in the past.

It shares one database and one identity system with Memoire (the commercial system of
record, a separate repository — [HELM vs Memoire](docs/architecture/helm-vs-memoire.md))
and keeps strict application boundaries: Memoire owns commercial execution; HELM owns
management attention, analysis, decisions and memory, and only ever *reads* Memoire.

HELM never recommends, ranks, scores a person, votes, predicts or acts on its own. It
shows evidence and trade-offs, evaluates the criteria management stated, records the
choice a person made, and remembers.

## What it is made of

One stack, each layer resting on the ones before it and knowing nothing of the ones
after (`verify:boundaries`):

```text
sources → integration → ontology → value graph → propagation → scenarios → decisions
   → authority → management twin → causal graph → counterfactuals → genome
   → management reviews → governed AI → council of perspectives → applications
```

| Layer | What it holds |
| --- | --- |
| integration | source adapters, identity by alias, an ingestion ledger with derived checkpoints, drift detection, **dry-run** write-back |
| ontology · value graph | entities and relationships as registry data; metrics, value nodes, typed observations (source actual, forecast, target, model estimate, derived) |
| propagation | governed calculations in exact decimals; every number explains itself down to a source fact |
| scenarios · decisions | branches of the model; the question, alternatives bound to runs, management's criteria, owned assumptions, a fingerprinted commitment |
| authority | who may commit what, over which scope, under which consequences — verdicts computed by a trusted service |
| twin · causal · counterfactual · genome | management state at a lens; evidence-backed beliefs about why; anchored what-might-have-been; organizational memory |
| reviews | the weekly, monthly, quarterly and strategic cadence — a pack of references that closes with a disposition for every item and reproduces |
| AI · council | fifteen read-only governed tools, grounding that removes what the evidence does not carry, an audit with no reasoning trace; several perspectives over one truth, disagreement shown, nothing decided |

The **Country GM Cockpit** (`/`) shows the enterprise *now* beside its *committed
future* — no health score — with a governed AI brief and the council behind it.

## Run it

```bash
npm install
npm run dev        # the app; demo mode builds every layer in memory, offline
npm run check      # typecheck, lint, all tests, all contracts
npm run test:mutations   # breaks the code on purpose; every contract must notice
npm run build
```

Demo mode is the Meridian Life Sciences Vietnam story — the Rohto allocation decision,
lived through the kernels, with two management reviews, a source moving afterwards and
the AI and council reading it all. It never writes to the cloud and every demo object is
labelled DEMO.

## Documentation

Start with **[the architecture](docs/architecture/helm-architecture.md)**. It is the one
document that describes the system; everything else goes deeper into one part.

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture/helm-architecture.md) | the stack, the distinctions it will not blur, time, visibility, lineage, AI governance, verification, what is not proven |
| [Layer references](docs/architecture/layers/) | one file per layer: what exists, rules kept, proof, debt |
| [ADRs](docs/adr/README.md) | each architectural decision and why (0001–0033) |
| [V1 audit](docs/architecture/v1-audit.md) | what was checked against the standard, what held, what is still open |
| [Roadmap and readiness](docs/architecture/roadmap.md) | how proven each layer is; what stands between HELM and a pilot |
| [Deployment gate](docs/architecture/trusted-runtime-deployment-gate.md) | the two blockers and the conditions to lift them |
| [Security model](docs/architecture/security-model.md) | isolation, visibility, authority, AI access, known gaps |
| [Product vision](docs/product/vision.md) · [visual system](docs/product/visual-system.md) | what HELM is and is not; the "chart room" the console follows |
| [Domain model](docs/architecture/domain-model.md) · [Kernel interfaces](docs/architecture/kernel-interfaces.md) · [Data flow](docs/architecture/data-flow.md) · [Repository structure](docs/architecture/repository-structure.md) | the objects, the ports, how information moves, where code lives |
| [Ontology](docs/domain/ontology.md) · [Canonical scenario](docs/domain/canonical-scenario.md) · Meridian value models [v1](docs/domain/meridian-value-model-v1.md), [v1.1](docs/domain/meridian-value-model-v1-1.md) | the seed taxonomy, the acceptance scenario, the worked calculations |
| [Archive](docs/archive/implemented-mvp.md) | the retired pre-kernel application, kept as history |

## Status, plainly

Complete and verified **in memory**, with every migration applied to the shared database
and proven by rolled-back server-side proofs: 890 tests (877 pass, 13 skipped, 0 fail), 70
contracts, a mutation suite in which every mutation is caught, and a browser-verified
demo.

**Not production-ready.** Two blockers stand: the trusted authority service is not
deployed, and the 13 Postgres conformance suites have never run in an isolated
authenticated environment ([deployment gate](docs/architecture/trusted-runtime-deployment-gate.md)).
No language-model provider has been exercised — the reference provider proves the
governance, not the quality. Only Memoire is a real source, and nothing is written outward.
