# ADR-0024: The trusted authority runtime — verdicts are computed where the client cannot reach

**Status** accepted · **Date** 2026-09-29 · **Deciders** Architecture ·
**Phase** 7 · **Amends** [ADR-0022](0022-decision-authority-graph.md) ·
**Narrows** [ADR-0003](0003-supabase-postgres-system-of-record.md) (no standalone API service)

## Context

Phase 6 computed authority verdicts wherever the kernel ran. In cloud mode that
was the browser. The database checked what it could without re-running the
kernel — the evaluated fingerprint is the commitment's, the actor is its
committer, an `AUTHORIZED` basis is a rule the actor held — but it could not
re-derive a threshold. A tampered client could record `AUTHORIZED` with a real
basis rule and a fabricated cash impact.

Phase 6 recorded this as debt: *"A server-side authority runtime is required
before real organizations rely on it."* The Management Digital Twin makes it
urgent. The twin reads governance state into every snapshot; a twin built on a
verdict the client could have written is a record of the client's claims.

ADR-0003 defers a standalone API service. That decision stands: this ADR adds
**one** server-side function, not a service tier.

## Decision

### 1. One trusted service, transport-agnostic, with a tiny request surface

`createTrustedAuthorityService(deps).handle(identity, body)` in
`@helm/authority-runtime/trusted.ts`. It accepts exactly:

```
{ op: 'evaluate', orgId, commitmentId }
{ op: 'approve' | 'reject' | 'return', orgId, requiredApprovalId, comments, conditions?, validUntil? }
```

Body keys are allowlisted per operation. A request that tries to **supply a
fact** — `consequences`, `role`, `scope`, `policy`, `actor`, `approver`,
`evaluation` and the like — is refused by name (`authority.client_supplied_facts`)
**before anything is read**. The allowlist is the security boundary; a new
field is refused until someone adds it to the list on purpose.

### 2. Every fact is loaded from HELM's own records

1. **Identity** comes from a verified token (Supabase Auth `getUser()` on the
   caller's JWT), never from the body.
2. **Membership** (org role, units) is read from membership records.
3. **Visibility** — the caller must be able to *see* the decision. This is
   checked *as the caller* (the caller-scoped client's RLS). What they can see
   does not change the verdict: the facts are read as the service.
4. **The commitment**, its fingerprint and chosen alternative come from the
   decision store; the evaluated actor is the recorded committer.
5. **Consequences** come from the chosen run — and before they are believed,
   the run's calculation trace is **re-derived** with the governed formulas
   (`verifyCalculationTrace`, new in `@helm/propagation-engine`) and every
   scenario override it applied is checked against the sealed revision. A run
   whose stored outputs the formulas do not reproduce is refused
   (`authority.consequences_unverified`).
6. **Occupancy, scope, policy version and thresholds** — the unchanged Phase 6
   engine.

### 3. The evaluator is part of the verdict

`AuthorityEvaluation.evaluator = { kind: TRUSTED_SERVICE | CLIENT_RUNTIME, host,
consequenceCheck: { status: TRACE_VERIFIED | NOT_CHECKED, checkedSteps } }`.
The twin reports `AUTHORITY_VERDICT_UNTRUSTED` for any governance state resting
on a `CLIENT_RUNTIME` verdict, and the decision page says who evaluated it.

### 4. Only the service writes authority records

The Phase 7 migration revokes `INSERT`/`UPDATE`/`DELETE` on
`helm_authority_evaluations`, `helm_required_approvals` and
`helm_approval_acts` from `authenticated`, drops their client-write policies,
and adds a CHECK that `evaluator.kind = 'TRUSTED_SERVICE'`. The service writes
with the service role. `helm_approval_acts_member_guard` re-checks that the
approver is a member of the organization; every Phase 6 seat, delegation and
separation-of-duties guard still applies.

A refused request that got as far as a decision appends `AUTHORITY_REFUSED`
to its timeline, so an attempt is a fact.

### 5. Host: a Supabase edge function over the same kernel

- `server/authority/host.ts` — `handleAuthorityRequest({ service, caller },
  identity, body)` builds the Postgres stack over the service client and the
  visibility gate over the caller client.
- `supabase/functions/helm-authority/index.ts` — `Deno.serve`, CORS, JWT
  verification, the two clients.
- `npm run build:authority-function` bundles the kernel (rolldown, ~301 KiB)
  into `kernel.mjs` next to it (git-ignored build output).
- The demo runs the **same** service in-process (`host: 'in-process (demo)'`),
  so the UI exercises the trusted path in both modes.

### 6. What remains client-side

Reading. The client may still run the authority engine to *preview* ("what
would this need?"); a preview is never recorded.

## Consequences

- A tampered client can no longer record a verdict, a requirement or an
  approval act: the privileges are gone, and the one writer re-derives what it
  is told.
- There is now one server-side function to deploy, monitor and version.
  `verify:authority-server` checks the bundle refuses client-supplied facts
  and the schema keeps writes service-only.
- **The function is built but not deployed.** The architecture is accepted;
  deployment is not qualified. Deploying to the shared project waits on the
  [trusted runtime deployment gate](../architecture/trusted-runtime-deployment-gate.md).
  Until then the cloud decision page cannot record an evaluation or an
  approval (the direct writes are revoked, and are not re-enabled for testing).
- The service's cost is dominated by re-deriving the trace (14 steps in the
  canonical case), not by the engine.

## Alternatives rejected

- **Postgres functions for the verdict.** The engine, scope walk and decimal
  arithmetic would be reimplemented in PL/pgSQL — two implementations of the
  same judgement that must never disagree.
- **Trusting the client and auditing later.** An audit that finds a forged
  verdict after approval has already let the act through.
- **A standalone API service.** Still deferred (ADR-0003); one function is the
  smallest thing that closes the gap.
