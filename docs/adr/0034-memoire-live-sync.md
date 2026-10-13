# ADR-0034: Memoire live sync — a change notice wakes HELM; HELM re-reads, it never applies the notice

**Status** accepted, amends [ADR-0030](0030-integration-fabric.md) · **Date** 2026-10-08 · **Deciders** Architecture ·
**Phase** integration ·
[helm-vs-memoire](../architecture/helm-vs-memoire.md) ·
[integration fabric layer](../architecture/layers/integration-fabric.md)

## Context

ADR-0030 built the integration fabric and left a cloud sync to a "Sync now"
button. In the cloud nothing pressed it: the first real organization had 100
Memoire opportunities, zero syncs, and no CURRENT twin state — so the Cockpit
said "No current enterprise state is visible to this reader yet" over a Memoire
workspace that was full and changing daily. Nothing in the cloud composed a
CURRENT snapshot at all; `buildCurrentSnapshot` existed and had no caller.

The user's requirement: what they change in Memoire must appear in HELM by
itself, in real time.

## Problem

Make HELM current with Memoire without anyone pressing anything, and without
giving up any guarantee of ADR-0030 or of the Memoire boundary:

- HELM never writes to Memoire and never alters a Memoire-owned object.
- Every fact still enters through the governed pipeline (drift, identity,
  provenance, checkpoint). Source Truth ≠ Model Truth.
- A user sees only their own Memoire rows (Memoire RLS).
- The sync history stays a record of what HELM took, not of every time it looked.

## Options considered

1. **A database trigger on `opportunities` calling a server function.** True
   server-side push, but it attaches HELM code to a Memoire table's write path
   (a failing trigger could break Memoire writes), and the server function would
   need to read across users with elevated rights. Rejected: it crosses the
   boundary in both directions.
2. **Polling only.** No database change, but "real time" becomes "within a
   minute", and every poll is a pipeline run in the history.
3. **Supabase Realtime notices + re-read through the pipeline (chosen).** Add
   `opportunities` to the `supabase_realtime` publication. A notice that one of
   the reader's opportunities changed wakes HELM; HELM re-reads from its
   checkpoint through the unchanged pipeline. Polling stays as the fallback.

## Decision

### 1. The notice is a wake-up, never data

`@helm/integration-runtime` gains `createLiveSync` (`src/live.ts`), a pure
scheduler over ports. Something wakes it — a Realtime notice, start, focus,
reconnect, or a 60 s fallback tick — and every wake does the same pass:

1. a cheap probe: does the source hold anything after the checkpoint? If not,
   nothing is run and nothing is recorded;
2. otherwise the pipeline runs page by page from its checkpoint until caught up
   (at most 50 pages a pass; the next wake resumes);
3. a new CURRENT enterprise state is composed **only** when what HELM holds
   changed (entities, identities, relationships or source observations), or no
   current state was ever composed for this reader.

The notice's payload is ignored. A missed, duplicated or out-of-order notice can
make HELM late until the next wake, never wrong.

Passes never overlap: wakes inside the 1.5 s debounce or during a pass coalesce
into exactly one more pass. HELM windows of the same reader serialize passes
with the browser's Web Locks. A failed pass backs off (5 s doubling to 60 s); a
pass the pipeline recorded as PARTIAL or BLOCKED_BY_DRIFT is said out loud and
ticks every 15 min, so a stuck source does not fill the history.

### 2. The one publication statement about a Memoire table

Migration `20261008090000_helm_memoire_realtime.sql` adds `public.opportunities`
to `supabase_realtime`, idempotently. It changes no column, constraint, trigger,
policy, grant or row; Memoire behaves exactly as before; dropping it again
changes nothing in Memoire either. Realtime applies the table's own SELECT policy
to each subscriber, so a reader hears only their own opportunities.

`verify:memoire-boundary` holds this: rule 6 allows exactly
`ALTER PUBLICATION supabase_realtime ADD TABLE public.opportunities` and fails any
other publication statement naming a Memoire table, and fails any
`postgres_changes` listener on a Memoire table outside
`src/services/memoireBridge.ts`.

### 3. Where it runs

The app wires the ports (`src/services/memoireLiveSync.ts`): the cloud pipeline
and checkpoint store of `integrationRuntime.ts`, the cloud twin's
`buildCurrentSnapshot` over the ENTERPRISE scope, and the bridge's
`subscribeToMemoireOpportunities`. The routed console starts it for a signed-in
reader on a cloud organization and stops it on sign-out or org change. The demo
has no live source. The console strip says how current HELM is ("Memoire live ·
current at …", in brick when a pass failed); the Cockpit, Twin and Sources pages
re-read when a pass changed something. "Sync now" asks the live sync for a pass
instead of running a second, uncomposed one.

## Consequences

- What a reader changes in Memoire appears in HELM within seconds while HELM is
  open, and on the next open otherwise. HELM is not a server process: with no
  HELM window open nothing runs, and nothing is lost — the checkpoint resumes.
- Each composed CURRENT state is a full twin snapshot; one is composed per pass
  that changed something, not per notice.
- Deletions in Memoire are not ingested (unchanged from ADR-0030: the pipeline
  reads rows after a cursor). A deleted opportunity stays in HELM as last read.
- Only `opportunities` is published. Other Memoire tables HELM may read later
  need their own ADR and their own allowed statement.

## Migration implications

One additive, idempotent migration, applied to the shared project via the live
DB proof protocol (pre/post fingerprint unchanged; HELM tables and policies
unchanged; publication membership checked). No HELM table, policy or function
changes.

## Amendment 2026-10-12 — a page is ingested side by side

A manager's first sign-in after the 0.3.0 connector reset its checkpoint waited
about seven minutes (five pages of twenty, each record a dozen sequential round
trips), and every page showed the previous state's warnings meanwhile. The
pipeline now translates a page first, writes what more than one record names (a
customer, its segment, their membership) once per mention in record order, and
ingests what belongs to one record alone eight at a time
(`IngestionPipelineDeps.concurrency`). A record whose facts land on a shared
subject still runs alone. Counts, writes and idempotency are those of the
sequential run (`integration-runtime/test/concurrency.test.mjs`). Until the
session's first pass catches up, the Cockpit names the boundary of the state it
shows instead of passing it off as current.

## Amendment 2026-10-13 — read on Refresh, and hold reads for the session

Opening the Cockpit took seconds. The edge logs for one open (13 Oct, 12:50 UTC)
show ~300 requests: each genome table read 15 times, `helm_decisions` 9,
`org_units` 8, the causal tables 5 — every runtime re-read its tables whole for
every projection — while the live pass ran beside it on open.

- The live sync now runs **manual** (`createLiveSync({ manual: true })`): no
  Realtime subscription, no focus/online/visibility wake, no fallback tick, no
  automatic retry. It reads when the reader presses **Refresh** (shell header)
  or **Sync now** (Sources), when HELM itself changed what the state is composed
  from (`recomposeCurrentState`), and on open only when no CURRENT state was ever
  composed. The rest of this ADR (re-read, never apply; one governed pipeline;
  compose only on change) is unchanged.
- HELM's REST reads are held for the session (`src/lib/readCache.ts`, the
  Supabase client's fetch): identical reads share one request and later ones are
  answered from memory. Any write (POST/PATCH/DELETE, every RPC) drops all of it,
  and a read in flight across a write is not kept, so HELM never shows less than
  its own last act. Refresh and sign-out drop it too. Reads are keyed by the
  bearer token.
- Cost: what others change — in Memoire or in HELM — reaches this reader on
  Refresh, not by itself. The header says when Memoire was last read.
