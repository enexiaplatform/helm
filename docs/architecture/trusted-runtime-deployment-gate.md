# HELM Trusted Runtime Deployment Gate

**Status** OPEN — `helm-authority` is **not deployed** · **Opened** 2026-09-29 ·
**Architecture** [ADR-0024](../adr/0024-trusted-authority-runtime.md) (accepted) ·
**Record** [phase-7-implemented.md](phase-7-implemented.md)

The trusted authority runtime is **architecturally accepted** but **not
deployment-qualified**. The shared Supabase project holds Memoire's live
production data; it must not be the first environment in which this authority
boundary is integration-tested.

This gate is a hard precondition for pilot use, production governance, the
Country GM Cockpit (Phase 14), and any claim that HELM's authority enforcement
is production-ready. It does not invalidate the Phase 7 architecture, and the
twin continues to treat the trusted service as the canonical cloud path.

## Current maturity

| Layer | State |
| --- | --- |
| Kernel | Phase 8 complete |
| Shared database schema | Phase 7 and Phase 8 migrations applied and verified (rolled-back proofs: 24 refusals / 12 controls; 31 refusals / 10 controls; 0 failures) |
| Trusted authority implementation | Built and contract-tested (`verify:authority-server`, 14 service tests, 4 mutations caught) |
| Trusted authority deployment | **NOT DEPLOYED** |
| Postgres conformance | **8 suites SKIPPED** — no isolated authenticated environment (the causal store added in Phase 8) |
| Cloud end-to-end readiness | **NOT YET PROVEN** |
| Production / pilot readiness | **BLOCKED** by this gate |

## Blockers

- **Blocker A** — the trusted authority runtime is not deployed, and the cloud
  path (Decision → Commitment → Authority Evaluation → Approval) is unproven.
  Client writes to the authority tables are revoked, so until the function is
  deployed the cloud decision page cannot record a verdict or an approval.
- **Blocker B** — the Postgres conformance suites have never run against an
  isolated, authenticated environment. The Phase 8 live proof showed why this
  matters: it found that RLS refused `INSERT … RETURNING` for the causal
  tables (fixed before the proof passed), and that **Phase 7's
  `helm_save_twin_snapshot` has the same defect** — the cloud twin cannot save
  a snapshot even as an org admin — and the twin tables still carry the
  default UPDATE/DELETE privilege. Both remain open; causal claims are
  decision-relevant in the demo, but their cloud persistence is unproven until
  this gate passes.

Both bear on whether HELM's governance guarantees hold outside the in-memory
reference environment. Other Phase 7 debt is ordinary backlog.

## Conditions — all must pass, in an isolated environment

1. An isolated Supabase branch or equivalent safe test environment exists.
2. A test organization exists in it.
3. Authenticated test principals exist for the required roles (Country GM,
   Commercial Director, Finance Director, a BU member in each of two BUs, an
   admin, a non-member).
4. Every previously skipped Postgres conformance suite is executed: graph,
   value graph, calculations, scenario store, decision store, authority store,
   twin store, causal store.
5. Zero conformance failures.
6. The cloud Decision → Commitment → Authority Evaluation → Approval path is
   executed end to end through the deployed `helm-authority` function.
7. Spoofing tests are refused for: identity, role, scope, consequence values,
   policy, approval actor.
8. RLS is verified from authenticated clients (not only by the rolled-back
   DO-block proof run as the database owner).
9. Server-side evaluations match the in-memory reference semantics for the
   canonical cases (same result, same basis rule, same required approvals).
10. No regression to Memoire-owned objects (accounts, opportunities,
    functions, function fingerprint unchanged).
11. A deployment rollback procedure is documented (below) and rehearsed.

Only after all eleven pass may `helm-authority` be deployed to the shared
project.

## What is NOT allowed while the gate is open

- Creating test identities in the production project.
- Inventing or borrowing branch credentials.
- Weakening RLS, or re-enabling client writes to authority tables, for testing.
- Deploying to make skipped suites green.

If the isolated environment does not exist, the suites stay **SKIPPED**.

## Reproducing the artifact

```bash
npm run build:authority-function
```

writes `supabase/functions/helm-authority/kernel.mjs` (git-ignored) from
`server/authority/host.ts`. The function source is
`supabase/functions/helm-authority/index.ts`; it needs `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (provided by the Supabase
runtime) and must be deployed with JWT verification enabled.

## Rollback procedure (to be rehearsed under condition 11)

1. Delete or disable the `helm-authority` function. Clients then fail closed:
   no verdict or approval can be recorded; nothing already recorded changes.
2. Recorded evaluations and approval acts are immutable history and are not
   removed.
3. Do not restore client write privileges on the authority tables as a
   rollback step; that reopens the Phase 6 gap ADR-0024 closed.
4. Confirm Memoire objects are unchanged (condition 10 checks).
