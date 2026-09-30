# Repository structure

Where things live, and the rules that keep them there. The layering itself is in
[helm-architecture.md](helm-architecture.md).

## 1. Layout

```text
helm/
├── packages/                    the layers — npm workspaces, consumed from source
│   ├── shared/                  ids · exact decimals · Result · errors · injected clock
│   ├── ontology/                entity and relationship registry, validation
│   ├── graph-store/             GraphStore port · in-memory + Postgres adapters
│   ├── value-graph/             metrics · nodes · links · typed observations
│   ├── propagation-engine/      governed calculations · dependency order · trace
│   ├── scenario-runtime/        branches of the model · overrides · feasibility
│   ├── decision-runtime/        question · alternatives · criteria · commitment
│   ├── authority-runtime/       authority · delegation · approvals · trusted service
│   ├── twin-runtime/            management state at a lens · delta · trajectory
│   ├── causal-runtime/          evidence-backed causal claims
│   ├── counterfactual-runtime/  anchored what-might-have-been
│   ├── genome-runtime/          episodes · patterns · lessons
│   ├── integration-runtime/     adapters · identity · ingestion · drift · dry-run writeback
│   ├── review-runtime/          management reviews
│   ├── intelligence-runtime/    governed read-only AI
│   └── agent-runtime/           council of perspectives
│       each: package.json (name, exports, helm.layer) · src/ · test/
│
├── src/                         the application (React 19 + Vite + Tailwind)
│   ├── pages/                   one file per route
│   ├── components/              brand · shell · ui · decision · scenario · graph ·
│   │                            memory · review · intelligence
│   ├── services/                one *Runtime.ts per layer: builds the demo stack, or
│   │                            the cloud stack, and reads it as a viewer
│   ├── data/demoOrg.ts          the tenant shell of the demo organization
│   ├── domain/types.ts          tenancy types (organization, unit, member)
│   └── lib/                     Supabase client, class helper
│
├── server/authority/host.ts     the trusted authority host (bundled to the edge function)
├── supabase/
│   ├── migrations/              additive `helm_*` SQL, chronological
│   └── functions/helm-authority the trusted authority edge function (not deployed)
├── scripts/
│   ├── verify-*.mjs             70 contracts (npm run verify)
│   └── lib/                     harness re-exports, mutation suite, benches
├── docs/                        architecture · adr · domain · product · archive
├── public/                      fonts, brand assets
└── CLAUDE.md                    the UI rules
```

## 2. Package rules

1. **Dependencies point one way.** A package imports only layers below it in the stack;
   the integration fabric is lateral. Nothing imports the app; only the app composes
   `integration-runtime` and `agent-runtime`. Asserted by `verify:boundaries` (the
   dependency direction and concept homes) and `verify:architecture`.
2. **Layers are pure.** No React, Vite, Supabase, HTTP, filesystem, ambient clock or
   randomness. The single I/O boundary of a package is its `postgres.ts`, and the
   conformance suite is shared with the in-memory store.
3. **Ports, not clients.** A layer takes its store, its clock, its id generator and its
   sources as arguments; the app is the only place they are chosen.
4. **Every package has an explicit public surface** through its `exports` field; deep
   imports into another package are refused.
5. **Each package owns its tests** and they run without a database; the Postgres
   conformance test skips itself, with the variables it needs, when none exists.
6. **Seed files play management.** `meridian*.ts` in a package builds the demonstration
   enterprise *through the kernels as a person would*; they are the only files allowed to
   call the write methods of the layers below them, and every demo object is labelled DEMO.
7. **The app holds presentation.** Formulas, thresholds and state transitions live in a
   package and are verified there.

## 3. Tooling

| Concern | Choice | Why |
| --- | --- | --- |
| Packages | **npm workspaces**, TypeScript sources consumed directly | [ADR-0012](../adr/0012-defer-pnpm-turborepo-and-vitest.md): pnpm, Turborepo and Vitest are deferred until a concrete blocker |
| Tests | **`node --test`** with Node 24 type stripping | no transform step, one runner everywhere |
| Contracts | **`verify:*` node scripts** | [ADR-0010](../adr/0010-test-and-contract-strategy.md) |
| Mutation | `scripts/lib/mutate.mjs` | breaks the code on purpose and fails if a contract still passes |
| Frontend | React 19 · Vite · Tailwind 3 · TypeScript | tokens only in `tailwind.config.js` |
| Database | Postgres via Supabase | [ADR-0003](../adr/0003-supabase-postgres-system-of-record.md); no standalone API service |

## 4. What runs where

`npm run dev` serves the app; demo mode builds every layer in memory in the browser and
never touches the network. Cloud mode reads and writes the same layers over the Postgres
adapters through the signed-in user's own RLS. `npm run check` is the gate; `npm run
test:mutations` and `node scripts/lib/bench-*.mjs` are run on demand.
