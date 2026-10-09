/**
 * Live sync: a change notice or a wake re-reads the source through the governed pipeline,
 * catches up page by page, composes a current state only when something changed, never
 * overlaps itself and never applies a notice's payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSync, syncChanged } from '../src/index.ts';
import { buildIntegrationStack, row, unwrap } from './harness.mjs';

const at = (i) => `2026-10-01T02:${String(i).padStart(2, '0')}:00.000Z`;

/** The real pipeline over a fixture Memoire, with the twin side and the notice channel as fakes the test can see. */
async function liveStack(options = {}) {
  const s = await buildIntegrationStack();
  const calls = { pages: [], composed: 0, passes: 0 };
  let composedEver = options.composedBefore ?? false;
  let notify = () => {};
  let setListening = () => {};
  let unsubscribed = 0;
  const live = createLiveSync({
    runPage: async (limit) => {
      if (options.failPages && options.failPages.length > 0 && options.failPages.shift()) return { ok: false, error: { code: 'integration.read_failed', message: 'the source is unreachable' } };
      const r = await s.pipeline.run(s.scope, s.adapter, { limit });
      if (r.ok) calls.pages.push(r.value);
      // The source changes after HELM read the page; a real pass then takes time, so timers fire while it still runs.
      options.duringPage?.();
      if (options.slowMs) await new Promise((res) => setTimeout(res, options.slowMs));
      return r;
    },
    hasNews: options.probe
      ? async () => {
          calls.probes = (calls.probes ?? 0) + 1;
          const cp = await s.integrationStore.checkpointOf(s.scope, s.adapter.system, s.adapter.connector);
          if (!cp.ok) return cp;
          const next = await s.adapter.pull(s.scope, cp.value.cursor, 1);
          return next.ok ? { ok: true, value: next.value.records.length > 0 } : next;
        }
      : undefined,
    hasCurrentState: async () => ({ ok: true, value: composedEver }),
    composeCurrentState: async () => {
      calls.composed += 1;
      composedEver = true;
      return { ok: true, value: null };
    },
    subscribe: (n, l) => {
      notify = n;
      setListening = l;
      return () => {
        unsubscribed += 1;
      };
    },
    exclusive: async (pass) => {
      calls.passes += 1;
      return pass();
    },
    now: () => new Date().toISOString(),
    // Unref'd: a test that fails before stop() must not hold the process open on the fallback tick.
    timers: {
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      },
      clearTimeout: (h) => clearTimeout(h),
    },
    pageSize: options.pageSize ?? 2,
    debounceMs: 1,
    retryMs: 1,
    fallbackMs: 1e9,
  });
  return { s, live, calls, notify: () => notify(), listening: (on) => setListening(on), unsubscribed: () => unsubscribed };
}

describe('live sync catches up and composes only on change', () => {
  it('on start it reads every page from the checkpoint, then composes one current state', async () => {
    const t = await liveStack();
    for (let i = 1; i <= 5; i += 1) t.s.reader.rows.push(row({ id: `opp-${i}`, account_id: `acc-${i}`, updated_at: at(i) }));
    t.live.start();
    await t.live.idle();
    assert.deepEqual(t.calls.pages.map((p) => p.counts.records), [2, 2, 1]);
    assert.ok(t.calls.pages.every((p) => p.outcome === 'SUCCEEDED'));
    assert.equal(t.calls.composed, 1);
    assert.equal(t.calls.passes, 1, 'one pass, however many pages');
    const st = t.live.state();
    assert.equal(st.phase, 'current');
    assert.equal(st.version, 1);
    assert.ok(st.caughtUpAt && st.composedAt);
    assert.equal(st.error, null);
    t.live.stop();
  });

  it('a wake with nothing new reads once and composes nothing: the version does not move', async () => {
    const t = await liveStack();
    t.s.reader.rows.push(row({ id: 'opp-1', updated_at: at(1) }));
    t.live.start();
    await t.live.idle();
    const before = t.calls.pages.length;
    t.notify();
    await t.live.idle();
    assert.equal(t.calls.pages.length, before + 1);
    assert.equal(t.calls.pages.at(-1).counts.records, 0);
    assert.equal(syncChanged(t.calls.pages.at(-1)), false);
    assert.equal(t.calls.composed, 1);
    assert.equal(t.live.state().version, 1);
    t.live.stop();
  });

  it('a change in the source arrives through the pipeline, not through the notice, and composes a new state', async () => {
    const t = await liveStack();
    t.s.reader.rows.push(row({ id: 'opp-1', pipeline_probability: 50, updated_at: at(1) }));
    t.live.start();
    await t.live.idle();
    t.s.reader.rows[0] = { ...t.s.reader.rows[0], pipeline_probability: 70, updated_at: at(9) };
    t.notify();
    await t.live.idle();
    const last = t.calls.pages.at(-1);
    assert.equal(last.counts.records, 1);
    assert.equal(last.counts.observationsRecorded, 1, 'the moved probability is one new SOURCE observation');
    assert.equal(t.calls.composed, 2);
    assert.equal(t.live.state().version, 2);
    t.live.stop();
  });

  it('with a probe, a wake that finds nothing after the checkpoint records no run at all', async () => {
    const t = await liveStack({ probe: true });
    t.s.reader.rows.push(row({ id: 'opp-1', updated_at: at(1) }));
    t.live.start();
    await t.live.idle();
    const runs = unwrap(await t.s.integrationStore.listSyncs(t.s.scope, { system: 'memoire' }), 'history').length;
    assert.equal(runs, 1);
    t.notify();
    await t.live.idle();
    t.notify();
    await t.live.idle();
    assert.equal(unwrap(await t.s.integrationStore.listSyncs(t.s.scope, { system: 'memoire' }), 'history').length, runs, 'looking is not a run');
    assert.equal(t.calls.probes, 3);
    assert.equal(t.live.state().phase, 'current');
    // Something new: the probe lets the pipeline run, and it is recorded.
    t.s.reader.rows.push(row({ id: 'opp-2', updated_at: at(2) }));
    t.notify();
    await t.live.idle();
    assert.equal(unwrap(await t.s.integrationStore.listSyncs(t.s.scope, { system: 'memoire' }), 'history').length, runs + 1);
    assert.equal(t.calls.composed, 2);
    t.live.stop();
  });

  it('nothing changed but no current state was ever composed: it composes one', async () => {
    const t = await liveStack({ composedBefore: false });
    t.live.start();
    await t.live.idle();
    assert.equal(t.calls.pages.at(-1).counts.records, 0);
    assert.equal(t.calls.composed, 1);
    t.live.stop();
  });

  it('a current state already held and nothing new: it composes nothing', async () => {
    const t = await liveStack({ composedBefore: true });
    t.live.start();
    await t.live.idle();
    assert.equal(t.calls.composed, 0);
    assert.equal(t.live.state().version, 0);
    assert.equal(t.live.state().phase, 'current');
    t.live.stop();
  });
});

