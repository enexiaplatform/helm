/**
 * verify:writeback-dry-run — HELM writes nothing to an operational system in v1.
 *
 *   - the approved Rohto commitment yields ONE request, from the one action intent aimed at Memoire; the intents
 *     aimed at systems with no adapter are skipped and say so;
 *   - a request records what a live write WOULD have been and says nothing was sent;
 *   - it is idempotent, and it carries the commitment fingerprint and the intent it derives from;
 *   - it touches nothing at the source of the intent;
 *   - a live mode is refused; an intent of another commitment is refused; a commitment governance does not permit
 *     is REFUSED, recorded with the state it was judged in;
 *   - the gateway and the adapter have no method that sends.
 */

import { createMemoireWritebackAdapter, createWritebackGateway } from '../packages/integration-runtime/src/index.ts';
import { buildIntegrationStack, contract, expectFail, unwrap } from './lib/v1Stack.mjs';

const c = contract('verify:writeback-dry-run');
const s = await buildIntegrationStack();
const result = unwrap(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'dispatch');
const r = result.requests[0];

c.check('derived-from-intent', result.requests.length === 1 && r.targetSystem === 'memoire', 'the commitment did not yield exactly one Memoire request');
c.check('derived-from-intent', JSON.stringify(result.skipped.map((x) => x.targetSystem).sort()) === JSON.stringify(['finance', 'scm']) && /No writeback adapter is connected/.test(result.skipped[0].reason), 'the intents aimed at unconnected systems were not skipped with a reason');
c.check('dry-run', r.mode === 'DRY_RUN' && r.outcome === 'WOULD_WRITE' && r.receipt.sent === false && /Nothing was sent/.test(r.receipt.note), 'the request does not say that nothing was sent');
c.check('dry-run', r.receipt.endpoint === 'memoire.actions' && r.receipt.body.title === 'Confirm the delivery date with Rohto procurement', 'the receipt does not show what a live write would have been');
c.check('governed', ['AUTHORIZED', 'APPROVED'].includes(r.governanceState), `the request was judged in state ${r.governanceState}`);
c.check('lineage', r.payload.helm.commitmentId === s.story.commitmentId && !!r.payload.helm.commitmentFingerprint && !!r.actionIntentId, 'the request does not carry its commitment fingerprint and the intent it derives from');

const again = unwrap(await s.gateway.dispatch(s.scope, { commitmentId: s.story.commitmentId }), 'again');
c.check('idempotent', again.requests[0].replayed === true && again.requests[0].id === r.id && unwrap(await s.gateway.list(s.scope, s.story.commitmentId), 'list').length === 1, 'dispatching twice recorded a second request');

const fresh = await buildIntegrationStack();
const read = async () => unwrap(await fresh.decisionStore.listActionIntents(fresh.scope, fresh.story.commitmentId), 'intents').map((i) => `${i.id}:${i.status}:${i.handoffRef}`);
const intentsBefore = await read();
unwrap(await fresh.gateway.dispatch(fresh.scope, { commitmentId: fresh.story.commitmentId }), 'dispatch');
c.check('touches-nothing', JSON.stringify(await read()) === JSON.stringify(intentsBefore) && intentsBefore.every((x) => x.endsWith(':null')), 'a dry run changed the status or hand-off of the intent it derives from');

const live = await buildIntegrationStack();
c.check('no-live', expectFail(await live.gateway.dispatch(live.scope, { commitmentId: live.story.commitmentId, mode: 'LIVE' }), 'live').code === 'integration.live_writeback_disabled' && unwrap(await live.gateway.list(live.scope), 'list').length === 0, 'a live mode was accepted or recorded');
c.check('explicit-intent', expectFail(await live.gateway.dispatch(live.scope, { commitmentId: live.story.commitmentId, actionIntentId: 'not-an-intent' }), 'foreign').code === 'integration.no_execution_intent', 'a request was made without an explicit intent of the commitment');

const g = await buildIntegrationStack();
const pending = { ...g.authority, getGovernanceState: async () => ({ ok: true, value: { state: 'PENDING_APPROVAL' } }) };
const gate = createWritebackGateway({ decisions: g.decisionStore, authority: pending, store: g.integrationStore, adapters: [createMemoireWritebackAdapter()] });
const refused = unwrap(await gate.dispatch(g.scope, { commitmentId: g.story.commitmentId }), 'pending');
const q = refused.requests[0];
c.check('governance', q.outcome === 'REFUSED' && /PENDING_APPROVAL/.test(q.refusalReason) && q.governanceState === 'PENDING_APPROVAL' && Object.keys(q.receipt).length === 0, 'a commitment governance does not permit was writable, or its refusal was not recorded with the state it was judged in');

c.check('no-sender', JSON.stringify(Object.keys(s.gateway).sort()) === JSON.stringify(['dispatch', 'list']) && JSON.stringify(Object.keys(createMemoireWritebackAdapter()).sort()) === JSON.stringify(['describe', 'supportedOperations', 'system']), 'the gateway or the adapter has a method that sends');

c.finish('one request from the one Memoire intent, WOULD_WRITE with nothing sent, idempotent, untouching, LIVE refused, ungoverned commitments REFUSED with the state they were judged in, no method that sends');
