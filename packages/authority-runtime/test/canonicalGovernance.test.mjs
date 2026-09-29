/**
 * The canonical governance proofs, end to end, over the real Phase 1–5 stack.
 *
 *   1. The Rohto decision is committed by the demo Commercial Director.
 *   2. The engine reads the chosen scenario's computed consequences.
 *   3. The demo rule's cash line is exceeded.
 *   4. Evaluation = REQUIRES_APPROVAL.
 *   5. Required authority = Country GM Vietnam.
 *   6. The Country GM's approval act is recorded.
 *   7. Governance state = APPROVED.
 *   8. The commitment is byte-identical throughout.
 *   9. The approval resolves to value lineage and source facts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProofDecision, DEMO_GOVERNANCE_LABEL } from '../src/index.ts';
import { buildGovernanceStack, commitCanonical, expectFail, unwrap, USERS } from './harness.mjs';

const snapshotOf = (x) => JSON.stringify(x);

describe('canonical Rohto governance proof', async () => {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  const commitmentBefore = snapshotOf(unwrap(await stack.decisionStore.getCommitment(stack.scope, built.commitment.id), 'commitment'));

  const { evaluation, required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');

  test('1 — the commitment is the Commercial Director\'s, by identity, not by label', () => {
    assert.equal(built.commitment.committedBy, USERS.commercialDirector);
    assert.equal(evaluation.actorUserId, USERS.commercialDirector);
    assert.deepEqual(evaluation.actorRoles.map((r) => r.roleLabel), ['Commercial Director Vietnam']);
    assert.equal(built.commitment.authorityStatus, 'NOT_EVALUATED', 'the commitment itself carries no verdict');
  });

  test('2 — the consequences are read from the chosen scenario run, not typed', async () => {
    const chosen = Object.values(built.alternatives).find((a) => a.id === built.commitment.chosenAlternativeId);
    const state = unwrap(await stack.scenarios.getFutureState(stack.scope, chosen.scenarioRunId), 'future state');
    const cash = evaluation.consequences.find((c) => c.metricKey === 'CashImpact');
    assert.equal(cash.value, '-1735500000');
    assert.equal(cash.runId, chosen.scenarioRunId);
    assert.equal(cash.source, 'EXPECTED_OUTCOME');
    assert.equal(state.values.find((v) => v.nodeId === cash.nodeId).value, cash.value);
    assert.equal(evaluation.consequences.find((c) => c.metricKey === 'DemandCoverage').value, '96.8858');
  });

  test('3 & 4 — the demo cash line is exceeded, so the result is REQUIRES_APPROVAL', () => {
    assert.equal(evaluation.result, 'REQUIRES_APPROVAL');
    const deciding = evaluation.rules.find((r) => r.deciding);
    assert.equal(deciding.ruleKey, 'commercial-director-inventory-allocation');
    assert.equal(deciding.policyReference, 'DOA-2026-04');
    assert.equal(deciding.demoPolicy, true);
    assert.deepEqual(deciding.scopeChecks.map((s) => [s.dimension, s.outcome]), [['COUNTRY', 'WITHIN'], ['BUSINESS_UNIT', 'WITHIN']]);
    assert.equal(deciding.conditionChecks[0].outcome, 'FAIL');
    assert.equal(deciding.conditionChecks[0].threshold, '-1000000000');
    assert.equal(evaluation.governability, 'GOVERNABLE');
    assert.ok(evaluation.fingerprint.startsWith('aev_'));
  });

  test('5 — the required authority is the Country GM, generated from the evaluation', () => {
    assert.equal(required.length, 1);
    assert.equal(required[0].roleLabel, 'Country GM Vietnam');
    assert.equal(required[0].kind, 'ESCALATION');
    assert.equal(required[0].evaluationId, evaluation.id);
    assert.equal(required[0].commitmentFingerprint, built.commitment.fingerprint);
    assert.equal(required[0].independentOfUserId, USERS.commercialDirector);
  });

  test('"Why does this require approval?" is answered in sentences, with rule, scope, value and line', async () => {
    const { why } = unwrap(await stack.authority.explain(stack.scope, evaluation.id), 'explain');
    const text = why.join('\n');
    assert.match(text, /commercial-director-inventory-allocation/);
    assert.match(text, /Vietnam ✓/);
    assert.match(text, /Pharma BU ✓/);
    assert.match(text, /−1 735 500 000 VND/);
    assert.match(text, /≥ −1 000 000 000 VND/);
    assert.match(text, /Country GM Vietnam/);
    assert.match(text, /DOA-2026-04/);
    assert.ok(evaluation.explanation.some((l) => l.includes(DEMO_GOVERNANCE_LABEL)));
  });

  test('the approver receives the decision, not a blank form', async () => {
    const request = unwrap(await stack.authority.approvalRequest(stack.scope, required[0].id), 'request');
    assert.match(request.managementQuestion, /Rohto order/);
    assert.match(request.chosenAlternative.label, /Reallocate/);
    assert.equal(request.chosenAlternative.scenarioKey, 'reallocate');
    assert.ok(request.keyConsequences.some((c) => c.metricKey === 'CashImpact'));
    assert.equal(request.acceptedTradeOffs.length, 2);
    assert.ok(request.uncertainty.some((u) => /Open challenge/.test(u)), 'the open Finance challenge reaches the approver');
    assert.ok(request.uncertainty.some((u) => /nobody stands behind/.test(u)), 'the unowned critical assumption reaches the approver');
    assert.ok(request.authorityReason.length >= 3);
  });

  test('6 & 7 — the Country GM approves; state APPROVED, with the policy result kept apart', async () => {
    const pending = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'pending');
    assert.equal(pending.state, 'PENDING_APPROVAL');
    assert.equal(pending.policyResult, 'REQUIRES_APPROVAL');
    assert.equal(pending.approvalProgress, 'PENDING');

    const act = unwrap(
      await stack.authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'Within my authority; the buffer risk is accepted.' }),
      'approve',
    );
    assert.equal(act.approverUserId, USERS.countryGM);
    assert.equal(act.approverLabel, 'Nguyen Thi Mai');
    assert.equal(act.basis.kind, 'ROLE_OCCUPANCY');
    assert.equal(act.decision, 'APPROVE');

    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'state');
    assert.equal(state.state, 'APPROVED');
    assert.equal(state.policyResult, 'REQUIRES_APPROVAL', 'the policy result does not become "APPROVED"');
    assert.equal(state.approvalProgress, 'APPROVED');
  });

  test('8 — the commitment is byte-identical after evaluation and approval', async () => {
    const after = snapshotOf(unwrap(await stack.decisionStore.getCommitment(stack.scope, built.commitment.id), 'commitment'));
    assert.equal(after, commitmentBefore);
    const decision = unwrap(await stack.decisions.getDecision(stack.scope, built.decision.id), 'decision');
    assert.equal(decision.authorityStatus, 'NOT_EVALUATED');
  });

  test('9 — the approval resolves to value lineage and source facts', async () => {
    const acts = unwrap(await stack.authority.listApprovalActs(stack.scope, { commitmentId: built.commitment.id }), 'acts');
    const lineage = unwrap(await stack.authority.explainApproval(stack.scope, acts[0].id), 'lineage');
    assert.equal(lineage.requirement.id, required[0].id);
    assert.equal(lineage.evaluation.id, evaluation.id);
    assert.equal(lineage.basisRule.key, 'country-gm-inventory-allocation');
    assert.equal(lineage.basisPolicy.reference, 'DOA-2026-04');
    assert.equal(lineage.approverOccupancy.personLabel, 'Nguyen Thi Mai');
    assert.equal(lineage.commitment.fingerprint, built.commitment.fingerprint);
    assert.ok(lineage.valueLineage.length >= 2);
    const cash = lineage.valueLineage.find((l) => l.value.metricKey === 'CashImpact');
    assert.ok(cash.lineage, 'the cash impact has an engine explanation');
    assert.ok(cash.calculationRunId, 'and a calculation run behind it');
    const text = JSON.stringify(cash.lineage);
    assert.match(text, /observation|Observation/, 'the lineage reaches observations');
  });

  test('the timeline records the governance acts, and they are appended, never rewritten', async () => {
    const timeline = unwrap(await stack.decisions.timeline(stack.scope, built.decision.id), 'timeline');
    const types = timeline.map((e) => e.eventType);
    for (const t of ['COMMITTED', 'GOVERNANCE_CLASSIFIED', 'AUTHORITY_EVALUATED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED']) {
      assert.ok(types.includes(t), `${t} missing from the timeline`);
    }
    assert.ok(types.indexOf('COMMITTED') < types.indexOf('AUTHORITY_EVALUATED'));
    assert.ok(types.indexOf('AUTHORITY_EVALUATED') < types.indexOf('APPROVAL_GRANTED'));
  });

  test('the evaluation is write-once: frozen in memory, and a second evaluation supersedes rather than edits', async () => {
    const stored = unwrap(await stack.authorityStore.getEvaluation(stack.scope, evaluation.id), 'stored');
    assert.throws(() => {
      stored.result = 'AUTHORIZED';
    });
    const again = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'again');
    assert.equal(again.evaluation.supersedesEvaluationId, evaluation.id);
    assert.equal(again.evaluation.fingerprint, evaluation.fingerprint, 'same commitment, same authority, same judgement');
    const first = unwrap(await stack.authorityStore.getEvaluation(stack.scope, evaluation.id), 'first');
    assert.equal(snapshotOf(first), snapshotOf(stored));
  });
});

describe('direct authorization — a smaller commitment inside the Commercial Director\'s line', async () => {
  const stack = await buildGovernanceStack();
  const cd = stack.as(USERS.commercialDirector);
  const small = unwrap(
    await buildProofDecision(stack.decisions, cd, {
      title: 'Rohto 2027-Q1 call-off',
      managementQuestion: 'How should Meridian serve the Rohto 2027-Q1 framework call-off?',
      scenarioId: stack.scenarioIds['call-off'],
      alternativeLabel: 'Call off from standard replenishment',
      committedByLabel: 'Commercial Director Vietnam',
    }),
    'small decision',
  );
  unwrap(await stack.authority.declareGovernanceProfile(cd, small.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION' }), 'classify');
  const { evaluation, required } = unwrap(await stack.authority.evaluate(stack.scope, small.commitment.id), 'evaluate');

  test('AUTHORIZED, with no approval required — because of the computed consequences, not a typed amount', async () => {
    assert.equal(evaluation.result, 'AUTHORIZED');
    assert.equal(required.length, 0);
    assert.equal(evaluation.consequences.find((c) => c.metricKey === 'CashImpact').value, '-705600000');
    assert.equal(evaluation.rules.find((r) => r.deciding).ruleKey, 'commercial-director-inventory-allocation');
    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, small.commitment.id), 'state');
    assert.equal(state.state, 'AUTHORIZED');
    assert.equal(state.approvalProgress, 'NONE_REQUIRED');
  });

  test('the same actor and the same rule, only the consequences differ — so the rules are consequence-driven', async () => {
    const big = await commitCanonical(stack);
    const e = unwrap(await stack.authority.evaluate(stack.scope, big.commitment.id), 'canonical');
    assert.equal(e.evaluation.actorUserId, evaluation.actorUserId);
    assert.equal(e.evaluation.rules.find((r) => r.deciding).ruleId, evaluation.rules.find((r) => r.deciding).ruleId);
    assert.equal(e.evaluation.result, 'REQUIRES_APPROVAL');
  });
});

describe('scope failure on real commitments', async () => {
  const stack = await buildGovernanceStack();
  const cd = stack.as(USERS.commercialDirector);
  const proof = async (title, subject) => {
    const d = unwrap(
      await buildProofDecision(stack.decisions, cd, {
        title,
        managementQuestion: `How should Meridian handle the ${title.toLowerCase()} this quarter?`,
        scenarioId: stack.scenarioIds['call-off'],
        alternativeLabel: 'Serve from Vietnam replenishment stock',
        committedByLabel: 'Commercial Director Vietnam',
      }),
      title,
    );
    unwrap(
      await stack.authority.declareGovernanceProfile(cd, d.decision.id, {
        decisionTypeKey: 'INVENTORY_ALLOCATION',
        declaredSubjects: [stack.entities[subject]],
        note: `The allocation serves ${stack.entities[subject].label}.`,
      }),
      'classify',
    );
    return unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'evaluate').evaluation;
  };

  test('a Commercial Director Vietnam commitment that reaches Thailand is NOT_AUTHORIZED, though the cash fits', async () => {
    const e = await proof('Thailand Pharma allocation', 'buThPharma');
    assert.equal(e.result, 'NOT_AUTHORIZED');
    const cd = e.rules.find((r) => r.ruleKey === 'commercial-director-inventory-allocation');
    assert.equal(cd.conditionChecks[0].outcome, 'PASS', 'the threshold alone would have allowed it');
    assert.equal(cd.scopeChecks.find((s) => s.dimension === 'COUNTRY').outcome, 'OUTSIDE');
    assert.ok(e.scope.touched.some((t) => t.origin === 'DECLARED_SUBJECT' && t.label === 'Thailand Pharma BU'));
    assert.deepEqual(e.authoritiesInScope.map((a) => a.roleLabel), ['Regional MD Southeast Asia'], 'only the region spans both countries');
  });

  test('Vietnam Pharma authority does not reach the Vietnam Industrial BU', async () => {
    const e = await proof('Industrial BU allocation', 'buIndustrial');
    assert.equal(e.result, 'NOT_AUTHORIZED');
    const cd = e.rules.find((r) => r.ruleKey === 'commercial-director-inventory-allocation');
    assert.equal(cd.scopeChecks.find((s) => s.dimension === 'BUSINESS_UNIT').outcome, 'OUTSIDE');
    assert.ok(e.authoritiesInScope.some((a) => a.roleLabel === 'Country GM Vietnam'), 'the country-wide rule does reach it');
  });

  test('an unclassified decision is INDETERMINATE, with the missing field named', async () => {
    const d = unwrap(
      await buildProofDecision(stack.decisions, cd, {
        title: 'Unclassified allocation',
        managementQuestion: 'How should Meridian place this unclassified allocation?',
        scenarioId: stack.scenarioIds['call-off'],
        alternativeLabel: 'Serve from replenishment',
        committedByLabel: 'Commercial Director Vietnam',
      }),
      'unclassified',
    );
    const e = unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'evaluate').evaluation;
    assert.equal(e.result, 'INDETERMINATE');
    assert.equal(e.governability, 'NOT_GOVERNABLE');
    assert.ok(e.gaps.some((g) => g.code === 'DECISION_TYPE_UNMAPPED'));
  });

  test('a declared subject outside this organization is refused at classification', async () => {
    const d = unwrap(
      await buildProofDecision(stack.decisions, cd, {
        title: 'Foreign subject',
        managementQuestion: 'How should Meridian place an allocation with a foreign subject?',
        scenarioId: stack.scenarioIds['call-off'],
        alternativeLabel: 'Serve from replenishment',
        committedByLabel: 'Commercial Director Vietnam',
        commit: false,
      }),
      'foreign',
    );
    const err = expectFail(
      await stack.authority.declareGovernanceProfile(cd, d.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION', declaredSubjects: [{ entityId: 'no-such-entity', label: 'Elsewhere' }] }),
      'foreign subject',
    );
    assert.equal(err.code, 'authority.not_found');
    const err2 = expectFail(await stack.authority.declareGovernanceProfile(cd, d.decision.id, { decisionTypeKey: 'CAPEX' }), 'unknown type');
    assert.match(err2.message, /not a registered decision type/);
  });
});
