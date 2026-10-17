/**
 * Step 3 (2026-10-17): Memoire's receipts become ACTUAL CashReceived on the opportunity — the sum banked to date, for the
 * interval from the first receipt to the last. What is still owed is Memoire's derivation and is never read or computed.
 * HELM never converts, never reads a sample, never records cash for an opportunity it has not read; a new receipt moves
 * the reading and its interval, and an untouched order records nothing new.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureReceivableReader, createMemoireReceivableAdapter, MEMOIRE_RECEIVABLE_CONNECTOR } from '../src/index.ts';
import { buildIntegrationStack, row, unwrap } from './harness.mjs';

const receipt = (amount, on, currency = 'VND') => ({ amount, currency, received_on: on });
const recv = (over) => ({ id: 'recv-x', opportunity_id: 'opp-a', receipts: [], is_sample: false, updated_at: '2026-10-05T02:00:00.000Z', ...over });

async function setup(rows) {
  const s = await buildIntegrationStack();
  s.reader.rows.push(row({ id: 'opp-a', opportunity_name: 'Alpha order' }));
  unwrap(await s.pipeline.run(s.scope, s.adapter), 'opportunities');
  const reader = createFixtureReceivableReader(rows);
  return { s, receipts$: createMemoireReceivableAdapter(reader), reader };
}

async function cashOf(s, sourceId) {
  const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', `memoire:opportunity:${sourceId}`), 'opportunity');
  const node = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes').find((n) => n.metricKey === 'CashReceived');
  if (!node) return [];
  return unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: node.id }), 'observations').map((o) => ({ type: o.observationType, value: Number(o.numericValue), currency: o.currency, from: o.periodStart, to: o.periodEnd }));
}

describe('Memoire receipts', () => {
  it('records the cash received to date, for the interval of its receipts, in its own connector', async () => {
    const { s, receipts$ } = await setup([recv({ id: 'recv-a', receipts: [receipt(300.25, '2026-10-03'), receipt('200.50', '2026-09-20')] })]);
    const sync = unwrap(await s.pipeline.run(s.scope, receipts$), 'receipts');
    assert.equal(sync.connector, MEMOIRE_RECEIVABLE_CONNECTOR);
    assert.equal(sync.outcome, 'SUCCEEDED');
    const cash = await cashOf(s, 'opp-a');
    assert.equal(cash.length, 1);
    assert.deepEqual(cash[0], { type: 'ACTUAL', value: 500.75, currency: 'VND', from: '2026-09-20T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' });
  });

  it('a new receipt moves the reading and its interval; an untouched order records nothing new', async () => {
    const { s, receipts$, reader } = await setup([recv({ id: 'recv-a', receipts: [receipt(100, '2026-10-01')] })]);
    unwrap(await s.pipeline.run(s.scope, receipts$), 'first');
    reader.rows[0] = { ...reader.rows[0], updated_at: '2026-10-06T02:00:00.000Z' };
    const same = unwrap(await s.pipeline.run(s.scope, receipts$), 'touched');
    assert.equal(same.counts.observationsRecorded, 0);
    reader.rows[0] = { ...reader.rows[0], receipts: [receipt(100, '2026-10-01'), receipt(100, '2026-11-02')], updated_at: '2026-11-02T02:00:00.000Z' };
    const more = unwrap(await s.pipeline.run(s.scope, receipts$), 'another receipt');
    assert.equal(more.counts.observationsRecorded, 1);
    const cash = await cashOf(s, 'opp-a');
    assert.equal(cash.length, 2);
    assert.ok(cash.some((c) => c.value === 200 && c.to === '2026-11-03T00:00:00.000Z'));
  });

  it('never converts: receipts in two currencies stop the record, and say why', async () => {
    const { s, receipts$ } = await setup([recv({ receipts: [receipt(100, '2026-10-01'), receipt(5, '2026-10-02', 'USD')] })]);
    const sync = unwrap(await s.pipeline.run(s.scope, receipts$), 'receipts');
    assert.equal(sync.quarantined.length, 1);
    assert.match(sync.quarantined[0].reason, /never converts/);
    assert.deepEqual(await cashOf(s, 'opp-a'), []);
  });

  it('says nothing for a sample or an order with no receipt', async () => {
    const { s, receipts$ } = await setup([recv({ id: 'recv-s', is_sample: true, receipts: [receipt(100, '2026-10-01')] }), recv({ id: 'recv-n', updated_at: '2026-10-05T03:00:00.000Z' })]);
    const sync = unwrap(await s.pipeline.run(s.scope, receipts$), 'receipts');
    assert.equal(sync.counts.observationsRecorded, 0);
    assert.deepEqual(sync.quarantined, []);
  });

  it('stops a negative or undated receipt, and quarantines an order for an opportunity HELM has not read', async () => {
    const { s, receipts$ } = await setup([
      recv({ id: 'recv-neg', receipts: [receipt(-10, '2026-10-01')] }),
      recv({ id: 'recv-nodate', receipts: [receipt(10, null)], updated_at: '2026-10-05T03:00:00.000Z' }),
      recv({ id: 'recv-unknown', opportunity_id: 'opp-unknown', receipts: [receipt(10, '2026-10-01')], updated_at: '2026-10-05T04:00:00.000Z' }),
    ]);
    const sync = unwrap(await s.pipeline.run(s.scope, receipts$), 'receipts');
    assert.deepEqual(sync.quarantined.map((q) => q.externalId).sort(), ['recv-neg', 'recv-nodate', 'recv-unknown']);
  });
});
