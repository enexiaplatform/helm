/**
 * The pipeline as a twin state holds it: a reading of composed items, one row per opportunity with its customer, in
 * the state's own order — and Memoire's free-text close period read without guessing a year.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closesIn, opportunityLabel, pipelineFacts, readPipeline } from '../src/index.ts';

const entity = (id, type, name, attributes = {}, extra = {}) => ({ key: `entity:${id}`, kind: 'ENTITY', categories: ['STRUCTURE'], label: name, subjectEntityId: id, layer: null, status: 'KNOWN', state: { name, entityTypeKey: type, attributes, ...extra }, refs: [], sensitivity: 'GENERAL_MANAGEMENT', reason: null });
const held = (opp, cust) => ({ key: `rel:${opp}`, kind: 'RELATIONSHIP', categories: ['STRUCTURE'], label: '', subjectEntityId: opp, layer: null, status: 'KNOWN', state: { type: 'HELD_BY', sourceEntityId: opp, targetEntityId: cust }, refs: [], sensitivity: 'GENERAL_MANAGEMENT', reason: null });
const value = (subject, metricKey, layer, v, currency = null, period = null) => ({ key: `value:${subject}:${metricKey}:${layer}`, kind: 'VALUE', categories: ['VALUE'], label: metricKey, subjectEntityId: subject, layer, status: 'KNOWN', state: { metricKey, value: v, currency, period }, refs: [], sensitivity: 'COMMERCIAL_CONFIDENTIAL', reason: null });

describe('the pipeline as the state holds it', () => {
  const items = [
    entity('c1', 'Customer', 'Alpha Co', {}, { classification: 'KEY_ACCOUNT' }),
    entity('o1', 'Opportunity', 'Canister / Tailin / Cons', { stage: 'Proposal', expectedClosePeriod: '2026-11' }),
    entity('o2', 'Opportunity', 'Canister / Tailin / Cons', { stage: 'Lead', expectedClosePeriod: 'Q4' }),
    entity('o3', 'Opportunity', 'Swab', {}),
    held('o1', 'c1'),
    value('o1', 'OpportunityValue', 'ACTUAL', '20000', 'SGD'),
    value('o1', 'OpportunityProbability', 'ACTUAL', '0.1'),
    value('o1', 'ExpectedRevenue', 'MODELLED', '2000', 'SGD', '2026-Q4'),
    value('o2', 'OpportunityValue', 'ACTUAL', '0', 'SGD'),
  ];

  it('one row per opportunity, in the state order, each with the customer that holds it', () => {
    const rows = readPipeline(items);
    assert.deepEqual(rows.map((r) => r.opportunityId), ['o1', 'o2', 'o3']);
    assert.equal(opportunityLabel(rows[0]), 'Canister / Tailin / Cons · Alpha Co');
    assert.equal(rows[0].customerClass, 'KEY_ACCOUNT');
    assert.equal(opportunityLabel(rows[1]), 'Canister / Tailin / Cons', 'no customer is invented');
    assert.deepEqual(rows[0].expectedRevenue, [{ period: '2026-Q4', value: '2000', currency: 'SGD' }]);
  });

  it('counts what the pipeline states about itself, never a score', () => {
    assert.deepEqual(pipelineFacts(readPipeline(items)), { opportunities: 3, withValue: 2, zeroValue: 1, noValue: 1, noProbability: 2, modelled: 1, withoutCustomer: 2 });
  });

  it('reads a close period as Memoire states it, and does not guess a missing year', () => {
    assert.equal(closesIn('2026-11', '2026-Q4'), 'YES');
    assert.equal(closesIn('2026-09', '2026-Q4'), 'NO');
    assert.equal(closesIn('Q4 2026', '2026-Q4'), 'YES');
    assert.equal(closesIn('2026-Q4', '2026-Q4'), 'YES');
    assert.equal(closesIn('Q4 2025', '2026-Q4'), 'NO');
    assert.equal(closesIn('Q4', '2026-Q4'), 'AMBIGUOUS');
    assert.equal(closesIn(null, '2026-Q4'), 'NO');
    assert.equal(closesIn('soon', '2026-Q4'), 'NO');
  });
});
