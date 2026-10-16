/**
 * Phase 2 "What moved since last week": two states of the pipeline side by side. Every deal that changed with each
 * change, and the walk of the quarter's weighted figure from the earlier state to today's — which must reconcile to
 * the cent with readQuarter on both states. Deals are in the state's own order; nothing is ranked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineMoves, readQuarter } from '../src/index.ts';

const deal = (id, over = {}) => ({ opportunityId: id, opportunity: id, customer: null, customerClass: null, stage: 'Proposal', status: 'Active', state: 'OPEN', expectedClosePeriod: '2026-11', brand: null, channel: null, lastTouchAt: null, nextActionDate: null, sourceUpdatedAt: null, closedOn: null, sourceId: id, value: '1000', currency: 'SGD', probability: '0.5', expectedRevenue: [], ...over });
const Q = '2026-Q4';

const before = [
  deal('same'),
  deal('slipped'),
  deal('pulled-in', { expectedClosePeriod: '2027-02' }),
  deal('won'),
  deal('lost', { value: '2000' }),
  deal('repriced', { value: '1000.10', probability: '0.3' }),
  deal('restaged', { stage: 'Qualification' }),
  deal('later-in-quarter', { expectedClosePeriod: '2026-10' }),
  deal('deleted', { value: '300' }),
];
const now = [
  deal('same'),
  deal('slipped', { expectedClosePeriod: '2027-01' }),
  deal('pulled-in', { expectedClosePeriod: 'Q4 2026' }),
  deal('won', { stage: 'Closed Won', state: 'WON' }),
  deal('lost', { value: '2000', state: 'LOST', stage: 'Lost' }),
  deal('repriced', { value: '850.35', probability: '0.45' }),
  deal('restaged', { stage: 'Proposal' }),
  deal('later-in-quarter', { expectedClosePeriod: '2026-12' }),
  deal('new-one', { value: '400', probability: '0.25' }),
];

describe('what moved between two states of the pipeline', () => {
  const m = pipelineMoves(before, now, Q);
  const byId = new Map(m.changes.map((c) => [c.deal.opportunityId, c]));

  it('lists each changed deal once, in the state order, and counts the unchanged', () => {
    assert.deepEqual(m.changes.map((c) => c.deal.opportunityId), ['slipped', 'pulled-in', 'won', 'lost', 'repriced', 'restaged', 'later-in-quarter', 'new-one', 'deleted']);
    assert.equal(m.unchanged, 1);
  });

  it('says each change as the source states it', () => {
    assert.deepEqual(byId.get('slipped').moves, [{ kind: 'CLOSE', from: '2026-11', to: '2027-01', direction: 'LATER' }]);
    assert.deepEqual(byId.get('pulled-in').moves, [{ kind: 'CLOSE', from: '2027-02', to: 'Q4 2026', direction: 'EARLIER' }]);
    assert.deepEqual(byId.get('won').moves, [{ kind: 'STATE', from: 'OPEN', to: 'WON' }, { kind: 'STAGE', from: 'Proposal', to: 'Closed Won' }]);
    assert.deepEqual(byId.get('repriced').moves.map((x) => x.kind), ['VALUE', 'PROBABILITY']);
    assert.deepEqual(byId.get('restaged').moves, [{ kind: 'STAGE', from: 'Qualification', to: 'Proposal' }]);
    assert.deepEqual(byId.get('new-one').moves, [{ kind: 'NEW' }]);
    assert.deepEqual(byId.get('deleted').moves, [{ kind: 'GONE' }]);
  });

  it('counts a deal once in the walk, under the first group that applies', () => {
    const g = Object.fromEntries(m.changes.map((c) => [c.deal.opportunityId, c.group]));
    assert.deepEqual(g, { slipped: 'LEFT_QUARTER', 'pulled-in': 'ENTERED_QUARTER', won: 'WON', lost: 'LOST', repriced: 'REVALUED', restaged: 'OTHER', 'later-in-quarter': 'OTHER', 'new-one': 'NEW', deleted: 'GONE' });
  });

  it('reconciles the walk to the cent with the quarter read on both states', () => {
    const was = readQuarter(before, Q).inQuarter.weighted.value;
    const is = readQuarter(now, Q).inQuarter.weighted.value;
    assert.equal(m.walk.before.value, was);
    assert.equal(m.walk.now.value, is);
    const cents = m.walk.lines.reduce((t, l) => t + Math.round(Number(l.weighted.value) * 100), 0);
    assert.equal(cents, Math.round(Number(is) * 100) - Math.round(Number(was) * 100));
    const line = Object.fromEntries(m.walk.lines.map((l) => [l.group, l.weighted.value]));
    assert.equal(line.LEFT_QUARTER, '-500');
    assert.equal(line.ENTERED_QUARTER, '500');
    assert.equal(line.LOST, '-1000');
    assert.equal(line.REVALUED, '82.63'); // 850.35 × 0.45 − 1000.10 × 0.3, each to the cent
    assert.equal(line.OTHER, '0');
  });

  it('places a bare quarter nowhere on the calendar: the move is only CHANGED', () => {
    const x = pipelineMoves([deal('a', { expectedClosePeriod: '2026-11' })], [deal('a', { expectedClosePeriod: 'Q4' })], Q);
    assert.equal(x.changes[0].moves[0].direction, 'CHANGED');
  });

  it('reads 0.5 and 0.50 as the same probability, and an emptied value as a change', () => {
    const x = pipelineMoves([deal('a', { probability: '0.5' }), deal('b')], [deal('a', { probability: '0.50' }), deal('b', { value: null })], Q);
    assert.deepEqual(x.changes.map((c) => [c.deal.opportunityId, c.moves.map((v) => v.kind)]), [['b', ['VALUE']]]);
    assert.equal(x.changes[0].weightedNow, 0);
  });

  it('stops the walk rather than converting mixed currencies', () => {
    const x = pipelineMoves([deal('a')], [deal('a'), deal('b', { currency: 'VND' })], Q);
    assert.equal(x.walk, null);
    assert.equal(x.changes.length, 1);
  });
});
