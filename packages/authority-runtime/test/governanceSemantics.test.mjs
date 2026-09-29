/**
 * Governance semantics over the real stack: delegation, separation of duties,
 * policy versions over time, reconsideration and fingerprints, rejection and
 * return, ordered approvals, superseded evaluations, approval expiry, the
 * material-change hook and tenant isolation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProofDecision, recordMeridianDoaV2 } from '../src/index.ts';
import { ORG_A, ORG_B, buildGovernanceStack, commitCanonical, expectFail, unwrap, USERS } from './harness.mjs';

const INVENTORY = ['INVENTORY_ALLOCATION'];

/** The Country GM on leave: inventory-allocation COMMIT, Vietnam Pharma, up to 2.0B, 25 Sep → 5 Oct. */
const leaveDelegation = (stack, over = {}) => ({
  delegatorRoleId: stack.entities.roleGM.entityId,
  delegateUserId: USERS.commercialDirector,
  delegateLabel: 'Tran Van Binh',
  decisionTypes: INVENTORY,
  acts: ['COMMIT'],
  scope: [
    { dimension: 'COUNTRY', entities: [stack.entities.vn] },
    { dimension: 'BUSINESS_UNIT', entities: [stack.entities.buPharma] },
  ],
  conditions: [
    { metricKey: 'CashImpact', label: 'Cash impact', comparator: 'GTE', threshold: '-2000000000', unit: 'currency', currency: 'VND' },
    { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE', threshold: '90', unit: 'percentage', currency: null },
  ],
  validFrom: '2026-09-25T00:00:00.000Z',
  validTo: '2026-10-05T00:00:00.000Z',
  reason: 'Country GM on annual leave',
  ...over,
});

const proof = async (stack, scenarioKey, title) => {
  const cd = stack.as(USERS.commercialDirector);
  const d = unwrap(
    await buildProofDecision(stack.decisions, cd, {
      title,
      managementQuestion: `How should Meridian handle the ${title.toLowerCase()}?`,
      scenarioId: stack.scenarioIds[scenarioKey],
      alternativeLabel: title,
      committedByLabel: 'Commercial Director Vietnam',
    }),
    title,
  );
  unwrap(await stack.authority.declareGovernanceProfile(cd, d.decision.id, { decisionTypeKey: 'INVENTORY_ALLOCATION' }), 'classify');
  return d;
};

describe('delegation — time-limited, bounded, and never more than the delegator holds', async () => {
  const stack = await buildGovernanceStack();
  const gm = stack.as(USERS.countryGM);
  const delegation = unwrap(await stack.authority.createDelegation(gm, leaveDelegation(stack)), 'delegate');

  test('the delegation records who, which role, what, where, how much, when and why', () => {
    assert.equal(delegation.delegatorUserId, USERS.countryGM);
    assert.equal(delegation.delegatorRoleLabel, 'Country GM Vietnam');
    assert.equal(delegation.delegateUserId, USERS.commercialDirector);
    assert.equal(delegation.validTo, '2026-10-05T00:00:00.000Z');
    assert.equal(delegation.reason, 'Country GM on annual leave');
  });

  test('a delegation cannot create authority the delegator does not possess', async () => {
    const cases = [
      [{ scope: [{ dimension: 'REGION', entities: [stack.entities.sea] }] }, /Southeast Asia|country Vietnam/],
      [{ conditions: [{ metricKey: 'CashImpact', label: 'Cash impact', comparator: 'GTE', threshold: '-5000000000', unit: 'currency', currency: 'VND' }] }, /loosened|dropped/],
      [{ decisionTypes: ['PRICING'] }, /holds no COMMIT authority for pricing/],
      [{ acts: ['OVERRIDE_POLICY'] }, /holds no OVERRIDE_POLICY authority/],
    ];
    for (const [over, why] of cases) {
      const err = expectFail(await stack.authority.createDelegation(gm, leaveDelegation(stack, over)), 'exceeding delegation');
      assert.equal(err.code, 'authority.delegation_exceeds_authority');
      assert.match(err.message, why);
    }
    const notMine = expectFail(await stack.authority.createDelegation(stack.as(USERS.commercialDirector), leaveDelegation(stack, { delegateUserId: USERS.financeDirector })), 'not in the seat');
    assert.match(notMine.message, /does not occupy the role/);
  });

  test('inside the window and inside its limits: AUTHORIZED through the delegation', async () => {
    stack.clock.jumpTo('2026-09-28T09:00:00.000Z');
    const built = await commitCanonical(stack);
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    assert.equal(evaluation.result, 'AUTHORIZED');
    assert.equal(evaluation.basisDelegationId, delegation.id);
    assert.equal(evaluation.delegations[0].outcome, 'APPLIED');
    assert.ok(evaluation.explanation.some((l) => /through a delegation/.test(l)));
    const timeline = unwrap(await stack.decisions.timeline(stack.scope, built.decision.id), 'timeline');
    assert.ok(timeline.some((e) => e.eventType === 'DELEGATION_USED'));
  });

  test('inside the window but above the delegated line: the delegation does not authorize it', async () => {
    const c = await proof(stack, 'alternative-product', 'Alternative analyzer allocation');
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, c.commitment.id), 'evaluate');
    assert.equal(evaluation.delegations[0].outcome, 'EXCEEDED');
    assert.notEqual(evaluation.result, 'AUTHORIZED');
    assert.deepEqual(evaluation.requiredAuthorities.map((r) => r.roleLabel), ['Country GM Vietnam', 'Finance Director Vietnam']);
  });

  test('inside the window but outside the delegated scope: nothing', async () => {
    const d = unwrap(
      await buildProofDecision(stack.decisions, stack.as(USERS.commercialDirector), {
        title: 'Industrial allocation',
        managementQuestion: 'How should Meridian allocate replenishment stock to the Industrial BU?',
        scenarioId: stack.scenarioIds['call-off'],
        alternativeLabel: 'Serve the Industrial BU',
        committedByLabel: 'Commercial Director Vietnam',
      }),
      'industrial',
    );
    unwrap(
      await stack.authority.declareGovernanceProfile(stack.as(USERS.commercialDirector), d.decision.id, {
        decisionTypeKey: 'INVENTORY_ALLOCATION',
        declaredSubjects: [stack.entities.buIndustrial],
      }),
      'classify',
    );
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'evaluate');
    assert.equal(evaluation.delegations[0].outcome, 'OUTSIDE_SCOPE');
    assert.equal(evaluation.result, 'NOT_AUTHORIZED');
  });

  test('outside the window the delegation does not exist', async () => {
    stack.clock.jumpTo('2026-10-10T09:00:00.000Z');
    const built = await commitCanonical(stack);
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    assert.equal(evaluation.delegations[0].outcome, 'NOT_VALID_AT_ACT');
    assert.equal(evaluation.result, 'REQUIRES_APPROVAL');
  });

  test('a revoked delegation is revoked once, by its delegator, and stops applying from then on', async () => {
    const other = unwrap(await stack.authority.createDelegation(gm, leaveDelegation(stack, { validFrom: '2026-10-10T00:00:00.000Z', validTo: '2026-10-20T00:00:00.000Z' })), 'second');
    expectFail(await stack.authority.revokeDelegation({ ...stack.as(USERS.financeDirector), role: 'member' }, other.id, 'not mine to revoke'), 'stranger');
    const revoked = unwrap(await stack.authority.revokeDelegation(gm, other.id, 'Back from leave early'), 'revoke');
    assert.ok(revoked.revokedAt);
    expectFail(await stack.authority.revokeDelegation(gm, other.id, 'again'), 'revoke twice');
    const built = await commitCanonical(stack);
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    assert.ok(evaluation.delegations.some((d) => d.delegationId === other.id && d.outcome === 'REVOKED'));
    assert.notEqual(evaluation.result, 'AUTHORIZED');
  });
});

