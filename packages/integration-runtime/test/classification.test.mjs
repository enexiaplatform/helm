/**
 * Account classification from Memoire: the account's own key-account flag places its customer in a Segment the twin
 * reads as KEY_ACCOUNT or STANDARD_CUSTOMER. A flag Memoire does not state classifies nothing, and a reclassification
 * is read as the latest one stated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classificationOf, readStructure } from '../../twin-runtime/src/index.ts';
import { buildIntegrationStack, row, unwrap } from './harness.mjs';

const LENS = { effectiveAsOf: '2099-01-01T00:00:00.000Z', recordedThrough: '2099-01-01T00:00:00.000Z' };
const ENTERPRISE = { kind: 'ENTERPRISE', label: 'Enterprise' };

async function classOf(s, accountId) {
  const cust = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Customer', `memoire:account:${accountId}`), 'customer');
  const view = unwrap(await readStructure(s.graph, s.scope, LENS, ENTERPRISE), 'structure');
  return classificationOf(view, cust.id)?.classification ?? null;
}

describe('a Memoire account carries its key-account flag into HELM as a classification', () => {
  it('true is a key account, false a standard customer, and an unstated flag classifies nothing', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(
      row({ id: 'opp-k', account_id: 'acc-k', account_name: 'Key Co', account_ka_flag: true, updated_at: '2026-10-01T02:00:00.000Z' }),
      row({ id: 'opp-s', account_id: 'acc-s', account_name: 'Standard Co', account_ka_flag: false, updated_at: '2026-10-01T03:00:00.000Z' }),
      row({ id: 'opp-u', account_id: 'acc-u', account_name: 'Unstated Co', account_ka_flag: null, updated_at: '2026-10-01T04:00:00.000Z' }),
    );
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync');
    assert.equal(r.outcome, 'SUCCEEDED');
    assert.equal(await classOf(s, 'acc-k'), 'KEY_ACCOUNT');
    assert.equal(await classOf(s, 'acc-s'), 'STANDARD_CUSTOMER');
    assert.equal(await classOf(s, 'acc-u'), null, 'HELM does not guess a class Memoire does not state');
  });

  it('two opportunities of one account make one segment and one membership', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(
      row({ id: 'opp-1', account_id: 'acc-k', account_ka_flag: true, updated_at: '2026-10-01T02:00:00.000Z' }),
      row({ id: 'opp-2', account_id: 'acc-k', account_ka_flag: true, updated_at: '2026-10-01T03:00:00.000Z' }),
    );
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync');
    const cust = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Customer', 'memoire:account:acc-k'), 'customer');
    const rels = unwrap(await s.graph.findRelationships(s.scope, { relationshipTypeKeys: ['BELONGS_TO'], sourceEntityId: cust.id }), 'memberships');
    assert.equal(rels.length, 1);
    assert.equal(r.counts.relationshipsCreated, 3, 'two HELD_BY and one BELONGS_TO');
  });

  it('an account Memoire reclassifies reads as its latest class', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(row({ id: 'opp-k', account_id: 'acc-k', account_ka_flag: true, updated_at: '2026-10-01T02:00:00.000Z' }));
    unwrap(await s.pipeline.run(s.scope, s.adapter), 'first');
    s.reader.rows[0] = { ...s.reader.rows[0], account_ka_flag: false, updated_at: '2026-10-05T02:00:00.000Z' };
    unwrap(await s.pipeline.run(s.scope, s.adapter), 'reclassified');
    assert.equal(await classOf(s, 'acc-k'), 'STANDARD_CUSTOMER');
  });
});
