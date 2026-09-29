/**
 * verify:authority-runtime — the canonical governance proof, executable.
 *
 *   1. The Rohto commitment by the demo Commercial Director is evaluated from
 *      its computed consequences: REQUIRES_APPROVAL, Country GM required.
 *   2. The Country GM's approval act is recorded; state APPROVED — while the
 *      policy result stays REQUIRES_APPROVAL (result ≠ progress).
 *   3. The commitment is byte-identical before and after; its own
 *      authorityStatus is still NOT_EVALUATED (commitment ≠ approval).
 *   4. A smaller commitment under the same rule is AUTHORIZED with no approval.
 *   5. Missing governance data is INDETERMINATE with the field named — never
 *      a guess.
 *   6. A reconsidered commitment (new fingerprint) starts NOT_EVALUATED;
 *      nothing from its predecessor carries over.
 *   7. An evaluation is immutable and a re-evaluation supersedes, never edits.
 *   8. Nothing ranks, scores or recommends; no AI.
 */

import { buildAuthorityStack, unwrap, expectFail, USERS } from './lib/authorityStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};

const stack = await buildAuthorityStack();
const { authority, scope } = stack;

// 1. canonical
const canonical = await stack.commitCanonical();
const before = JSON.stringify(unwrap(await stack.decisionStore.getCommitment(scope, canonical.commitment.id), 'commitment'));
const { evaluation, required } = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'evaluate');
check('canonical', evaluation.actorUserId === USERS.commercialDirector, 'the actor is not the identity that committed');
check('canonical', evaluation.result === 'REQUIRES_APPROVAL', `the canonical commitment is ${evaluation.result}, not REQUIRES_APPROVAL`);
check('canonical', required.length === 1 && required[0].roleLabel === 'Country GM Vietnam', 'the Country GM is not the required authority');
check('canonical', required[0]?.independentOfUserId === USERS.commercialDirector, 'the requirement is not independent of the committer');
const cash = evaluation.consequences.find((c) => c.metricKey === 'CashImpact');
check('canonical', cash?.value === '-1735500000' && cash?.source === 'EXPECTED_OUTCOME' && cash?.runId, 'the cash impact was not read from the chosen run');
const deciding = evaluation.rules.find((r) => r.deciding);
check('canonical', deciding?.conditionChecks.some((c) => c.outcome === 'FAIL' && c.threshold === '-1000000000'), 'the exceeded line is not named');
check('explain', evaluation.explanation.some((l) => /Threshold exceeded/.test(l)), 'the explanation does not say the threshold was exceeded');
check('explain', evaluation.explanation.some((l) => /Country GM Vietnam approval is required/.test(l)), 'the explanation does not say whose approval is required');
check('explain', evaluation.rules.length >= 5 && evaluation.rules.some((r) => r.outcome === 'REJECTED') && evaluation.rules.some((r) => r.outcome === 'MATCHED'),
  'the evaluation does not report the rules considered, matched and rejected');