describe('approval through a delegation', async () => {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  const { required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');

  test('the Finance Director approves as the Country GM\'s delegate, and the basis says DELEGATION', async () => {
    unwrap(
      await stack.authority.createDelegation(stack.as(USERS.countryGM), {
        ...leaveDelegation(stack, { delegateUserId: USERS.financeDirector, delegateLabel: 'Le Thi Hoa', acts: ['APPROVE'], scope: [{ dimension: 'COUNTRY', entities: [stack.entities.vn] }] }),
        conditions: [
          { metricKey: 'CashImpact', label: 'Cash impact', comparator: 'GTE', threshold: '-3000000000', unit: 'currency', currency: 'VND' },
          { metricKey: 'DemandCoverage', label: 'Demand coverage', comparator: 'GTE', threshold: '90', unit: 'percentage', currency: null },
        ],
      }),
      'delegate approval',
    );
    stack.clock.jumpTo('2026-09-26T09:00:00.000Z');
    const act = unwrap(await stack.authority.recordApproval(stack.as(USERS.financeDirector), required[0].id, { comments: 'Approved as delegate of the Country GM.' }), 'approve');
    assert.equal(act.basis.kind, 'DELEGATION');
    assert.equal(act.approverRoleLabel, 'Country GM Vietnam');
    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'state');
    assert.equal(state.state, 'APPROVED');
  });
});

