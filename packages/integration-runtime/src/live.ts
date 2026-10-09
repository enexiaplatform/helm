/**
 * Live sync — HELM's reading of a source kept current without anyone pressing "Sync now".
 *
 * Something wakes it: the source announces that a row changed (a realtime notice), or
 * HELM itself wakes (it starts, regains focus, comes back online, or a slow fallback
 * tick fires). Every wake does the same thing: the ingestion pipeline runs from its
 * checkpoint, page after page, until it has caught up — and only when what HELM holds
 * changed, or no current state was ever composed, a new CURRENT state is composed.
 *
 * A notice carries no data and is never applied. HELM re-reads the source through the
 * same governed pipeline (drift, identity, provenance, checkpoint), so a missed,
 * duplicated or out-of-order notice cannot make HELM wrong — only late until the next
 * wake. The pipeline is idempotent, so an extra run changes nothing.
 *
 * Runs never overlap: a wake during a run marks it dirty and exactly one more run
 * follows. A failed run backs off and retries; it never moves the checkpoint.
 *
 * It only reads the source. It writes nothing outward and decides nothing.
 */

import type { Result } from '@helm/shared';
import type { SyncRecord } from './types.ts';

export type LiveSyncPhase = 'starting' | 'reading' | 'composing' | 'current' | 'failed' | 'stopped';

export type LiveSyncState = {
  readonly phase: LiveSyncPhase;
  /** Whether the source's change notices are reaching HELM. Without them HELM still catches up on every other wake. */
  readonly listening: boolean;
  /** The last pipeline run of the last pass. */
  readonly lastSync: SyncRecord | null;
  /** When HELM last finished catching up with the source. */
  readonly caughtUpAt: string | null;
  /** When HELM last composed a current state from what it read. */
  readonly composedAt: string | null;
  /** Bumped whenever a pass changed what HELM holds or composed a state — what a reader re-reads on. */
  readonly version: number;
  readonly error: string | null;
};

export type LiveSyncTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LiveSyncDeps = {
  /** One pipeline run of at most `pageSize` records, from the checkpoint. */
  runPage(pageSize: number): Promise<Result<SyncRecord>>;
  /**
   * A cheap read: does the source hold anything after the checkpoint? When it says no, the pass records no run —
   * the sync history holds what HELM took, not every time it looked. Without it, every pass runs the pipeline.
   */
  hasNews?(): Promise<Result<boolean>>;
  /** Whether a current state has ever been composed for this reader. */
  hasCurrentState(): Promise<Result<boolean>>;
  composeCurrentState(): Promise<Result<unknown>>;
  /** Listen for the source's change notices. Returns the way to stop listening. */
  subscribe(notify: () => void, listening: (on: boolean) => void): () => void;
  /** Serialize a whole pass with other HELM windows of the same reader. Default: run it directly. */
  exclusive?<T>(pass: () => Promise<T>): Promise<T>;
  onState?(state: LiveSyncState): void;
  now(): string;
  timers?: LiveSyncTimers;
  /** Default 100. */
  pageSize?: number;
  /** A pass stops after this many pages and resumes on the next wake. Default 50. */
  maxPages?: number;
  /** Notices arriving within this window become one pass. Default 1500 ms. */
  debounceMs?: number;
  /** The slow tick that catches anything a lost notice missed. Default 60 s. */
  fallbackMs?: number;
  /** The tick while the pipeline holds records it could not take (drift, quarantine): a notice still wakes it. Default 15 min. */
  stuckMs?: number;
  /** First retry after a failure; doubles to `fallbackMs`. Default 5 s. */
  retryMs?: number;
};

export interface LiveSync {
  start(): void;
  /** Ask for a pass. Wakes inside the debounce window, or during a pass, coalesce. */
  wake(): void;
  stop(): void;
  state(): LiveSyncState;
  /** Resolves when no pass is running or scheduled — for tests and for a caller that must wait. */
  idle(): Promise<void>;
}

/** Whether a pipeline run changed what HELM holds. Unchanged entities and observations are not change. */
export const syncChanged = (s: SyncRecord): boolean =>
  s.counts.entitiesCreated + s.counts.entitiesUpdated + s.counts.relationshipsCreated + s.counts.aliasesRegistered + s.counts.observationsRecorded > 0;

/** A run that may have more behind it: it took a full page cleanly and moved the checkpoint. */
const moreBehind = (s: SyncRecord, pageSize: number): boolean =>
  s.outcome === 'SUCCEEDED' && s.counts.records >= pageSize && s.cursorAfter !== s.cursorBefore;

