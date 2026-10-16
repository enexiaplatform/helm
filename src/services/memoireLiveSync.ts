/**
 * Memoire → HELM, on Refresh (ADR-0034, manual since 2026-10-13).
 *
 * HELM no longer re-reads Memoire by itself — not on open, focus, a Realtime notice or a tick: that work ran on every
 * page open and made it slow. It reads when the reader presses Refresh (or "Sync now"), and on open only when no
 * current state was ever composed. Each read runs the SAME governed ingestion pipeline (drift, identity, provenance,
 * checkpoint) and, when what HELM holds changed, composes a new CURRENT enterprise state for the Cockpit and the
 * Twin. A change made inside HELM (a decision act, a model run) still asks for a recompose. Refresh also drops every
 * read HELM holds for the session (src/lib/readCache.ts), so what others changed in HELM shows too. The scheduling
 * lives in @helm/integration-runtime (`createLiveSync`, manual); this module only wires its ports.
 *
 * It reads Memoire and writes only HELM's own records. It never writes into Memoire.
 */

import { create } from 'zustand';
import { createLiveSync, type LiveSync, type LiveSyncState } from '@helm/integration-runtime';
import { fail, ok, type Scope } from '@helm/shared';
import { subscribeToMemoireOpportunities } from './memoireBridge.ts';
import { supabaseClient } from '../lib/supabaseClient.ts';
import { clearReadCache } from '../lib/readCache.ts';
import { resolveIntegrationContext, sourceHasNews } from './integrationRuntime.ts';
import { buildCurrentSnapshot, listSnapshots } from './twinRuntime.ts';

/** `readEpoch`: bumped when a Refresh finishes — the page is read again from scratch. `refreshing`: one is running. */
/** `lastReadAt`: when HELM last took anything from Memoire, from its own sync history — so the bar can say how old it is. */
type LiveStore = LiveSyncState & { readonly orgId: string | null; readonly readEpoch: number; readonly refreshing: boolean; readonly lastReadAt: string | null };

const initial: LiveStore = { orgId: null, phase: 'stopped', listening: false, lastSync: null, caughtUpAt: null, composedAt: null, version: 0, error: null, readEpoch: 0, refreshing: false, lastReadAt: null };

/** What the console and the pages read: the live sync's state, and a version to re-read on. */
export const useMemoireLive = create<LiveStore>(() => initial);

const asMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The console's running live sync, if any — so "Sync now" asks it for a pass instead of running a second, uncomposed one. */
let active: LiveSync | null = null;

/** Ask the running sync for a pass now. False when none is running (the demo, or signed out). */
export function wakeMemoireLiveSync(): boolean {
  if (!active) return false;
  clearReadCache();
  active.wake();
  return true;
}

/**
 * Refresh: drop every read HELM holds, read Memoire's changes through the pipeline, compose a new current state when
 * something changed, then have the page read again. Without a running sync (the demo) it only re-reads the page.
 */
export async function refreshFromMemoire(): Promise<void> {
  const live = active;
  if (useMemoireLive.getState().refreshing) return;
  useMemoireLive.setState({ refreshing: true });
  try {
    clearReadCache();
    if (live) {
      live.wake();
      await live.idle();
    }
  } finally {
    useMemoireLive.setState((s) => ({ refreshing: false, readEpoch: s.readEpoch + 1 }));
  }
}

/**
 * Something HELM holds changed inside HELM — a model run, a baseline simulation, a decision act — so the current state
 * is older than what it claims to show. Ask the running live sync to compose a new one. False when none is running.
 */
export function recomposeCurrentState(): boolean {
  if (!active) return false;
  active.recompose();
  return true;
}

/**
 * The latest moment something the current state is composed from changed inside HELM: a decision act (its timeline is
 * append-only, so every act leaves an event), a model run, a simulation. Read by the live sync each pass, so a state
 * older than it is composed again even when the window that made the change closed first.
 */