describe('separation of duties', async () => {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  const { required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');

  test('the committer, now acting Country GM, cannot be the independent Country GM approval', async () => {
    // The Country GM leaves; the Commercial Director is appointed acting Country GM.
    unwrap(await stack.authority.endOccupancy(stack.scope, stack.occupancies.countryGM.id, '2026-09-20T00:00:00.000Z'), 'GM leaves');
    unwrap(
      await stack.authority.recordOccupancy(stack.scope, {
        roleId: stack.entities.roleGM.entityId,
        userId: USERS.commercialDirector,
        personLabel: 'Tran Van Binh',
        kind: 'ACTING',
        validFrom: '2026-09-20T00:00:00.000Z',
        basis: 'Acting appointment during the vacancy (demo)',
      }),
      'acting',
    );
    stack.clock.jumpTo('2026-09-21T09:00:00.000Z');
    const err = expectFail(
      await stack.authority.recordApproval(stack.as(USERS.commercialDirector), required[0].id, { comments: 'Approving my own commitment as acting GM.' }),
      'self-approval',
    );
    assert.equal(err.code, 'authority.separation_of_duties');
    assert.match(err.message, /someone other than the person who committed/);
    const timeline = unwrap(await stack.decisions.timeline(stack.scope, built.decision.id), 'timeline');
    const refused = timeline.find((e) => e.eventType === 'APPROVAL_REFUSED');
    assert.ok(refused, 'the refused attempt is on the record');
    assert.equal(refused.payload.code, 'authority.separation_of_duties');
  });

  test('someone outside the required role is refused too, and told what is required', async () => {
    const err = expectFail(
      await stack.authority.recordApproval(stack.as(USERS.financeDirector), required[0].id, { comments: 'I am senior enough.' }),
      'wrong role',
    );
    assert.equal(err.code, 'authority.not_the_required_authority');
    assert.match(err.message, /requires Country GM Vietnam/);
    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'state');
    assert.equal(state.state, 'PENDING_APPROVAL', 'refusals leave the requirement open');
  });

  test('the store refuses a self-approval even if the runtime were bypassed', async () => {
    const [evaluation] = unwrap(await stack.authorityStore.listEvaluations(stack.scope, { commitmentId: built.commitment.id }), 'evaluations');
    const err = expectFail(
      await stack.authorityStore.recordApprovalAct(stack.scope, {
        requiredApprovalId: required[0].id,
        evaluationId: evaluation.id,
        decisionId: built.decision.id,
        commitmentId: built.commitment.id,
        commitmentFingerprint: built.commitment.fingerprint,
        approverUserId: USERS.commercialDirector,
        approverLabel: 'Tran Van Binh',
        approverRoleId: required[0].roleId,
        approverRoleLabel: required[0].roleLabel,
        basis: { kind: 'ROLE_OCCUPANCY', occupancyId: null, delegationId: null, ruleId: null },
        decision: 'APPROVE',
        comments: 'direct write',
        conditions: '',
        validUntil: null,
        actedAt: '2026-09-21T10:00:00.000Z',
      }),
      'store self-approval',
    );
    assert.equal(err.code, 'authority.separation_of_duties');
  });

  test('acting in the seat, the same person may commit a NEW commitment within the seat\'s authority', async () => {
    const d = await proof(stack, 'reallocate', 'Second reallocation');
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'evaluate');
    assert.equal(evaluation.result, 'AUTHORIZED');
    assert.ok(evaluation.actorRoles.some((r) => r.roleLabel === 'Country GM Vietnam' && r.kind === 'ACTING'));
  });
});