const report = () => {
  console.error(`verify:authority-runtime — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
  process.exit(1);
};
// Without the requirement there is nothing further to prove; say so rather than crash.
if (required.length !== 1) report();

// 2. approval → APPROVED, result kept apart
const pending = unwrap(await authority.getGovernanceState(scope, canonical.commitment.id), 'pending');
check('state', pending.state === 'PENDING_APPROVAL' && pending.approvalProgress === 'PENDING', `before approval the state is ${pending.state}`);
const act = unwrap(await authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'Approved within Country GM authority.' }), 'approve');
check('approval', act.approverUserId === USERS.countryGM && act.basis.kind === 'ROLE_OCCUPANCY', 'the approval is not tied to the approver\'s identity and seat');
const approved = unwrap(await authority.getGovernanceState(scope, canonical.commitment.id), 'approved');
check('state', approved.state === 'APPROVED', `after approval the state is ${approved.state}`);
check('state', approved.policyResult === 'REQUIRES_APPROVAL', 'the policy result was overwritten by the workflow progress');

// 3. commitment untouched
const after = JSON.stringify(unwrap(await stack.decisionStore.getCommitment(scope, canonical.commitment.id), 'commitment after'));
check('commitment', before === after, 'the commitment changed during evaluation or approval');
check('commitment', JSON.parse(after).authorityStatus === 'NOT_EVALUATED', 'the commitment itself carries an authority verdict');

// 4. direct authorization
const small = await stack.commitProof('call-off', 'Q1 call-off');
const direct = unwrap(await authority.evaluate(scope, small.commitment.id), 'small');
check('direct', direct.evaluation.result === 'AUTHORIZED' && direct.required.length === 0, `the smaller commitment is ${direct.evaluation.result}`);
check('direct', direct.evaluation.rules.find((r) => r.deciding)?.ruleKey === deciding?.ruleKey, 'the same rule did not decide both — the difference is not the consequences');

// 5. INDETERMINATE when governance data is missing
{
  const cd = stack.as(USERS.commercialDirector);
  const { buildProofDecision } = await import('@helm/authority-runtime');
  const d = unwrap(
    await buildProofDecision(stack.decisions, cd, {
      title: 'Unclassified',
      managementQuestion: 'How should Meridian place an unclassified allocation?',
      scenarioId: stack.scenarioIds['call-off'],
      alternativeLabel: 'Serve from replenishment',
      committedByLabel: 'Commercial Director Vietnam',
    }),
    'unclassified',
  );
  const e = unwrap(await authority.evaluate(scope, d.commitment.id), 'unclassified evaluation').evaluation;
  check('indeterminate', e.result === 'INDETERMINATE' && e.gaps.some((g) => g.code === 'DECISION_TYPE_UNMAPPED'), 'an unclassified decision was not INDETERMINATE');
  check('indeterminate', e.governability === 'NOT_GOVERNABLE', 'an INDETERMINATE evaluation claims to be governable');
}

// 6. reconsideration: new fingerprint, nothing carries over
{
  const cd = stack.as(USERS.commercialDirector);
  const r2 = unwrap(await stack.decisions.reconsider(cd, small.decision.id, { reason: 'Rohto moved the call-off window.' }), 'reconsider');
  const ws = unwrap(await stack.decisions.getWorkspace(cd, small.decision.id, r2.id), 'workspace');
  const alt = ws.alternatives.find((a) => a.status === 'MODELLED');
  const f2 = unwrap(
    await stack.decisions.commit(cd, r2.id, {
      chosenAlternativeId: alt.id,
      authorship: 'MANAGEMENT_AUTHORED_DEMO',
      committedByLabel: 'Commercial Director Vietnam',
      summary: 'Recommitted.',
      rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Moved', statement: 'The window moved; the choice did not.' }],
      acceptedTradeOffs: [],
      expectedOutcomes: [{ label: 'Cash impact', kind: 'MODELLED', metricKey: 'CashImpact', subjectHint: 'Rohto' }],
    }),
    'F2',
  ).commitment;
  check('fingerprint', f2.fingerprint !== small.commitment.fingerprint, 'reconsidering did not produce a new fingerprint');
  const s2 = unwrap(await authority.getGovernanceState(scope, f2.id), 'F2 state');
  check('fingerprint', s2.state === 'NOT_EVALUATED', `F2 starts ${s2.state}: F1's AUTHORIZED evaluation carried over`);
}

// 7. immutability and supersession
{
  const again = unwrap(await authority.evaluate(scope, canonical.commitment.id), 'again');
  check('immutable', again.evaluation.supersedesEvaluationId === evaluation.id, 'a re-evaluation does not say what it supersedes');
  const first = unwrap(await stack.authorityStore.getEvaluation(scope, evaluation.id), 'first');
  let frozen = false;
  try {
    first.result = 'AUTHORIZED';
  } catch {
    frozen = true;
  }
  check('immutable', frozen && first.result === 'REQUIRES_APPROVAL', 'a recorded evaluation can be changed in place');
  const stale = expectFail(await authority.recordApproval(stack.as(USERS.countryGM), required[0].id, { comments: 'again' }), 'stale');
  check('immutable', stale.code === 'authority.superseded_evaluation' || stale.code === 'authority.already_acted', 'an act was accepted against a superseded evaluation');
}

// 8. no ranking, no AI (structural)
{
  const text = JSON.stringify([evaluation, direct.evaluation]).toLowerCase();
  for (const word of ['score', 'rank', 'recommend', 'best option']) {
    check('no-ranking', !text.includes(`"${word}`) && !new RegExp(`\\b${word}\\w*"\\s*:`).test(text), `an evaluation carries a "${word}" field`);
  }
}

if (failures.length === 0) {
  console.log(
    'verify:authority-runtime — ok (Rohto: REQUIRES_APPROVAL → Country GM → APPROVED with the commitment byte-identical; ' +
      'call-off AUTHORIZED under the same rule; unknown data INDETERMINATE; a new fingerprint starts unevaluated)',
  );
  process.exit(0);
}
report();