describe('live sync never overlaps and never trusts a notice', () => {
  it('a change announced while a pass is running is read by exactly one more pass', async () => {
    let t;
    let changedOnce = false;
    t = await liveStack({
      pageSize: 100,
      slowMs: 20,
      // Memoire changes while HELM is mid-read, and says so five times.
      duringPage: () => {
        if (changedOnce) return;
        changedOnce = true;
        t.s.reader.rows.push(row({ id: 'opp-2', updated_at: at(2) }));
        for (let i = 0; i < 5; i += 1) t.notify();
      },
    });
    t.s.reader.rows.push(row({ id: 'opp-1', updated_at: at(1) }));
    t.live.start();
    await t.live.idle();
    assert.equal(t.calls.passes, 2, 'the first pass, then one for all five notices');
    const ingested = t.calls.pages.reduce((n, p) => n + p.counts.records, 0);
    assert.equal(ingested, 2, 'the row that arrived mid-pass was read, not lost');
    t.live.stop();
  });

  it('notices inside the debounce window become one pass', async () => {
    const t = await liveStack({ pageSize: 100 });
    t.live.start();
    await t.live.idle();
    const passes = t.calls.passes;
    t.notify();
    t.notify();
    t.notify();
    await t.live.idle();
    assert.equal(t.calls.passes, passes + 1);
    t.live.stop();
  });

  it('whether notices reach HELM is said, and stopping stops listening', async () => {
    const t = await liveStack();
    t.live.start();
    t.listening(true);
    assert.equal(t.live.state().listening, true);
    await t.live.idle();
    t.live.stop();
    assert.equal(t.unsubscribed(), 1);
    assert.equal(t.live.state().phase, 'stopped');
    assert.equal(t.live.state().listening, false);
    const passes = t.calls.passes;
    t.notify();
    await t.live.idle();
    assert.equal(t.calls.passes, passes, 'a notice after stop does nothing');
  });
});

describe('live sync says failure out loud and recovers', () => {
  it('a source that cannot be read fails the pass, composes nothing, and the retry catches up', async () => {
    const t = await liveStack({ failPages: [true] });
    t.s.reader.rows.push(row({ id: 'opp-1', updated_at: at(1) }));
    t.live.start();
    await t.live.idle();
    assert.equal(t.live.state().phase, 'failed');
    assert.match(t.live.state().error, /unreachable/);
    assert.equal(t.calls.composed, 0);
    // The retry is scheduled on the backoff; wait for it.
    for (let i = 0; i < 50 && t.live.state().phase !== 'current'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      await t.live.idle();
    }
    assert.equal(t.live.state().phase, 'current');
    assert.equal(t.live.state().error, null);
    assert.equal(t.calls.composed, 1);
    t.live.stop();
  });

  it('a source that changed shape is blocked by the pipeline and the pass says so; the checkpoint waits', async () => {
    const t = await liveStack({ composedBefore: true });
    t.s.reader.rows.push({ ...row({ id: 'opp-1', updated_at: at(1) }), stage: null });
    t.live.start();
    await t.live.idle();
    const last = t.calls.pages.at(-1);
    assert.equal(last.outcome, 'BLOCKED_BY_DRIFT');
    assert.equal(last.cursorAfter, last.cursorBefore);
    assert.equal(t.live.state().phase, 'failed');
    assert.match(t.live.state().error, /changed shape/);
    assert.equal(t.calls.composed, 0);
    t.live.stop();
  });
});
