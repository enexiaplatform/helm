# ADR-0010: Vitest in packages plus executable architecture contracts

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

The brief sets hard completion criteria (§19): a phase is not complete if tests
fail, typecheck fails, business logic is untested, domain logic lives primarily in
React components, or major architectural assumptions are undocumented.

Current state: 40 tests in 8 suites using `node:test` + `node:assert/strict`,
importing `.ts` directly via Node 24 type stripping. All green. Coverage is good
where it exists — the engines — and absent elsewhere, notably the store and the
Memoire bridge.

The sibling Memoire repo demonstrates the practice that actually keeps
architecture intact over hundreds of files: **~130 `verify:*` scripts** wired into
one `npm run check`. Memoire does not document "no AI dependency" and hope; it
asserts it in a script that fails the build. The same for sample/live data
separation and data isolation.

This is the difference between architecture as intention and architecture as
property. Intentions erode silently; properties fail loudly.

## Problem

What is the test strategy for a monorepo with a kernel that must stay pure, an
abstraction that must stay portable, and boundaries that must not erode?

## Options considered

1. **Keep `node:test` only.** Zero dependencies, works today. No monorepo
   awareness, no watch mode, no coverage across packages, and awkward per-package
   filtering. Nothing asserts architectural rules.
2. **Vitest only.** Brief's preference, monorepo-aware, fast watch, workspace
   support. Covers behaviour; a unit test cannot assert "no kernel package imports
   React" in any natural way.
3. **Vitest + executable architecture contracts + Playwright later.** Behaviour in
   Vitest; structural invariants in `verify:*` scripts; end-to-end flows in
   Playwright once there is a flow worth driving.
4. **Vitest with ESLint rules for boundaries.** ESLint `no-restricted-imports` can
   police some import rules. It cannot check RLS policy coverage, migration
   additivity, or adapter conformance — the invariants that matter most here.

## Decision

**Option 3**, with option 4's linting as a cheap first line where it fits.

### Three layers

**1. Unit tests — Vitest, per package.** Pure and fast, no database. The
`InMemoryGraphStore` ([ADR-0004](0004-graph-abstraction-layer.md)) is what makes
this possible for graph-dependent logic. Every calculation, rule and state machine
is unit-tested. Migration from `node:test` is an import swap
(`from 'node:test'` → `from 'vitest'`), done per package as engines move;
`node:assert/strict` assertions stay as they are.

**2. Conformance suites — one contract, many implementations.** Where a port has
multiple adapters, one suite runs against all of them:

- `GraphStore` → Postgres and in-memory
- `Calculation` → every registered calculation must produce a complete `trace`
- `SourceConnector` → every connector's `translate()` must be pure and idempotent
- `LlmProvider` → every adapter, from Phase 11

A conformance suite is the only way an abstraction's realness is verified rather
than asserted.

**3. Architecture contracts — `verify:*` scripts.** Node scripts asserting
structural invariants, wired into one `pnpm check`:

| Script | Asserts | From |
| --- | --- | --- |
| `verify:package-boundaries` | dependency direction; no React/Vite/Supabase/HTTP in kernel packages; no deep imports | P1 |
| `verify:kernel-purity` | no I/O, no `Date.now()`, no `Math.random()`, no `crypto.randomUUID()` in kernel | P1 |
| `verify:no-ai-in-kernel` | no LLM client imported by a kernel package | P1 |
| `verify:table-namespace` | every new table is `helm_*` or on the shared-core allowlist | P1 |
| `verify:org-scope` | every `helm_*` table has `org_id`; every policy predicate references it | P1 |
| `verify:rls-coverage` | RLS enabled and policies present per needed operation | P1 |
| `verify:append-only` | audit tables have no UPDATE/DELETE policy | P1 |
| `verify:additive-migrations` | no `DROP`/`ALTER` against a Memoire table | P1 |
| `verify:memoire-boundary` | no kernel/connector reads a Memoire table except `connectors/memoire`; no write beyond `commercial_events` append | P1 |
| `verify:explainability` | every calculation returns a non-empty `trace`; every signal carries rule code, threshold, measurement, evidence | P3 |
| `verify:no-duplicated-fields` | no `helm_entities.attributes` key shadows a source column | P2 |
| `verify:ontology-core` | no kernel package references a non-core type code as a literal | P1 |
| `verify:no-logic-in-components` | no formula, threshold or state transition in a React component | P1 |
| `verify:demo-isolation` | demo mode performs no network write | P1 |
| `verify:no-service-key` | no service-role key reachable from client code | P1 |

**4. Integration tests** against a Supabase branch for RLS behaviour — the only
way to prove org A cannot read org B, since that is enforced by Postgres and not
by code HELM owns.

**5. Playwright** from Phase 14, for the decision flow end to end. Not before —
there is no flow worth driving until the cockpit exists.

### The RLS test that matters most

Isolation must be proven, not assumed: two orgs, two users, and an assertion that
user A's query returns zero rows of org B's data **through the real client with a
real anon key**. A unit test cannot establish this, and it is the single most
important test in the suite.

## Consequences

**Good.** Architectural erosion fails the build. Abstractions are verified across
implementations. Per-package runs make Phases 1–3 fast to iterate. `pnpm check` is
one command before declaring a phase done.

**Bad.** `verify:*` scripts are code to write and maintain, and a poorly written
one produces false failures that erode trust in the suite. Vitest adds a
dependency that `node:test` did not. Integration tests need a Supabase branch and
are slower.

**Risk — contract scripts become brittle.** Mitigation: each asserts one
structural property with a clear message naming the offending file and rule. A
contract that cannot say precisely what is wrong gets rewritten or deleted.

**Risk — the suite grows to Memoire's ~130 scripts and slows down.** Mitigation:
Turborepo caching, and `pnpm check:fast` for the subset that catches most
regressions.

## Migration implications

- Phase 1 adds Vitest at the workspace root and writes the first batch of
  `verify:*` scripts (the P1 rows above).
- Existing tests keep running under `node --test` until their engines move, then
  swap to Vitest. The suite stays green at every step; a red suite blocks the
  phase.
- `pnpm check` = `build && lint && typecheck && test && verify:*`, and it is the
  gate for every phase's definition of done.
