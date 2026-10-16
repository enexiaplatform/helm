/**
 * Phase 1 "This week": the open deals that need a step from their owner, by dates the source states — a next step
 * overdue or due within seven days, or a close date passed. Listed once each, oldest date first; never ranked. A deal
 * nobody changed for thirty days is data to fix (quietDeals), not a step this week.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeEndOf, quietDeals, thisWeek } from '../src/index.ts';

const deal = (id, over = {}) => ({ opportunityId: id, opportunity: id, customer: null, customerClass: null, stage: 'Proposal', status: 'Active', state: 'OPEN', expectedClosePeriod: null, brand: null, channel: null, lastTouchAt: null, nextActionDate: null, sourceUpdatedAt: null, closedOn: null, sourceId: id, value: null, currency: null, probability: null, expectedRevenue: [], ...over });
const NOW = '2026-10-16T09:00:00.000Z';

describe('the last day of a close period as Memoire states it', () => {
  it('reads a date, a month, a named month and a quarter with a year', () => {
    assert.equal(closeEndOf('2026-10-05'), '2026-10-05');
    assert.equal(closeEndOf('2026-11'), '2026-11-30');
    assert.equal(closeEndOf('Feb 2028'), '2028-02-29');
    assert.equal(closeEndOf('Q3 2026'), '2026-09-30');
    assert.equal(closeEndOf('2026-Q4'), '2026-12-31');
  });
  it('places nothing it cannot read: a bare quarter, free text, an impossible date', () => {
    assert.equal(closeEndOf('Q4'), null);
    assert.equal(closeEndOf('soon'), null);
    assert.equal(closeEndOf('2026-02-30'), null);
    assert.equal(closeEndOf(null), null);
  });
});

describe('this week', () => {
  const rows = [
    deal('overdue-step', { nextActionDate: '2026-10-01' }),
    deal('step-in-3-days', { nextActionDate: '2026-10-19' }),
    deal('step-next-month', { nextActionDate: '2026-11-20' }),
    deal('close-passed', { expectedClosePeriod: '2026-10-05' }),
    deal('close-this-quarter', { expectedClosePeriod: 'Q4 2026' }),
    deal('quiet', { sourceUpdatedAt: '2026-08-01T10:00:00.000Z' }),
    deal('recent', { sourceUpdatedAt: '2026-10-10T10:00:00.000Z' }),
    deal('everything', { nextActionDate: '2026-09-20', expectedClosePeriod: 'Sep 2026', sourceUpdatedAt: '2026-07-01T00:00:00Z' }),
    deal('lost-and-late', { state: 'LOST', nextActionDate: '2026-09-01', sourceUpdatedAt: '2026-07-01T00:00:00Z' }),
  ];
  const w = thisWeek(rows, NOW);

  it('lists the open deals with a step due, each once, oldest date first', () => {
    assert.deepEqual(w.lines.map((l) => l.deal.opportunityId), ['everything', 'overdue-step', 'close-passed', 'step-in-3-days']);
    assert.deepEqual(w.lines[0].reasons.map((r) => r.kind), ['NEXT_STEP_OVERDUE', 'CLOSE_PASSED']);
    assert.equal(w.lines[0].since, '2026-09-20');
  });
  it('counts each reason; a won, lost or merely quiet deal is not a step this week', () => {
    assert.deepEqual(w.counts, { NEXT_STEP_OVERDUE: 2, NEXT_STEP_DUE: 1, CLOSE_PASSED: 2 });
    assert.ok(!w.lines.some((l) => ['lost-and-late', 'recent', 'quiet', 'step-next-month', 'close-this-quarter'].includes(l.deal.opportunityId)));
  });
  it('a deal without the dates says nothing about itself', () => {
    assert.equal(thisWeek([deal('bare')], NOW).lines.length, 0);
  });
  it('a quiet deal is data to fix: open, and unchanged in the source for thirty days', () => {
    assert.deepEqual(quietDeals(rows, NOW).map((r) => r.opportunityId), ['quiet', 'everything']);
  });
});
