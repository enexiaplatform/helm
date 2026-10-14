/**
 * A delegation of authority as an administrator records it in HELM (audit 2026-10-13: "a simple DoA table entered in
 * the UI"): rules with no scope constraint (the whole organization), one value line each, and an approval required
 * above a line. The kernel accepts it and evaluates a commitment against it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGovernanceStack, commitCanonical, unwrap, USERS } from './harness.mjs';

describe('a delegation of authority recorded from the admin form', () => {
  it('organization-wide lines are accepted, and a commitment is evaluated against them', async () => {
    const stack = await buildGovernanceStack();
    const gm = stack.entities.roleGM;
    const fd = stack.entities.roleFD;
    const cd = stack.entities.roleCommDir;
    const line = (metricKey, comparator, threshold) => [{ metricKey, label: metricKey, comparator, threshold, unit: 'currency', currency: 'VND' }];
    const recorded = unwrap(
      await stack.authority.recordPolicy(stack.scope, {
        key: 'org-doa',
        version: 1,
        title: 'Delegation of authority',
        reference: 'DOA',
        source: 'DOA_DOCUMENT',
        demo: false,
        rationale: 'Recorded in HELM by an administrator.',
        validFrom: '2026-01-01T00:00:00.000Z',
        rules: [
          { key: 'line-1', holder: { kind: 'ROLE', roleId: cd.entityId, label: cd.label }, effect: 'GRANT', decisionTypes: ['INVENTORY_ALLOCATION'], acts: ['PREPARE', 'RECOMMEND', 'COMMIT', 'APPROVE', 'EXECUTE'], scope: [], conditions: line('CashImpact', 'GTE', '-1'), escalationRoleId: gm.entityId, escalationRoleLabel: gm.label, approvalIndependence: 'INDEPENDENT_OF_COMMITTER', rationale: 'up to a line' },
          { key: 'line-2', holder: { kind: 'ROLE', roleId: fd.entityId, label: fd.label }, effect: 'REQUIRE_APPROVAL', decisionTypes: ['INVENTORY_ALLOCATION'], acts: ['COMMIT'], scope: [], conditions: line('CashImpact', 'LT', '0'), escalationRoleId: null, escalationRoleLabel: null, approvalIndependence: 'INDEPENDENT_OF_COMMITTER', rationale: 'approval above a line' },
        ],
      }),
      'policy',
    );
    assert.equal(recorded.rules.length, 2);
    assert.deepEqual(recorded.rules.map((r) => r.scope), [[], []]);

    const built = await commitCanonical(stack);
    const ev = unwrap(await stack.authority.evaluate(stack.as(USERS.commercialDirector), built.commitment.id), 'evaluate');
    assert.ok(ev.evaluation.policies.some((p) => p.key === 'org-doa'), 'the admin policy is in force');
    assert.ok(ev.evaluation.rules.some((r) => r.ruleId === recorded.rules[0].id), 'its line is assessed');
    assert.ok(typeof ev.evaluation.result === 'string');
  });
});