describe('policy versions — no retroactive authority, history never rewritten', async () => {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  const first = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'v1 evaluation');
  unwrap(await stack.authority.recordApproval(stack.as(USERS.countryGM), first.required[0].id, { comments: 'Approved under DOA-2026-04.' }), 'approve');
  const v2 = unwrap(await recordMeridianDoaV2(stack.authority, stack.scope, stack.governance, stack.doa.policy), 'DOA v2');

  test('the September commitment is still judged by version 1 — re-evaluating does not import version 2', async () => {
    const again = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'again');
    assert.deepEqual(again.evaluation.policies.map((p) => [p.reference, p.version]), [['DOA-2026-04', 1]]);
    assert.equal(again.evaluation.result, 'REQUIRES_APPROVAL');
  });

  test('the historical evaluation still names version 1\'s rules, and its approval still explains by them', async () => {
    const stored = unwrap(await stack.authorityStore.getEvaluation(stack.scope, first.evaluation.id), 'stored');
    const v1RuleIds = new Set(stack.doa.rules.map((r) => r.id));
    assert.ok(stored.rules.every((r) => v1RuleIds.has(r.ruleId)));
    const acts = unwrap(await stack.authority.listApprovalActs(stack.scope, { commitmentId: built.commitment.id }), 'acts');
    const lineage = unwrap(await stack.authority.explainApproval(stack.scope, acts[0].id), 'lineage');
    assert.equal(lineage.basisPolicy.version, 1);
  });

  test('an October commitment is judged by version 2: the same −1.7355B is now inside the Commercial Director\'s line', async () => {
    stack.clock.jumpTo('2026-10-03T09:00:00.000Z');
    const october = await commitCanonical(stack);
    const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, october.commitment.id), 'october');
    assert.deepEqual(evaluation.policies.map((p) => [p.reference, p.version]), [['DOA-2026-10', 2]]);
    assert.equal(evaluation.result, 'AUTHORIZED');
    const v2Rule = v2.rules.find((r) => r.key === 'commercial-director-inventory-allocation');
    assert.equal(evaluation.basisRuleId, v2Rule.id);
  });

  test('a policy version is never edited: recording the same version again is refused', async () => {
    const err = expectFail(await recordMeridianDoaV2(stack.authority, stack.scope, stack.governance, stack.doa.policy), 'duplicate version');
    assert.equal(err.code, 'authority.immutable');
    const rules = unwrap(await stack.authorityStore.listRules(stack.scope), 'rules');
    assert.throws(() => {
      rules[0].conditions = [];
    });
  });

  test('only an admin records authority', async () => {
    const member = { ...stack.as(USERS.commercialDirector), role: 'member' };
    const err = expectFail(await recordMeridianDoaV2(stack.authority, member, stack.governance, stack.doa.policy), 'member policy');
    assert.match(err.message, /admin/);
  });
});

