import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, requiresApproval, isEditable } from '../../src/domain/decisionStates.ts';

describe('decision state machine', () => {
  test('legal path: draft → analyzing → pending_approval → approved → executing → monitoring → closed', () => {
    assert.ok(canTransition('draft', 'analyzing'));
    assert.ok(canTransition('analyzing', 'pending_approval'));
    assert.ok(canTransition('pending_approval', 'approved'));
    assert.ok(canTransition('approved', 'executing'));
    assert.ok(canTransition('executing', 'monitoring'));
    assert.ok(canTransition('monitoring', 'closed'));
  });

  test('below-threshold decisions may skip approval', () => {
    assert.ok(canTransition('analyzing', 'approved'));
  });

  test('illegal jumps are rejected', () => {
    assert.equal(canTransition('draft', 'approved'), false);
    assert.equal(canTransition('closed', 'draft'), false);
    assert.equal(canTransition('approved', 'rejected'), false);
  });

  test('rejected decisions go back to analysis, not to approval', () => {
    assert.ok(canTransition('rejected', 'analyzing'));
    assert.equal(canTransition('rejected', 'pending_approval'), false);
  });

  test('approval requirement matches type-specific and any-type rules by threshold', () => {
    const rules = [
      { decisionType: null, thresholdAmount: 500_000_000, active: true },
      { decisionType: 'pricing', thresholdAmount: 100_000_000, active: true },
      { decisionType: 'investment', thresholdAmount: 0, active: false },
    ];
    assert.equal(requiresApproval(200_000_000, 'pricing', rules), true); // type rule
    assert.equal(requiresApproval(200_000_000, 'make_or_buy', rules), false); // below any-type
    assert.equal(requiresApproval(600_000_000, 'make_or_buy', rules), true); // any-type
    assert.equal(requiresApproval(1, 'investment', rules), false); // inactive rule
    assert.equal(requiresApproval(null, 'pricing', rules), false); // no amount
  });

  test('editability tracks analysis states only', () => {
    assert.ok(isEditable('draft'));
    assert.ok(isEditable('analyzing'));
    assert.ok(isEditable('rejected'));
    assert.equal(isEditable('approved'), false);
    assert.equal(isEditable('closed'), false);
  });
});
