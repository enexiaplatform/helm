# ADR-0012: Use npm workspaces; defer pnpm, Turborepo and Vitest

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 1
**Amends** [ADR-0002](0002-pnpm-turborepo-monorepo.md) ·
[ADR-0010](0010-test-and-contract-strategy.md)

## Context

ADR-0002 selected pnpm + Turborepo; ADR-0010 selected Vitest. Both were written
in Phase 0, before any packaged code existed, and both were chosen partly because
the original brief named them.

Phase 1 begins against a repository that is **green on every axis**: 40/40 tests
passing under `node --test`, clean `tsc -b && vite build`, clean `eslint .`.

Reviewing those choices against what Phase 1 actually needs surfaced the
question: does the current toolchain *materially block* workspace modularity,
package boundaries, testing, dependency management, or the kernel architecture?

## Problem

Should Phase 1 change package manager, add a build orchestrator and swap the test
runner — or deliver the kernel packages on the toolchain already in place?

## Options considered

1. **Migrate to pnpm + Turborepo + Vitest now, as ADR-0002 and ADR-0010
   specified.** Delivers the end-state toolchain immediately. Costs: a lockfile
   migration, a `node_modules` layout change, three new toolchains, and a test
   runner swap — all executed *in the same phase* as the first kernel packages,
   so any breakage is ambiguous between "the architecture is wrong" and "the
   tooling moved". Buys nothing Phase 1 needs.
2. **npm workspaces + `node --test`, defer the rest.** npm workspaces provide
   exactly the capabilities the kernel requires: separate `package.json` per
   package, explicit `exports` surfaces, per-package dependencies, and workspace
   linking. `node --test` already runs TypeScript directly via Node 24 type
   stripping, which is how the existing 40 tests work.
3. **Single package with path aliases.** Cheapest, and it fails the actual
   requirement — without a `package.json` per package there is no declared
   dependency graph, so `verify:architecture` would have nothing to check and
   package boundaries would be convention only.

## Decision

**Option 2.**

- **npm workspaces**, not pnpm. This is not a package-manager migration: npm
  stays, `package-lock.json` stays, the lockfile format is unchanged.
- **`node --test`**, not Vitest. Existing tests are untouched; new package tests
  use the identical runner and `node:assert/strict`.
- **No Turborepo.** Root scripts fan out across workspaces. With three packages
  and a sub-second test suite, a caching orchestrator solves a problem that does
  not exist.

### Each superseded choice, and the trigger that would revive it

| Deferred | Revived when |
| --- | --- |
| **pnpm** | A phantom-dependency bug actually occurs (npm's hoisting lets a package import something it never declared), or a workspace needs two versions of one dependency. `verify:architecture` checks declared dependencies statically in the meantime, which closes most of the gap. |
| **Turborepo** | Full `npm run check` exceeds ~60s, or package count passes ~8. |
| **Vitest** | Coverage per package is needed, browser-environment tests arrive (Phase 14), or `node --test` blocks a required capability. |

Each revival is a self-contained change behind an unchanged package layout —
which is the point. Choosing npm workspaces now does not foreclose pnpm later;
the directory structure, `exports` surfaces and dependency declarations are
identical under both.

### Why this does not compromise the architecture

The Phase 0 goal was never "pnpm". It was **a kernel consumable independently of
the application, with enforceable boundaries**. That is delivered by:

- one `package.json` per package with an explicit `exports` field;
- declared dependencies per package, so the dependency graph is data;
- `verify:architecture` asserting direction, purity and no deep imports.

None of those require pnpm. The strict-`node_modules` benefit pnpm adds is a
second line of defence behind a check that already exists.

## Consequences

**Good.** Phase 1 changes no tooling, so a green suite means the architecture is
sound rather than the toolchain merely survived. No lockfile churn. Zero new
devDependencies. Rollback is a branch delete.

**Bad.** npm's hoisted `node_modules` permits an undeclared import that pnpm
would refuse. Mitigated, not eliminated, by `verify:architecture`. No build
caching, so full checks re-run everything — acceptable at this size. No built-in
coverage tooling.

**Risk — the deferral becomes permanent by inertia** and the repo outgrows npm
workspaces unnoticed. Mitigation: the trigger table above, reviewed at each phase
boundary.

## Migration implications

- `package.json` gains a `workspaces` field. The npm lockfile is updated in place
  by `npm install`, not replaced.
- Kernel packages are consumed by the app through Vite `resolve.alias` and
  TypeScript `paths`, both pointing at package source. No build step between a
  package and its consumer during development.
- Moving to pnpm later is `pnpm import` followed by `pnpm install`; the package
  layout does not change.
- ADR-0002's layout, package rules and five-step migration path remain in force.
  Only its package-manager and orchestrator selections are deferred by this ADR.
- ADR-0010's three test layers (unit, conformance, `verify:*` contracts) remain in
  force. Only the runner selection is deferred.