describe('reconsideration — a new fingerprint needs its own evaluation', async () => {
  const stack = await buildGovernanceStack();

  test('F1 AUTHORIZED does not authorize F2', async () => {
    const d = await proof(stack, 'call-off', 'Q1 call-off');
    const f1 = unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'F1');
    assert.equal(f1.evaluation.result, 'AUTHORIZED');

    const cd = stack.as(USERS.commercialDirector);
    const r2 = unwrap(await stack.decisions.reconsider(cd, d.decision.id, { reason: 'Rohto moved the call-off window by two weeks.' }), 'reconsider');
    const ws = unwrap(await stack.decisions.getWorkspace(cd, d.decision.id, r2.id), 'workspace');
    const alt = ws.alternatives.find((a) => a.status === 'MODELLED');
    const committed = unwrap(
      await stack.decisions.commit(cd, r2.id, {
        chosenAlternativeId: alt.id,
        authorship: 'MANAGEMENT_AUTHORED_DEMO',
        committedByLabel: 'Commercial Director Vietnam',
        summary: 'Recommitted after the window moved.',
        rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Window moved', statement: 'The call-off still fits the replenishment cycle two weeks later.' }],
        acceptedTradeOffs: [],
        expectedOutcomes: [{ label: 'Cash impact', kind: 'MODELLED', metricKey: 'CashImpact', subjectHint: 'Rohto' }],
      }),
      'F2',
    );
    const f2 = committed.commitment;
    assert.notEqual(f2.fingerprint, d.commitment.fingerprint);

    const before = unwrap(await stack.authority.getGovernanceState(stack.scope, f2.id), 'F2 state');
    assert.equal(before.state, 'NOT_EVALUATED', 'nothing carries over from F1');
    assert.equal(before.evaluation, null);
    const f1State = unwrap(await stack.authority.getGovernanceState(stack.scope, d.commitment.id), 'F1 state');
    assert.equal(f1State.state, 'AUTHORIZED', 'and F1 keeps its own judgement');

    const e2 = unwrap(await stack.authority.evaluate(stack.scope, f2.id), 'evaluate F2');
    assert.equal(e2.evaluation.commitmentFingerprint, f2.fingerprint);
    assert.notEqual(e2.evaluation.id, f1.evaluation.id);
  });

  test('an approved F1 does not approve F2; F2 needs its own approval act', async () => {
    const built = await commitCanonical(stack);
    const f1 = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'F1');
    unwrap(await stack.authority.recordApproval(stack.as(USERS.countryGM), f1.required[0].id, { comments: 'Approved.' }), 'approve F1');

    const cd = stack.as(USERS.commercialDirector);
    const r2 = unwrap(await stack.decisions.reconsider(cd, built.decision.id, { reason: 'Distributor D asked for two more days.' }), 'reconsider');
    const ws = unwrap(await stack.decisions.getWorkspace(cd, built.decision.id, r2.id), 'workspace');
    const chosen = ws.alternatives.find((a) => a.label.includes('Reallocate'));
    const f2 = unwrap(
      await stack.decisions.commit(cd, r2.id, {
        chosenAlternativeId: chosen.id,
        authorship: 'MANAGEMENT_AUTHORED_DEMO',
        committedByLabel: 'Commercial Director Vietnam',
        summary: 'Reallocate, two days later.',
        rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Still the choice', statement: 'Two days do not change the trade-off management accepted.' }],
        acceptedTradeOffs: [],
        expectedOutcomes: [
          { label: 'Cash impact', kind: 'MODELLED', metricKey: 'CashImpact', subjectHint: 'Rohto' },
          { label: 'Customer service', kind: 'MODELLED', metricKey: 'DemandCoverage' },
        ],
      }),
      'F2',
    ).commitment;
    const e2 = unwrap(await stack.authority.evaluate(stack.scope, f2.id), 'evaluate F2');
    assert.equal(e2.evaluation.result, 'REQUIRES_APPROVAL');
    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, f2.id), 'F2 state');
    assert.equal(state.state, 'PENDING_APPROVAL', "F1's approval does not satisfy F2");
    const reuse = expectFail(await stack.authority.recordApproval(stack.as(USERS.countryGM), f1.required[0].id, { comments: 'again' }), 'reuse F1');
    assert.equal(reuse.code, 'authority.already_acted');
    unwrap(await stack.authority.recordApproval(stack.as(USERS.countryGM), e2.required[0].id, { comments: 'Approved again.' }), 'approve F2');
    assert.equal(unwrap(await stack.authority.getGovernanceState(stack.scope, f2.id), 'F2 approved').state, 'APPROVED');
  });
});