async function latestKernelChange(orgId: string): Promise<string | null> {
  if (!supabaseClient) return null;
  const sb = supabaseClient;
  const newest = async (table: string, column: string): Promise<string | null> => {
    const { data, error } = await sb.from(table).select(column).eq('org_id', orgId).not(column, 'is', null).order(column, { ascending: false }).limit(1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const row = (data as unknown as Record<string, string>[] | null)?.[0];
    return row ? row[column] ?? null : null;
  };
  const times = await Promise.all([
    newest('helm_decision_events', 'created_at'),
    // A state change writes its event before the decision row moves, so the event alone can predate the change itself.
    newest('helm_decisions', 'updated_at'),
    newest('helm_calculation_runs', 'completed_at'),
    newest('helm_scenario_runs', 'completed_at'),
  ]);
  return times.filter((x): x is string => x !== null).reduce<string | null>((m, x) => (m === null || Date.parse(x) > Date.parse(m) ? x : m), null);
}

/** Serialize passes across this reader's HELM windows, where the browser can. A second window waits, then finds nothing new. */
function exclusiveFor(key: string) {
  return <T,>(pass: () => Promise<T>): Promise<T> => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    return locks ? (locks.request(key, pass) as Promise<T>) : pass();
  };
}

/**
 * Start keeping HELM current with Memoire for one reader in one organization. Returns the live sync (to wake it)
 * and the way to stop it. Nothing starts when the cloud is unavailable.
 */
/**
 * A Refresh that finds nothing new in Memoire records no sync, so the sync history alone dates the bar to the last read
 * that CHANGED something (live audit 2026-10-16: refreshed at 23:53, reopened, "last read 14:27, 9 h ago"). The last
 * check is kept per organization and reader in this browser; it only ever dates the bar, never a figure.
 */
const checkedKey = (orgId: string, userId: string) => `helm.memoire.checkedAt.${orgId}.${userId}`;
const readChecked = (orgId: string, userId: string): string | null => {
  try {
    return localStorage.getItem(checkedKey(orgId, userId));
  } catch {
    return null;
  }
};
const keepChecked = (orgId: string, userId: string, at: string) => {
  try {
    localStorage.setItem(checkedKey(orgId, userId), at);
  } catch {
    // Storage blocked: the bar falls back to the sync history.
  }
};

