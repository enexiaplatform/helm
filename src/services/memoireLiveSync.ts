/**
 * Memoire → HELM, live (ADR-0034).
 *
 * While a signed-in reader has HELM open on a cloud organization, HELM keeps its reading of their Memoire
 * opportunities current by itself: on open, on regaining focus or the network, on every Realtime notice that one
 * of their opportunities changed, and on a slow fallback tick. Each wake runs the SAME governed ingestion pipeline
 * "Sync now" runs (drift, identity, provenance, checkpoint) and, when what HELM holds changed, composes a new
 * CURRENT enterprise state for the Cockpit and the Twin. The scheduling lives in @helm/integration-runtime
 * (`createLiveSync`); this module only wires its ports.
 *
 * It reads Memoire and writes only HELM's own records. It never writes into Memoire.
 */

import { create } from 'zustand';
import { createLiveSync, type LiveSync, type LiveSyncState } from '@helm/integration-runtime';
import { fail, ok, type Scope } from '@helm/shared';
import { subscribeToMemoireOpportunities } from './memoireBridge.ts';
import { resolveIntegrationContext, sourceHasNews } from './integrationRuntime.ts';
import { buildCurrentSnapshot, listSnapshots } from './twinRuntime.ts';

type LiveStore = LiveSyncState & { readonly orgId: string | null };

const initial: LiveStore = { orgId: null, phase: 'stopped', listening: false, lastSync: null, caughtUpAt: null, composedAt: null, version: 0, error: null };

/** What the console and the pages read: the live sync's state, and a version to re-read on. */
export const useMemoireLive = create<LiveStore>(() => initial);

const asMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The console's running live sync, if any — so "Sync now" asks it for a pass instead of running a second, uncomposed one. */
let active: LiveSync | null = null;

/** Ask the running live sync for a pass now. False when none is running (the demo, or signed out). */
export function wakeMemoireLiveSync(): boolean {
  if (!active) return false;
  active.wake();
  return true;
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
export function startMemoireLiveSync(scope: Scope): { live: LiveSync | null; stop: () => void } {
  const orgId = String(scope.orgId);
  const userId = String(scope.actorId);
  useMemoireLive.setState({ ...initial, orgId, phase: 'starting' });
  // The contexts are resolved once per start: the pipeline, its checkpoint store and the twin are all cloud-backed.
  const contexts = resolveIntegrationContext('cloud', scope).catch(() => null);

  const live = createLiveSync({
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
      if (useMemoireLive.getState().orgId === orgId) useMemoireLive.setState(s);
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
      if (useMemoireLive.getState().orgId === orgId) useMemoireLive.setState(initial);
    },
  };
}

/** One line for the console strip: what HELM knows about its reading of Memoire, said plainly. */
export function liveSyncLine(s: LiveSyncState, clock: (iso: string) => string): { text: string; failed: boolean } | null {
  switch (s.phase) {
    case 'stopped':
      return null;
    case 'starting':
    case 'reading':
      return { text: 'Memoire · reading changes…', failed: false };
    case 'composing':
      return { text: 'Memoire · composing the current state…', failed: false };
    case 'current':
      return { text: `Memoire ${s.listening ? 'live' : 'polling'} · current at ${s.caughtUpAt ? clock(s.caughtUpAt) : '—'}`, failed: false };
    case 'failed':
      return { text: `Memoire · ${s.error ?? 'the last read failed'} Retrying.`, failed: true };
  }
}