describe('rejection, return and ordered approvals', async () => {
  const stack = await buildGovernanceStack();

  test('a rejection is recorded against the commitment and deletes nothing', async () => {
    const built = await commitCanonical(stack);
    const { required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    expectFail(await stack.authority.recordRejection(stack.as(USERS.countryGM), required[0].id, { comments: '' }), 'reason-less rejection');
    const act = unwrap(await stack.authority.recordRejection(stack.as(USERS.countryGM), required[0].id, { comments: 'The distributor buffer is too thin this quarter.' }), 'reject');
    assert.equal(act.decision, 'REJECT');
    const state = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'state');
    assert.equal(state.state, 'REJECTED');
    assert.equal(state.approvalProgress, 'REJECTED');
    assert.ok(unwrap(await stack.decisionStore.getCommitment(stack.scope, built.commitment.id), 'still there'));
    const again = expectFail(await stack.authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'changed my mind' }), 'second act');
    assert.equal(again.code, 'authority.already_acted');
  });

  test('a return for reconsideration is its own response', async () => {
    const built = await commitCanonical(stack);
    const { required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    unwrap(await stack.authority.returnForReconsideration(stack.as(USERS.countryGM), required[0].id, { comments: 'Get the re-labelling cost quoted first.' }), 'return');
    assert.equal(unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'state').state, 'RETURNED');
  });

  test('ordered approvals: the Finance Director (sequence 2) cannot act before the Country GM (sequence 1)', async () => {
    const d = await proof(stack, 'alternative-product', 'Alternative analyzer');
    const { evaluation, required } = unwrap(await stack.authority.evaluate(stack.scope, d.commitment.id), 'evaluate');
    assert.equal(evaluation.result, 'REQUIRES_APPROVAL');
    const fd = required.find((r) => r.roleLabel === 'Finance Director Vietnam');
    const gm = required.find((r) => r.roleLabel === 'Country GM Vietnam');
    const early = expectFail(await stack.authority.recordApproval(stack.as(USERS.financeDirector), fd.id, { comments: 'Fine by Finance.' }), 'out of sequence');
    assert.equal(early.code, 'authority.out_of_sequence');
    unwrap(await stack.authority.recordApproval(stack.as(USERS.countryGM), gm.id, { comments: 'Approved.' }), 'GM');
    assert.equal(unwrap(await stack.authority.getGovernanceState(stack.scope, d.commitment.id), 'half').state, 'PENDING_APPROVAL');
    unwrap(await stack.authority.recordApproval(stack.as(USERS.financeDirector), fd.id, { comments: 'Cash exposure accepted by Finance.' }), 'FD');
    assert.equal(unwrap(await stack.authority.getGovernanceState(stack.scope, d.commitment.id), 'both').state, 'APPROVED');
  });

  test('a requirement of a superseded evaluation cannot be acted on', async () => {
    const built = await commitCanonical(stack);
    const first = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'first');
    unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'second');
    const err = expectFail(await stack.authority.recordApproval(stack.as(USERS.countryGM), first.required[0].id, { comments: 'Approved.' }), 'stale');
    assert.equal(err.code, 'authority.superseded_evaluation');
  });

  test('an approval that lapses no longer satisfies its requirement', async () => {
    const built = await commitCanonical(stack);
    const { required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
    const soon = new Date(stack.clock.peek().getTime() + 3 * 24 * 3600 * 1000).toISOString();
    unwrap(await stack.authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'Valid for three days.', validUntil: soon }), 'approve');
    assert.equal(unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'now').state, 'APPROVED');
    stack.clock.jump(4 * 24 * 3600 * 1000);
    const later = unwrap(await stack.authority.getGovernanceState(stack.scope, built.commitment.id), 'later');
    assert.equal(later.state, 'PENDING_APPROVAL');
    assert.match(later.requirements[0].note, /lapsed/);
  });
});

