# ADR-0003: Postgres via Supabase as the system of record; defer a standalone API service

**Status** accepted · **Date** 2026-09-19 · **Deciders** Architecture ·
**Phase** 0

## Context

The brief's recommended stack (§9) is Node + Fastify or NestJS, PostgreSQL,
Drizzle or Prisma, Redis + BullMQ, REST — while explicitly allowing deviation
where "the repository already has justified architectural decisions".

HELM has such decisions, and they are load-bearing:

- HELM and Memoire **share one Supabase project** (`mlmpcpkucurylkrobain`)
  holding live production data: 1,106 accounts, 127 opportunities, 1,752
  stakeholders.
- They share **one identity system** (`auth.users`). A manager signs in once.
- Tenant isolation is **RLS in Postgres** — `is_org_member`, `has_org_role`,
  `org_role_rank` as `SECURITY DEFINER` helpers, ranked roles, org-scoped
  predicates on every table.
- `helm_decision_events` is append-only *because it has no UPDATE or DELETE
  policy* — a database-level guarantee, not application discipline.

The shared database is the strategic asset: it is what makes the Memoire
integration zero-latency and referentially sound instead of an ETL project.

## Problem

Does HELM adopt the prescribed Fastify/Drizzle/Redis stack, or keep
Postgres-via-Supabase and defer the API service?

## Options considered

1. **Full prescribed stack now.** Fastify + Drizzle + Redis, Supabase reduced to
   plain Postgres hosting or replaced. Cost: authorization moves from RLS into
   application code — strictly weaker, since the database currently refuses
   cross-tenant reads regardless of client bugs. Loses shared identity unless
   federation is built. Discards a working 7,300-line app. Adds a server to
   operate and secure. Buys: vendor independence and a place for server-only
   logic — neither of which is needed yet.
2. **Keep Supabase, add Fastify in front for everything.** The HTTP layer would
   re-implement the authorization RLS already enforces, in a weaker place, and
   every new table would need both a policy and an endpoint. Two sources of
   authorization truth is worse than one.
3. **Keep Supabase as the system of record. Add a worker when scheduled work
   exists. Add an API service only when a named trigger fires.** Preserves shared
   DB and identity, keeps isolation in the strongest available layer, and matches
   the brief's own "avoid premature infrastructure" guidance (§8).
4. **Swap Supabase for self-hosted Postgres + Drizzle, keep the SPA.** Gains ORM
   typing and vendor independence; loses RLS-integrated auth and shared identity;
   requires re-implementing authorization. Highest cost, least current benefit.

## Decision

**Option 3.**

- **Postgres (via Supabase) is the system of record.** Tenant isolation stays in
  RLS.
- **All kernel database access goes through the `GraphStore` port**
  ([ADR-0004](0004-graph-abstraction-layer.md)). No kernel package imports
  `@supabase/supabase-js`. Supabase is confined to one adapter, which is what
  keeps option 1 or 4 available later at adapter cost rather than rewrite cost.
- **No ORM.** Drizzle/Prisma would duplicate the schema in a second place while
  RLS remains the authority. Typed SQL inside the adapter, with generated types
  from the live schema.
- **`services/worker` arrives in Phase 3**, when scheduled propagation and
  ingestion need to run outside a browser session.
- **`services/api` is deferred** until one of four named triggers fires:
  1. Server-only secrets — an LLM provider key must never reach a client
     (Phase 11).
  2. Webhook ingestion — a source system pushes rather than being pulled
     (Phase 13+).
  3. Cross-user org-wide reads that Memoire's `user_id` RLS cannot serve
     ([helm-vs-memoire.md §3.1](../architecture/helm-vs-memoire.md#31-two-different-tenancy-models-in-one-database)).
  4. A non-browser consumer needs HELM's API.
- **Redis/BullMQ deferred.** Postgres-backed job rows with `SKIP LOCKED` suffice
  for management-cadence work, which is hourly-to-daily, not per-request. Redis
  arrives if throughput demands it.

Trigger 1 is the likeliest and lands in Phase 11, so the API service is expected
— just not before there is something for it to do.

## Consequences

**Good.** Shared identity and zero-latency Memoire integration preserved.
Isolation stays in the strongest layer available. No server to operate during the
phases that matter most. The existing app keeps working. The `GraphStore` port
keeps every alternative open.

**Bad.** Vendor coupling to Supabase, confined to one adapter. No ORM means
hand-written SQL in that adapter. Business logic that truly must be server-side
has nowhere to live until the worker exists.

**Risk — RLS policy complexity.** Unit- and function-level visibility (Phase 6)
will make policies harder to reason about. Mitigation: `SECURITY DEFINER` helpers
keep each policy a single expression, and `verify:rls-coverage` asserts every
table's policy set.

**Risk — the browser holds too much logic.** Today's store performs
read-compute-write cycles that belong server-side once concurrency matters.
Mitigation: propagation moves to the worker in Phase 3.

## Migration implications

- No database migration. The schema stays; `helm_*` tables are empty and may be
  reshaped freely in Phases 1–3.
- Every migration remains **strictly additive** with respect to Memoire tables.
  `verify:additive-migrations` asserts no `DROP` or `ALTER` targets one.
- Should trigger 3 or 4 fire, the API service is added *beside* the SPA, not in
  front of it — Supabase continues serving reads that RLS already secures.
- Should Supabase itself need replacing, the work is one new `GraphStore` adapter
  plus an auth migration. The kernel does not change.
