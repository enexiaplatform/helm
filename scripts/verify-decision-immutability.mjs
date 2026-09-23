/**
 * verify:decision-immutability — a commitment is what management decided, and
 * it stays that way.
 *
 * Proves, by attempting each one:
 *   1. After a commitment, nothing about the committed revision can change —
 *      not the chosen alternative, not a criterion, not an assumption, not the
 *      rationale, not the framing of the question itself.
 *   2. The frozen evidence manifest never grows and never shifts, however much
 *      the world moves on: a re-simulation, a rebase and new evidence all
 *      leave it alone.
 *   3. Evidence recorded AFTER a commitment is still recorded, and is shown
 *      separately rather than folded in.
 *   4. Reconsidering produces a NEW revision; the old commitment is untouched.
 *   5. An assumption's OUTCOME can still be learned — the one thing the record
 *      is supposed to gain afterwards — and nothing else about it can move.
 *
 * Every refusal here is also enforced by the database (see
 * verify:decision-schema and the Phase 5 server-side proof); this contract
 * checks the runtime a client actually goes through.
 */

import { buildMeridianDecision } from '@helm/decision-runtime';
import { buildDecisionStack, unwrap } from './lib/decisionStack.mjs';

const failures = [];
const check = (rule, cond, detail) => {
  if (!cond) failures.push({ rule, detail });
};
const refuses = async (rule, what, expectedCode, fn) => {
  const r = await fn();
  if (r.ok) {
    failures.push({ rule, detail: `${what} was allowed` });
    return;
  }
  check(rule, r.error.code === expectedCode, `${what}: expected ${expectedCode}, got ${r.error.code}`);
};

const stack = await buildDecisionStack();
const { scope, decisions, scenarios, clock } = stack;
const built = unwrap(await buildMeridianDecision(decisions, scope, stack.scenarioIds), 'canonical decision');
const { revisionId, decision, alternatives, commitment } = built;
const before = unwrap(await decisions.getCommitmentSnapshot(scope, commitment.id), 'snapshot');

// ---- 1. the committed basis is frozen
await refuses('frozen', 'rebinding the chosen alternative', 'decision.revision_sealed', () =>
  decisions.bindScenario(scope, alternatives['reallocate'].id, stack.scenarioIds['expedite']),
);
await refuses('frozen', 'adding an alternative after the commitment', 'decision.revision_sealed', () =>
  decisions.addAlternative(scope, revisionId, { label: 'F — an afterthought' }),
);
await refuses('frozen', 'withdrawing an alternative after the commitment', 'decision.revision_sealed', () =>
  decisions.withdrawAlternative(scope, alternatives['delay'].id, 'on reflection'),
);
await refuses('frozen', 'adding a criterion after the commitment', 'decision.revision_sealed', () =>
  decisions.addCriterion(scope, revisionId, {
    key: 'hindsight',
    name: 'Hindsight',
    style: 'PREFERENCE',
    metricKey: 'CashImpact',
    author: { kind: 'ROLE', label: 'Someone', userId: null },
    rationale: 'Thought of it afterwards.',
  }),
);
await refuses('frozen', 'adding an assumption after the commitment', 'decision.revision_sealed', () =>
  decisions.addAssumption(scope, revisionId, { statement: 'Something we believed all along.' }),
);
await refuses('frozen', 'raising a challenge after the commitment', 'decision.revision_sealed', () =>
  decisions.challenge(scope, revisionId, {
    targetKind: 'CONTEXT',
    author: { kind: 'ROLE', label: 'Someone', userId: null },
    concern: 'A concern raised after the decision was taken.',
  }),
);
await refuses('frozen', 'assessing a criterion after the commitment', 'decision.revision_sealed', () =>
  decisions.recordAssessment(scope, {
    criterionId: built.criteria['inventory-optionality'].id,
    alternativeId: alternatives['expedite'].id,
    rating: 'SUPPORT',
    rationale: 'A rating recorded after the decision was taken.',
    author: { kind: 'ROLE', label: 'Someone', userId: null },
  }),
);
await refuses('frozen', 'committing the same revision twice', 'decision.revision_sealed', () =>
  decisions.commit(scope, revisionId, {
    chosenAlternativeId: alternatives['expedite'].id,
    authorship: 'MANAGEMENT_AUTHORED',
    committedByLabel: 'Someone else',
    summary: 'Actually, expedite.',
    rationale: [{ kind: 'JUDGEMENT', ref: null, label: 'Changed mind', statement: 'On reflection.' }],
    acceptedTradeOffs: [],
  }),
);
await refuses('frozen', 'rewriting the question a committed decision answered', 'decision.commitment_immutable', () =>
  decisions.updateFraming(scope, decision.id, { managementQuestion: 'A different question, asked afterwards.' }),
);

