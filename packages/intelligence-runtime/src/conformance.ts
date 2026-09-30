/**
 * The AiRunStore conformance suite.
 *
 * ONE contract, run against EVERY adapter: a run is write-once and stamped with
 * the store's own record time; its shape cannot hold a reasoning trace; nothing
 * crosses a tenant wall.
 *
 * Runner-agnostic, so it works under `node --test` and anything later.
 */

import type { Result, Scope, UserId } from '@helm/shared';
import type { AiRunStore, NewAiRun } from './port.ts';

export type AiRunTestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: { equal(actual: unknown, expected: unknown, message?: string): void; ok(value: unknown, message?: string): void };
};

export type AiRunStoreHarness = {
  name: string;
  create(): Promise<{ store: AiRunStore; scopeA: Scope; scopeB: Scope; userId: UserId; cleanup?: () => Promise<void> }>;
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

export function runAiRunStoreConformanceSuite(api: AiRunTestApi, harness: AiRunStoreHarness): void {
  const { describe, it, assert } = api;

  describe(`AiRunStore conformance — ${harness.name}`, () => {
    const run = (userId: UserId, over: Record<string, unknown> = {}): NewAiRun =>
      ({
        userId,
        task: 'ASK_HELM',
        templateId: 'ask-helm',
        templateVersion: '1',
        promptHash: 'pmt_fixture',
        provider: { id: 'fixture', model: 'none', modelVersion: '0' },
        toolCalls: [],
        evidenceRefs: [],
        grounding: { proposed: 0, kept: 0, reclassified: 0, downgradedToInference: 0, removed: 0, removals: [] },
        output: { statements: [], questions: [], unknowns: [] },
        resultMeta: { statementsByClass: {}, evidenceCount: 0, fingerprint: 'air_fixture' },
        ...over,
      }) as NewAiRun;

    it('a run is recorded once, with a record time the store stamped', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertRun(h.scopeA, run(h.userId)), 'insert');
        assert.ok(r.recordedAt, 'the store stamps record time');
        assert.equal(expectOk(await h.store.getRun(h.scopeA, r.id), 'get')?.id, r.id);
      } finally {
        await h.cleanup?.();
      }
    });

    it('a run cannot hold a reasoning trace: output is statements, questions and unknowns; the provider an id, a model and a version', async () => {
      const h = await harness.create();
      try {
        const withThought = await h.store.insertRun(h.scopeA, run(h.userId, { output: { statements: [], questions: [], unknowns: [], reasoning: 'hidden chain of thought' } }));
        assert.equal(withThought.ok, false, 'a run with a reasoning field was recorded');
        const vendorBlob = await h.store.insertRun(h.scopeA, run(h.userId, { provider: { id: 'x', model: 'y', modelVersion: '1', apiKey: 'secret' } }));
        assert.equal(vendorBlob.ok, false, 'a provider carrying extra fields was recorded');
      } finally {
        await h.cleanup?.();
      }
    });

    it('nothing crosses a tenant wall', async () => {
      const h = await harness.create();
      try {
        const r = expectOk(await h.store.insertRun(h.scopeA, run(h.userId)), 'insert');
        assert.equal(expectOk(await h.store.getRun(h.scopeB, r.id), 'B get'), null);
        assert.equal(expectOk(await h.store.listRuns(h.scopeB), 'B list').filter((x) => x.id === r.id).length, 0);
      } finally {
        await h.cleanup?.();
      }
    });
  });
}