export function startMemoireLiveSync(scope: Scope): { live: LiveSync | null; stop: () => void } {
  const orgId = String(scope.orgId);
  const userId = String(scope.actorId);
  useMemoireLive.setState({ ...initial, orgId, phase: 'starting', readEpoch: useMemoireLive.getState().readEpoch });
  // The contexts are resolved once per start: the pipeline, its checkpoint store and the twin are all cloud-backed.
  const contexts = resolveIntegrationContext('cloud', scope).catch(() => null);
  // The last read on record (audit 2026-10-13: the bar said "as last read" and not when).
  void contexts.then(async (ctx) => {
    if (!ctx) return;
    const syncs = await ctx.store.listSyncs(ctx.scope, { system: 'memoire' });
    if (!syncs.ok || useMemoireLive.getState().orgId !== orgId) return;
    const last = [readChecked(orgId, userId), ...syncs.value.filter((x) => x.outcome === 'SUCCEEDED' || x.outcome === 'PARTIAL').map((x) => x.recordedAt)].reduce<string | null>((m, x) => (x !== null && (m === null || x > m) ? x : m), null);
    if (last) useMemoireLive.setState((st) => ({ lastReadAt: st.lastReadAt && st.lastReadAt > last ? st.lastReadAt : last }));
  });

  const live = createLiveSync({
    // Nothing reads Memoire by itself: Refresh, "Sync now" and HELM's own changes ask (see the header).
    manual: true,
    debounceMs: 0,
    // Each record is several sequential reads and writes; a small page moves the checkpoint often, so a window closed
    // mid-way through a first read resumes where it stopped instead of re-reading everything.
    pageSize: 20,
    runPage: async (limit) => {
      const ctx = await contexts;
      if (!ctx) return fail('integration.no_client', 'HELM cannot reach the cloud to read Memoire.');
      return ctx.pipeline.run(ctx.scope, ctx.adapter, { limit });
    },
    hasNews: async () => {
      const ctx = await contexts;
      if (!ctx) return fail('integration.no_client', 'HELM cannot reach the cloud to read Memoire.');
      try {
        return ok(await sourceHasNews(ctx));
      } catch (e) {
        return fail('integration.read_failed', asMessage(e));
      }
    },
    hasCurrentState: async () => {
      const ctx = await contexts;
      if (!ctx) return fail('integration.no_client', 'HELM cannot reach the cloud to read its twin.');
      try {
        const all = await listSnapshots(ctx.twin);
        return ok(all.some((s) => s.spec.kind === 'CURRENT' && String(s.builtBy) === userId));
      } catch (e) {
        return fail('twin.read_failed', `The enterprise states could not be listed: ${asMessage(e)}`);
      }
    },
    isCurrentStateStale: async () => {
      const ctx = await contexts;
      if (!ctx) return fail('integration.no_client', 'HELM cannot reach the cloud to read its twin.');
      try {
        const all = await listSnapshots(ctx.twin);
        const latest = all.filter((s) => s.spec.kind === 'CURRENT').reduce<string | null>((m, s) => (m === null || s.createdAt > m ? s.createdAt : m), null);
        if (latest === null) return ok(false);
        const changed = await latestKernelChange(orgId);
        return ok(changed !== null && Date.parse(changed) > Date.parse(latest));
      } catch (e) {
        return fail('twin.read_failed', `Whether the current state is current could not be read: ${asMessage(e)}`);
      }
    },
    composeCurrentState: async () => {
      const ctx = await contexts;
      if (!ctx) return fail('integration.no_client', 'HELM cannot reach the cloud to compose a state.');
      const enterprise = ctx.twin.scopes[0];
      if (!enterprise) return fail('twin.no_scope', 'The organization has no enterprise scope to compose.');
      try {
        return ok(await buildCurrentSnapshot(ctx.twin, enterprise));
      } catch (e) {
        return fail('twin.compose_failed', `The current enterprise state could not be composed: ${asMessage(e)}`);
      }
    },
    subscribe: (notify, listening) => subscribeToMemoireOpportunities(userId, notify, listening),
    exclusive: exclusiveFor(`helm:memoire-live:${orgId}:${userId}`),
    onState: (s) => {
      // A state from a sync that was already replaced (another org, a sign-out) is not this console's state.
      if (useMemoireLive.getState().orgId !== orgId) return;
      if (s.caughtUpAt) keepChecked(orgId, userId, s.caughtUpAt);
      useMemoireLive.setState({ ...s, ...(s.caughtUpAt ? { lastReadAt: s.caughtUpAt } : {}) });
    },
    now: () => new Date().toISOString(),
  });
  live.start();
  active = live;
  return {
    live,
    stop: () => {
      live.stop();
      if (active === live) active = null;
      if (useMemoireLive.getState().orgId === orgId) useMemoireLive.setState({ ...initial, readEpoch: useMemoireLive.getState().readEpoch });
    },
  };
}

/** One line for the console strip: what HELM knows about its reading of Memoire, said plainly. */
export function liveSyncLine(s: LiveSyncState & { readonly lastReadAt?: string | null }, clock: (iso: string) => string, nowIso: string = new Date().toISOString()): { text: string; failed: boolean; stale?: boolean } | null {
  const age = (iso: string): { words: string; stale: boolean } => {
    const h = (Date.parse(nowIso) - Date.parse(iso)) / 3_600_000;
    if (h < 1) return { words: 'less than an hour ago', stale: false };
    if (h < 24) return { words: `${Math.floor(h)} h ago`, stale: false };
    const d = Math.floor(h / 24);
    return { words: `${d} ${d === 1 ? 'day' : 'days'} ago`, stale: true };
  };
  switch (s.phase) {
    case 'stopped':
      return null;
    case 'idle': {
      if (!s.lastReadAt) return { text: 'Memoire · press Refresh to read new changes', failed: false };
      const a = age(s.lastReadAt);
      return { text: `Memoire · last read ${clock(s.lastReadAt)}, ${a.words}${a.stale ? ' — press Refresh' : ''}`, failed: false, stale: a.stale };
    }
    case 'starting':
    case 'reading':
      return { text: 'Memoire · reading changes…', failed: false };
    case 'composing':
      return { text: 'Memoire · composing the current state…', failed: false };
    case 'current':
      return { text: `Memoire · read at ${s.caughtUpAt ? clock(s.caughtUpAt) : '—'}`, failed: false };
    case 'failed':
      return { text: `Memoire · ${s.error ?? 'the last read failed'} Refresh to try again.`, failed: true };
  }
}