const outcomeProblem = (s: SyncRecord): string | null =>
  s.outcome === 'SUCCEEDED'
    ? null
    : s.outcome === 'BLOCKED_BY_DRIFT'
      ? 'The source changed shape; ingestion is stopped until the contract is reviewed.'
      : s.outcome === 'PARTIAL'
        ? `${s.counts.quarantined} record(s) could not be taken; the checkpoint waits for them.`
        : 'The source could not be read; the checkpoint did not move.';

const realTimers: LiveSyncTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

export function createLiveSync(deps: LiveSyncDeps): LiveSync {
  const timers = deps.timers ?? realTimers;
  const pageSize = deps.pageSize ?? 100;
  const maxPages = deps.maxPages ?? 50;
  const debounceMs = deps.debounceMs ?? 1500;
  const fallbackMs = deps.fallbackMs ?? 60_000;
  const retryMs = deps.retryMs ?? 5_000;
  const stuckMs = Math.max(fallbackMs, deps.stuckMs ?? 15 * 60_000);
  const exclusive = deps.exclusive ?? (<T>(pass: () => Promise<T>) => pass());

  let state: LiveSyncState = { phase: 'starting', listening: false, lastSync: null, caughtUpAt: null, composedAt: null, version: 0, error: null };
  let started = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let dirty = false;
  let failures = 0;
  let wakeTimer: unknown = null;
  let tickTimer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  const waiters: (() => void)[] = [];

  const set = (patch: Partial<LiveSyncState>) => {
    state = { ...state, ...patch };
    deps.onState?.(state);
  };

  const settleIfIdle = () => {
    if (running || wakeTimer !== null) return;
    while (waiters.length > 0) waiters.shift()!();
  };

  const scheduleTick = (ms: number) => {
    if (stopped) return;
    if (tickTimer !== null) timers.clearTimeout(tickTimer);
    tickTimer = timers.setTimeout(() => {
      tickTimer = null;
      wake();
    }, ms);
  };

  /** One pass: catch up page by page, then compose if anything changed or nothing was ever composed. */
  const pass = async (): Promise<void> => {
    let changed = false;
    let last: SyncRecord | null = null;
    set({ phase: 'reading', error: null });
    let news = true;
    if (deps.hasNews) {
      const n = await deps.hasNews();
      if (!n.ok) throw new Error(n.error.message);
      news = n.value;
    }
    for (let page = 0; news && page < maxPages; page += 1) {
      const r = await deps.runPage(pageSize);
      if (!r.ok) throw new Error(r.error.message);
      last = r.value;
      changed = changed || syncChanged(r.value);
      set({ lastSync: r.value });
      if (!moreBehind(r.value, pageSize)) break;
    }
    const problem = last ? outcomeProblem(last) : null;
    let composedAt = state.composedAt;
    const held = await deps.hasCurrentState();
    if (!held.ok) throw new Error(held.error.message);
    if (changed || !held.value) {
      set({ phase: 'composing' });
      const c = await deps.composeCurrentState();
      if (!c.ok) throw new Error(c.error.message);
      composedAt = deps.now();
    }
    // A run the pipeline recorded as PARTIAL or BLOCKED is not a crash: what it took is held, and it is said out loud.
    set({
      phase: problem ? 'failed' : 'current',
      caughtUpAt: problem ? state.caughtUpAt : deps.now(),
      composedAt,
      error: problem,
      version: changed || composedAt !== state.composedAt ? state.version + 1 : state.version,
    });
  };

  const run = () => {
    if (stopped || running) return;
    dirty = false;
    running = (async () => {
      try {
        await exclusive(pass);
        failures = 0;
        // Records the pipeline could not take are re-read on every pass; ticking slower keeps a stuck source from filling the history.
        scheduleTick(state.phase === 'failed' ? stuckMs : fallbackMs);
      } catch (e) {
        failures += 1;
        set({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
        scheduleTick(Math.min(fallbackMs, retryMs * 2 ** (failures - 1)));
      } finally {
        running = null;
        if (dirty && !stopped) wake();
        else settleIfIdle();
      }
    })();
  };

  function wake() {
    if (stopped || !started) return;
    if (running) {
      dirty = true;
      return;
    }
    if (wakeTimer !== null) return;
    wakeTimer = timers.setTimeout(() => {
      wakeTimer = null;
      run();
    }, debounceMs);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribe = deps.subscribe(
        () => wake(),
        (on) => {
          if (!stopped) set({ listening: on });
        },
      );
      run();
    },
    wake,
    stop() {
      if (stopped) return;
      stopped = true;
      if (wakeTimer !== null) timers.clearTimeout(wakeTimer);
      if (tickTimer !== null) timers.clearTimeout(tickTimer);
      wakeTimer = null;
      tickTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      set({ phase: 'stopped', listening: false });
      settleIfIdle();
    },
    state: () => state,
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        settleIfIdle();
      });
    },
  };
}