// ---- 2. the manifest survives the world moving on
{
  unwrap(await scenarios.execute(scope, stack.scenarioIds['reallocate']), 're-simulate');
  clock.jump(4 * 24 * 3600 * 1000);
  unwrap(await scenarios.rebase(scope, stack.scenarioIds['reallocate']), 'rebase');
  unwrap(
    await decisions.addEvidence(scope, revisionId, {
      kind: 'MARKET_SIGNAL',
      title: 'Something learned four days later',
      relation: 'CHALLENGE',
      targetKind: 'CONTEXT',
      sourceSystem: 'market',
    }),
    'later evidence',
  );
  const after = unwrap(await decisions.getCommitmentSnapshot(scope, commitment.id), 'snapshot again');
  check('manifest', JSON.stringify(after) === JSON.stringify(before), 'the frozen evidence manifest changed');
  check('manifest', after.fingerprint === before.fingerprint, 'the manifest fingerprint moved');
  check('manifest', after.evidenceIds.length === before.evidenceIds.length, 'the manifest gained evidence it never saw');

  // And the exact future state management committed against is still readable.
  const chosen = after.alternatives.find((a) => a.chosen);
  const state = unwrap(await scenarios.getFutureState(scope, chosen.scenarioRunId), 'committed future');
  check('manifest', state.run.fingerprint === chosen.scenarioFingerprint,
    'the committed simulation no longer matches the fingerprint the manifest recorded');
  const gm = state.values.find((v) => v.metricKey === 'GrossMarginPct' && v.nodeLabel.includes('Rohto'));
  check('manifest', gm?.value === '32.3878', `the committed future state changed: gross margin is now ${gm?.value}`);
}

// ---- 3. new evidence is recorded, and kept separate
{
  const explained = unwrap(await decisions.explainDecision(scope, decision.id), 'explain');
  check('freshness', explained.evidenceAfterCommitment.length === 1,
    `expected exactly one piece of evidence after the commitment, found ${explained.evidenceAfterCommitment.length}`);
  check('freshness', !explained.evidence.some((e) => e.title.includes('four days later')),
    'evidence recorded after the commitment was folded into the committed set');
}

// ---- 4. reconsideration is a new revision, not an edit
{
  const r2 = unwrap(
    await decisions.reconsider(scope, decision.id, {
      reason: 'Supplier A notified a delay and Finance filed a new forecast.',
      rebaseScenarios: true,
    }),
    'reconsider',
  );
  check('reconsider', r2.revisionNumber === 2 && r2.reason === 'RECONSIDERED', 'reconsidering did not open a new revision');
  check('reconsider', r2.reconsidersCommitmentId === commitment.id, 'the new revision does not link back to what it reconsiders');
  check('reconsider', new Date(r2.fork.recordedThrough) > new Date(before.fork.recordedThrough),
    'the reconsidered revision does not move the knowledge boundary forward');

  const ws = unwrap(await decisions.getWorkspace(scope, decision.id, r2.id), 'reconsidered workspace');
  check('reconsider', ws.alternatives.every((a) => a.status !== 'MODELLED'),
    'a rebased alternative claims a future state nobody has simulated');
  check('reconsider', ws.alternatives.some((a) => /not yet simulated/.test(a.unmodelledReason ?? '')),
    'a rebased alternative does not say that its future has not been recomputed');
  check('reconsider', ws.criteria.length === 6 && ws.assumptions.length === 5,
    'the reconsidered revision did not carry the framing forward');

  const still = unwrap(await decisions.getCommitmentSnapshot(scope, commitment.id), 'snapshot after reconsideration');
  check('reconsider', JSON.stringify(still) === JSON.stringify(before), 'reconsidering changed the original commitment');
}

// ---- 5. the outcome IS learnable afterwards, and only the outcome
{
  const review = unwrap(
    await decisions.recordOutcomeReview(scope, commitment.id, {
      reviewedByLabel: 'Finance Director Vietnam',
      actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: '31.7' }],
      assumptionResults: [
        { assumptionId: built.assumptions['tender-material'].id, outcome: 'DISPROVED', note: 'Postponed to Q1.' },
      ],
    }),
    'outcome review',
  );
  check('outcome', review.variances[0].expected === '32.3878' && review.variances[0].variance === '-0.6878',
    'the variance was not computed against what was actually expected');
  check('outcome', !/quality|good|bad|success|failure/i.test(review.statement) || /not a verdict/i.test(review.statement),
    'the outcome review passes judgement on the decision');

  const ws = unwrap(await decisions.getWorkspace(scope, decision.id, revisionId), 'committed workspace');
  const a = ws.assumptions.find((x) => x.id === built.assumptions['tender-material'].id);
  check('outcome', a?.outcome === 'DISPROVED', 'an assumption outcome could not be recorded after the fact');
  check('outcome', a?.statement === built.assumptions['tender-material'].statement,
    'recording an outcome changed what the assumption said');
  check('outcome', a?.confidence === built.assumptions['tender-material'].confidence,
    'recording an outcome changed the confidence management held at the time');

  const still = unwrap(await decisions.getCommitmentSnapshot(scope, commitment.id), 'snapshot after review');
  check('outcome', still.fingerprint === before.fingerprint, 'the outcome review changed the frozen manifest');
}

// The control: after everything above, the record must still READ. A contract
// that only ever refuses would pass just as well against a store that refuses
// everything.
{
  const readable = await decisions.explainDecision(scope, decision.id);
  check('readable', readable.ok, 'the committed decision became unreadable after all of the above');
  check('readable', readable.ok && readable.value.chosen.label.includes('Reallocate'),
    'the committed decision no longer names what management chose');
}

if (failures.length === 0) {
  console.log(
    'verify:decision-immutability — ok (9 edits after commitment refused, manifest frozen through re-simulation, rebase and new evidence, ' +
      'reconsideration opens a new revision, only the outcome is learnable)',
  );
  process.exit(0);
}
console.error(`verify:decision-immutability — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