describe('material change — a hook, never an automatic recompute', async () => {
  const stack = await buildGovernanceStack();
  const built = await commitCanonical(stack);
  const { evaluation } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
  const runOf = () => evaluation.consequences.find((c) => c.metricKey === 'CashImpact').runId;

  test('the same run changes nothing', async () => {
    const report = unwrap(await stack.authority.materialChange(stack.scope, evaluation.id, runOf()), 'same');
    assert.equal(report.changes.length, 0);
    assert.equal(report.reevaluationRequired, false);
  });

  test('the chosen scenario re-simulated with the re-labelling cost: cash crosses a line, re-evaluation is required, nothing is recomputed', async () => {
    // Finance's open challenge turns out right: re-labelling costs 1.1B VND more.
    const revision = unwrap(await stack.scenarios.createRevision(stack.scope, stack.scenarioIds.reallocate, { notes: 'Re-labelling quoted' }), 'revision');
    unwrap(
      await stack.scenarios.addOverride(stack.scope, revision.id, {
        overrideType: 'VALUE_OVERRIDE',
        targetNodeId: stack.nodeIds.unitCost,
        operation: 'ADD',
        value: '65476190',
        unit: 'currency',
        currency: 'VND',
        period: null,
        provenanceKind: 'EXTERNAL_SIGNAL',
        rationale: 'Re-labelling into hospital tender packs, quoted per unit.',
        confidence: 0.8,
      }),
      'override',
    );
    const rerun = unwrap(await stack.scenarios.execute(stack.scope, stack.scenarioIds.reallocate), 're-simulate');
    const report = unwrap(await stack.authority.materialChange(stack.scope, evaluation.id, rerun.run.id), 'moved');
    const cash = report.changes.find((c) => c.metricKey === 'CashImpact');
    assert.ok(cash, 'the cash impact moved');
    assert.equal(cash.evaluatedValue, '-1735500000');
    assert.ok(Number(cash.currentValue) < -2000000000, `cash is now ${cash.currentValue}`);
    assert.equal(cash.changesACondition, true, 'it crosses the Finance Director line');
    assert.equal(report.reevaluationRequired, true);
    // The hook reports; it does not act.
    const stored = unwrap(await stack.authorityStore.getEvaluation(stack.scope, evaluation.id), 'stored');
    assert.equal(stored.consequences.find((c) => c.metricKey === 'CashImpact').value, '-1735500000');
    const evaluations = unwrap(await stack.authority.listEvaluations(stack.scope, { commitmentId: built.commitment.id }), 'evaluations');
    assert.equal(evaluations.length, 1, 'no evaluation was added behind anyone\'s back');
  });
});

describe('tenant isolation', async () => {
  const stack = await buildGovernanceStack({ orgs: [ORG_A, ORG_B] });
  const built = await commitCanonical(stack);
  const { evaluation, required } = unwrap(await stack.authority.evaluate(stack.scope, built.commitment.id), 'evaluate');
  const other = stack.byOrg[ORG_B].scope;

  test('another organization sees none of it', async () => {
    assert.equal(unwrap(await stack.authorityStore.getEvaluation(other, evaluation.id), 'eval'), null);
    assert.equal(unwrap(await stack.authorityStore.getRequiredApproval(other, required[0].id), 'req'), null);
    const policies = unwrap(await stack.authority.listPolicies(other), 'policies');
    assert.ok(policies.every((p) => p.orgId === ORG_B));
    expectFail(await stack.authority.evaluate(other, built.commitment.id), 'foreign commitment');
    expectFail(await stack.authority.recordApproval({ ...other, actorId: USERS.countryGM }, required[0].id, { comments: 'cross-org' }), 'cross-org approval');
  });
});
