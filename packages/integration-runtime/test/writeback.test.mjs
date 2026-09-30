/**
 * Governed writeback (DRY_RUN): HELM commitment → action intent → Memoire — idempotent,
 * derived from an explicit intent, refused when governance does not permit, and it sends nothing.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWritebackGateway, createMemoireWritebackAdapter } from '../src/index.ts';
import { buildIntegrationStack, expectFail, unwrap } from './harness.mjs';

describe('the approved Rohto commitment written back to Memoire — as a dry run', () => {
  let s;
  let result;
  before(async () => {
    s = await buildIntegrationStack();
    result = unwrap(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'dispatch');
  });

  it('derives one request from the one intent aimed at Memoire and leaves the other systems\' intents alone', () => {
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].targetSystem, 'memoire');
    assert.deepEqual(result.skipped.map((x) => x.targetSystem).sort(), ['finance', 'scm']);
    assert.match(result.skipped[0].reason, /No writeback adapter is connected/);
  });

  it('records what a live write WOULD have been and says nothing was sent', () => {
    const r = result.requests[0];
    assert.equal(r.mode, 'DRY_RUN');
    assert.equal(r.outcome, 'WOULD_WRITE');
    assert.equal(r.receipt.sent, false);
    assert.equal(r.receipt.endpoint, 'memoire.actions');
    assert.equal(r.receipt.body.title, 'Confirm the delivery date with Rohto procurement');
    assert.match(r.receipt.note, /Nothing was sent/);
    assert.ok(['AUTHORIZED', 'APPROVED'].includes(r.governanceState), `judged in state ${r.governanceState}`);
  });

  it('carries the commitment fingerprint and the intent it derives from', () => {
    const r = result.requests[0];
    assert.equal(r.payload.helm.commitmentId, s.story.commitmentId);
    assert.ok(r.payload.helm.commitmentFingerprint);
    assert.equal(r.commitmentId, s.story.commitmentId);
    assert.ok(r.actionIntentId);
  });

  it('is idempotent: dispatching again returns the same request and records nothing new', async () => {
    const again = unwrap(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'again');
    assert.equal(again.requests.length, 1);
    assert.equal(again.requests[0].replayed, true);
    assert.equal(again.requests[0].id, result.requests[0].id);
    assert.equal(again.requests[0].idempotencyKey, result.requests[0].idempotencyKey);
    assert.equal(unwrap(await s.gateway.list(s.scope, s.story.commitmentId), 'list').length, 1);
  });

  it('touches nothing at the source of the intent: its status and hand-off reference are unchanged', async () => {
    const fresh = await buildIntegrationStack();
    const read = async () => unwrap(await fresh.decisionStore.listActionIntents(fresh.scope, fresh.story.commitmentId), 'intents').map((i) => `${i.id}:${i.status}:${i.handoffRef}`);
    const before = await read();
    unwrap(await fresh.gateway.dispatch(fresh.scope, { commitmentId: fresh.story.commitmentId }), 'dispatch');
    assert.deepEqual(await read(), before);
    assert.ok((await read()).every((x) => x.endsWith(':null')), 'nothing was handed over');
  });
});

describe('what the gateway refuses', () => {
  it('a live mode: v1 writes nothing to an operational system', async () => {
    const s = await buildIntegrationStack();
    assert.equal(expectFail(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId, mode: 'LIVE' }), 'live').code, 'integration.live_writeback_disabled');
    assert.equal(unwrap(await s.gateway.list(s.scope), 'list').length, 0);
  });

  it('an intent that is not part of the commitment: there is no request without an explicit execution intent', async () => {
    const s = await buildIntegrationStack();
    assert.equal(expectFail(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId, actionIntentId: 'not-an-intent' }), 'foreign').code, 'integration.no_execution_intent');
  });

  it('a commitment governance does not permit to be executed: the refusal is recorded, with the state it was judged in', async () => {
    const s = await buildIntegrationStack();
    const pending = { ...s.authority, getGovernanceState: async () => ({ ok: true, value: { state: 'PENDING_APPROVAL' } }) };
    const gateway = createWritebackGateway({ decisions: s.decisionStore, authority: pending, store: s.integrationStore, adapters: [createMemoireWritebackAdapter()] });
    const r = unwrap(await gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'dispatch');
    assert.equal(r.requests[0].outcome, 'REFUSED');
    assert.match(r.requests[0].refusalReason, /PENDING_APPROVAL/);
    assert.deepEqual(r.requests[0].receipt, {});
    assert.equal(r.requests[0].governanceState, 'PENDING_APPROVAL');
  });

  it('the gateway has no method that sends', async () => {
    const s = await buildIntegrationStack();
    assert.deepEqual(Object.keys(s.gateway).sort(), ['dispatch', 'list']);
    assert.deepEqual(Object.keys(createMemoireWritebackAdapter()).sort(), ['describe', 'supportedOperations', 'system']);
  });
});
