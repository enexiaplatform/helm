/**
 * look-again-due@1 (2026-10-16): a commitment that named a date to look again, past that date, with no outcome review
 * recorded, is a management condition. The loop from commitment to outcome is open; it says nothing about the decision.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAttention, ATTENTION_RULES_VERSION } from '../src/index.ts';

const commitment = (id, state) => ({
  key: `commitment:${id}`,
  kind: 'COMMITMENT',
  categories: ['COMMITMENTS', 'DECISIONS'],
  label: `${id}: chosen`,
  subjectEntityId: null,
  layer: null,
  status: 'KNOWN',
  state: { commitmentId: `c-${id}`, lookAgainOn: null, outcomeReviewedAt: null, ...state },
  refs: [{ kind: 'COMMITMENT', id: `c-${id}`, pin: null, label: id }],
  sensitivity: 'GENERAL_MANAGEMENT',
  reason: null,
});

const due = (items, at) => snapshotAttention(items, at).filter((a) => a.state.condition === 'LOOK_AGAIN_DUE');

describe('look again due', () => {
  it('raises once the named date has passed and no outcome review is recorded', () => {
    const a = due([commitment('d1', { lookAgainOn: '2026-10-15' })], '2026-10-16T09:00:00.000Z');
    assert.equal(a.length, 1);
    assert.match(a[0].state.statement, /2026-10-15, has passed and no outcome review is recorded/);
    assert.deepEqual(a[0].state.causeItemKeys, ['commitment:d1']);
  });

  it('raises on the day itself, not before it', () => {
    assert.equal(due([commitment('d1', { lookAgainOn: '2026-10-16' })], '2026-10-16T09:00:00.000Z').length, 1);
    assert.equal(due([commitment('d1', { lookAgainOn: '2026-10-17' })], '2026-10-16T23:59:00.000Z').length, 0);
  });

  it('stays quiet once an outcome review is recorded, and when no date was named', () => {
    assert.equal(due([commitment('d1', { lookAgainOn: '2026-10-01', outcomeReviewedAt: '2026-10-10T00:00:00.000Z' })], '2026-10-16T00:00:00.000Z').length, 0);
    assert.equal(due([commitment('d2', {})], '2026-10-16T00:00:00.000Z').length, 0);
  });

  it('is a named rule of a new rules version', () => {
    assert.match(ATTENTION_RULES_VERSION, /^helm-twin-attention@2\+/);
    assert.match(due([commitment('d1', { lookAgainOn: '2026-10-01' })], '2026-10-16T00:00:00.000Z')[0].state.rule, /^look-again-due@1:/);
  });
});
