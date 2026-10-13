/**
 * The quarter as a manager reads it (audit 2026-10-13). The Cockpit said "Pipeline 1.65M SGD" and "Expected revenue
 * 2026-Q4 323K SGD": the first counted lost and won deals, the second counted lost deals, deals closing in 2027 and
 * labelled every one of them with the quarter the model ran in. These are the regressions for each of those.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { byBrand, closesIn, dealStateOf, quarterOf, quarterKeyOf, readPipeline, readQuarter, staleDeals } from '../src/index.ts';

const entity = (id, name, attributes) => ({ key: `entity:${id}`, kind: 'ENTITY', categories: ['STRUCTURE'], label: name, subjectEntityId: id, layer: null, status: 'KNOWN', state: { name, entityTypeKey: 'Opportunity', attributes }, refs: [], sensitivity: 'GENERAL_MANAGEMENT', reason: null });
const value = (subject, metricKey, v, currency = null) => ({ key: `value:${subject}:${metricKey}`, kind: 'VALUE', categories: ['VALUE'], label: metricKey, subjectEntityId: subject, layer: 'ACTUAL', status: 'KNOWN', state: { metricKey, value: v, currency, period: null }, refs: [], sensitivity: 'COMMERCIAL_CONFIDENTIAL', reason: null });
const deal = (id, stage, status, close, v, p) => [
  entity(id, id, { stage, status, expectedClosePeriod: close }),
  ...(v === null ? [] : [value(id, 'OpportunityValue', v, 'SGD')]),
  ...(p === null ? [] : [value(id, 'OpportunityProbability', p)]),
];

describe('deal state is read from stage and status', () => {
  it('a close named in either field wins', () => {
    assert.equal(dealStateOf('Lost', 'Active'), 'LOST', 'stage Lost with status Active is lost (a real Memoire row)');
    assert.equal(dealStateOf('Won', 'Active'), 'WON');
    assert.equal(dealStateOf('Discovery', 'Lost'), 'LOST');
    assert.equal(dealStateOf('On hold', 'On hold'), 'ON_HOLD');
    assert.equal(dealStateOf('Closed Won', null), 'WON');
    assert.equal(dealStateOf('Proposal', 'Active'), 'OPEN');
    assert.equal(dealStateOf(null, null), 'OPEN');
  });
});

describe('a close period is read as Memoire states it', () => {
  it('dates, months, named months and quarters with a year', () => {
    assert.deepEqual(quarterOf('2026-10-30'), { year: '2026', quarter: 4 }, 'a full date was not read before');
    assert.deepEqual(quarterOf('2026-11'), { year: '2026', quarter: 4 });
    assert.deepEqual(quarterOf('Jul 2026'), { year: '2026', quarter: 3 });
    assert.deepEqual(quarterOf('Q4/2026'), { year: '2026', quarter: 4 });
    assert.deepEqual(quarterOf('Q1 2027'), { year: '2027', quarter: 1 });
    assert.deepEqual(quarterOf('2026-Q4'), { year: '2026', quarter: 4 });
    assert.deepEqual(quarterOf('Q4'), { year: null, quarter: 4 });
    assert.equal(quarterOf('soon'), null);
    assert.equal(quarterOf('2026-13'), null);
  });

  it('a quarter without a year is ambiguous, never placed in a year', () => {
    assert.equal(closesIn('2026-12-31', '2026-Q4'), 'YES');
    assert.equal(closesIn('2027-03-27', '2026-Q4'), 'NO');
    assert.equal(closesIn('Q4', '2026-Q4'), 'AMBIGUOUS');
    assert.equal(closesIn('Q3', '2026-Q4'), 'NO');
    assert.equal(quarterKeyOf('2026-10-13T12:00:00Z'), '2026-Q4');
  });
});

describe('the quarter counts open deals only, by their own close period', () => {
  const items = [
    ...deal('open-q4-date', 'Proposal', 'Active', '2026-10-30', '10000', '0.5'),
    ...deal('open-q4-bare', 'Qualification', 'Active', 'Q4', '4000', '0.25'),
    ...deal('open-q4-noprob', 'Discovery', 'Active', 'Q4 2026', '3000', null),
    ...deal('open-2027', 'Lead', 'Active', '2027-10-28', '50000', '0.1'),
    ...deal('open-overdue', 'Proposal', 'Active', '2026-08', '2000', '0.5'),
    ...deal('open-noclose', 'Discovery', 'Active', null, '0', '0.1'),
    ...deal('lost-q4', 'Lost', 'Lost', 'Q4', '20000', '0.5'),
    ...deal('lost-active', 'Lost', 'Active', 'Q3', '65', '0.75'),
    ...deal('won-q3', 'Won', 'Won', '2026-09-30', '7000', null),
    ...deal('won-q4', 'Won', 'Won', '2026-11-30', '1500', null),
    ...deal('hold', 'On hold', 'On hold', 'Q1 2027', '900', null),
  ];
  const q = readQuarter(readPipeline(items), '2026-Q4');

  it('the open pipeline holds no lost, won or held deal', () => {
    assert.equal(q.open.count, 6);
    assert.deepEqual(q.open.value, { value: '69000', currency: 'SGD', mixed: [] });
  });

  it('in the quarter: open deals closing in it, weighted by their own probability', () => {
    assert.equal(q.inQuarter.count, 3, 'the dated, the bare-Q4 and the no-probability deal; not 2027, not overdue, not lost');
    assert.deepEqual(q.inQuarter.value, { value: '17000', currency: 'SGD', mixed: [] });
    assert.deepEqual(q.inQuarter.weighted, { value: '6000', currency: 'SGD', mixed: [] }, '10000×0.5 + 4000×0.25');
    assert.equal(q.inQuarter.noProbability, 1);
    assert.equal(q.inQuarter.yearNotStated, 1);
  });

  it('won and lost are counted apart, never forecast', () => {
    assert.equal(q.won.count, 2);
    assert.equal(q.won.inQuarter, 1);
    assert.deepEqual(q.won.inQuarterValue, { value: '1500', currency: 'SGD', mixed: [] });
    assert.equal(q.lost.count, 2);
    assert.deepEqual(q.lost.value, { value: '20065', currency: 'SGD', mixed: [] });
    assert.equal(q.onHold.count, 1);
  });

  it('open deals past their close quarter are overdue; one with no close period is counted', () => {
    assert.equal(q.overdue.count, 1);
    assert.equal(q.noClosePeriod, 1);
  });

  it('mixed currencies are never summed', () => {
    const mixed = readQuarter(readPipeline([...deal('a', 'Proposal', 'Active', '2026-11', '10', '1'), entity('b', 'b', { stage: 'Proposal', expectedClosePeriod: '2026-11' }), value('b', 'OpportunityValue', '10', 'EUR')]), '2026-Q4');
    assert.equal(mixed.inQuarter.value.value, null);
    assert.deepEqual([...mixed.inQuarter.value.mixed].sort(), ['EUR', 'SGD']);
  });
});

describe('brand, staleness and the link back to the source', () => {
  const items = [
    entity('a', 'Canister', { stage: 'Proposal', status: 'Active', expectedClosePeriod: '2026-11', brand: 'Tailin', lastTouchAt: '2026-08-01T00:00:00Z', sourceId: 'mem-a' }),
    value('a', 'OpportunityValue', '1000', 'SGD'),
    value('a', 'OpportunityProbability', '0.5'),
    entity('b', 'Pipette', { stage: 'Lead', status: 'Active', expectedClosePeriod: 'Q1 2027', brand: 'Tailin', lastTouchAt: '2026-10-10T00:00:00Z' }),
    value('b', 'OpportunityValue', '500', 'SGD'),
    entity('c', 'Swab', { stage: 'Lost', status: 'Lost', brand: 'Scitek' }),
    entity('d', 'Media', { stage: 'Discovery', status: 'Active' }),
  ];
  const rows = readPipeline(items);

  it('carries the brand and the source id', () => {
    assert.equal(rows[0].brand, 'Tailin');
    assert.equal(rows[0].sourceId, 'mem-a');
  });

  it('a deal untouched for 30 days is stale; one with no touch recorded is said apart; closed deals are never stale', () => {
    const s = staleDeals(rows, '2026-10-13T00:00:00Z');
    assert.deepEqual(s.stale.map((r) => r.opportunityId), ['a']);
    assert.deepEqual(s.neverTouched.map((r) => r.opportunityId), ['d']);
  });

  it('one line per brand stated, and one for none, in the order they first appear', () => {
    const b = byBrand(rows, '2026-Q4');
    assert.deepEqual(b.map((l) => l.brand), ['Tailin', 'Scitek', null]);
    assert.equal(b[0].open, 2);
    assert.deepEqual(b[0].openValue, { value: '1500', currency: 'SGD', mixed: [] });
    assert.deepEqual(b[0].weighted, { value: '500', currency: 'SGD', mixed: [] });
    assert.equal(b[1].lost, 1);
  });
});
