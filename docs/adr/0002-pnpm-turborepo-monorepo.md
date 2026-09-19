# ADR-0002: pnpm + Turborepo monorepo with a packaged kernel

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

HELM today is a single npm package: a Vite React SPA with domain logic in
`src/domain/` (eight pure engines, 1,058 lines, 40 passing tests). The logic is
already well separated from the UI — no React import appears in any engine.

But separation inside one package is not the same as independent consumability.
The brief requires the HELM Kernel to be the centre of the system (§2, §13), with
a worker, connectors, multiple applications and an agent runtime eventually
consuming it. None of those can consume `src/domain/` without inheriting the Vite
application's build, config and dependency tree.

## Problem

How should the repository be organised so the kernel is genuinely independent,
independently testable, and independently versioned — without discarding a
working, green application?

## Options considered

1. **Stay single-package, add folders.** Zero migration cost. Fails the actual
   requirement: a worker or connector still cannot import the kernel cleanly,
   nothing prevents a kernel file importing React, and package boundaries cannot
   be enforced because there are none.
2. **Multi-repo, one repo per kernel package.** Maximum isolation, and the wrong
   trade at this stage: cross-cutting changes during Phases 1–3 would touch five
   repos and need version coordination for every step. The brief warns against
   microservice explosion (§8); this is its packaging equivalent.
3. **npm workspaces.** Available with no new tooling. Hoisted `node_modules` lets
   a package import a dependency it never declared, so the boundary guard is
   weaker exactly where it matters most.
4. **pnpm workspaces + Turborepo.** The brief's stated preference (§9). pnpm's
   strict, symlinked `node_modules` makes an undeclared import fail at build time
   — the dependency rules in
   [repository-structure.md §3](../architecture/repository-structure.md#3-package-rules)
   become mechanically enforced rather than aspirational. Turborepo caches per
   package, so `turbo run test --filter=ontology` is fast feedback. pnpm 10.30.3
   is already installed.

## Decision

**Option 4.** pnpm workspaces + Turborepo, with the layout in
[repository-structure.md](../architecture/repository-structure.md).

Migration is the five reversible steps in §5 of that document, with **`git init`
as a blocking step 0** — a 7,300-line codebase sharing a production database will
not be restructured without version control.

Critically, **step 2 creates the new kernel packages before anything moves.**
`shared`, `ontology` and `graph-store` are new code with no existing consumers,
so Phase 1 carries no regression risk. The application relocates in step 3, once
there is something worth relocating toward.

Enforced rules, all asserted by `verify:package-boundaries`:

- Dependencies point inward: `apps` → `packages` → `shared`, never reverse.
- Kernel packages import no React, Vite, Supabase, HTTP or filesystem. The sole
  I/O exception is `graph-store`'s Postgres adapter.
- No kernel package imports a connector; no connector imports another connector.
- `ui` holds presentation only.
- Each package declares an explicit `exports` surface; deep imports fail.

## Consequences

**Good.** The kernel becomes consumable by a worker, connectors, tests and future
applications. Undeclared dependencies and layering violations fail the build
rather than being caught in review. Per-package test runs make Phases 1–3
practical to iterate on.

**Bad.** Toolchain complexity rises: two config files, package manifests per
package, and a lockfile migration from npm to pnpm. Contributors must learn
workspace filters.

**Risk — package sprawl.** Sixteen packages is a lot for one person to navigate,
and a package per idea is a real failure mode. Mitigation: a package is created
only when a phase needs it. Phase 1 creates exactly three.

**Risk — a half-migrated repository.** Mitigation: each of the five steps ends
with build, lint and tests green. No step may leave the repository broken.

## Migration implications

- `package-lock.json` is replaced by `pnpm-lock.yaml`. One-time, at step 1.
- Root `package.json` becomes workspace scripts; the app's own scripts move to
  `apps/management-console/package.json`.
- `.claude/launch.json` port 5183 must point at the app's new location after
  step 3.
- `supabase/migrations/` stays at the root — migrations are repository-wide, not
  package-scoped.
- The 40 existing tests move with their engines and swap `node:test` for `vitest`
  ([ADR-0010](0010-test-and-contract-strategy.md)). `node:assert/strict`
  assertions are unaffected.
