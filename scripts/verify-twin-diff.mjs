/**
 * verify:twin-diff — comparison, trajectory and attention.
 *
 *   1. S0 → S1a → S1: Open → Committed → Approved are DECISION and GOVERNANCE
 *      changes; committing moves no value and no structure.
 *   2. S1 → S2: the reclassification and the change of Commercial Director are
 *      STRUCTURAL changes, apart from every value change; DOA v1 → v2 is a
 *      GOVERNANCE change that leaves the evaluation made under v1 untouched.
 *   3. CF1 → S2 is EXPECTED_VS_ACTUAL: gross margin 32.3878 committed, 31.7
 *      actual, −0.6878 pts, beyond the stated materiality line; S1 → CF1 is
 *      DISTANCE_TO_INTENT, not a variance.
 *   4. Attention is conditions from named rules, each with its cause, never a
 *      score or a rank; comparisons add deterioration as a named condition.
 *   5. Nothing states a verdict on the decision or a causal claim.
 */

import { buildStory, contract, itemsOf, unwrap } from './lib/twinStack.mjs';

const { check, finish } = contract('verify:twin-diff');
const s = await buildStory();
const { story } = s;
const diff = async (a, b) => unwrap(await s.twin.compareSnapshots(s.scope, story[a].snapshot.id, story[b].snapshot.id), `${a}→${b}`);

// 1
const a = await diff('S0', 'S1a');
check('decision', a.decisionChanges.some((c) => c.kind === 'DECISION' && c.fields.some((f) => f.field === 'state' && f.before === 'READY_FOR_DECISION' && f.after === 'COMMITTED')), 'Open → Committed is not a decision change');
check('decision', a.decisionChanges.some((c) => c.kind === 'COMMITMENT' && c.change === 'ADDED'), 'the commitment did not appear as a decision change');
check('decision', a.structuralChanges.length === 0, 'committing registered as a structural change');
check('decision', a.valueChanges.filter((c) => c.after?.layer !== 'COMMITTED_FUTURE').length === 0, 'committing moved an actual or model value');
const b = await diff('S1a', 'S1');
check('governance', b.governanceChanges.some((c) => c.kind === 'GOVERNANCE' && c.fields.some((f) => f.field === 'state' && f.before === 'PENDING_APPROVAL' && f.after === 'APPROVED')), 'Committed → Approved is not a governance change');

// 2
const c = await diff('S1', 'S2');
check('structure', c.structuralChanges.some((x) => x.kind === 'ENTITY' && x.fields.some((f) => f.field === 'classification' && f.before === 'KEY_ACCOUNT' && f.after === 'STRATEGIC_ACCOUNT')), 'the reclassification is not a structural change');
check('structure', c.structuralChanges.some((x) => x.kind === 'ROLE_OCCUPANCY' && x.fields.some((f) => f.field === 'personLabel' && f.after === 'Hoang Thu Trang')), 'the new role holder is not a structural change');
check('structure', c.structuralChanges.every((x) => ['ENTITY', 'RELATIONSHIP', 'ROLE_OCCUPANCY'].includes(x.kind)), 'a non-structural item was filed as structural');
check('structure', c.valueChanges.every((x) => x.kind === 'VALUE' || x.kind === 'OBJECTIVE'), 'a structural change was filed as a value change');
const policy = c.governanceChanges.find((x) => x.kind === 'POLICY');
check('governance', policy?.fields.some((f) => f.field === 'version' && f.before === 1 && f.after === 2), 'DOA v1 → v2 is not a governance change');
check('governance', !c.governanceChanges.some((x) => x.kind === 'GOVERNANCE'), 'the historical evaluation changed when the policy did');
check('governance', JSON.stringify(itemsOf(story.S2, 'GOVERNANCE')[0]?.state.policies) === '["DOA-2026-04 v1"]', 'the S2 verdict no longer names the policy it was made under');

// 3
const t = unwrap(await s.twin.getTrajectory(s.scope, story.S2.snapshot.id, story.CF1.snapshot.id), 'trajectory');
const gm = t.lines.find((l) => l.metricKey === 'GrossMarginPct');
check('trajectory', t.relation === 'EXPECTED_VS_ACTUAL', `after Q4 the relation is ${t.relation}`);
check('trajectory', gm?.committed === '32.3878' && gm?.current === '31.7' && gm?.difference === '-0.6878' && gm?.differenceUnit === ' pts', `margin: ${gm?.committed} → ${gm?.current} (${gm?.difference}${gm?.differenceUnit})`);
check('trajectory', gm?.currentLayer === 'ACTUAL' && gm?.beyondMateriality === true, 'the actual is not Finance\'s, or materiality is not stated');
const early = unwrap(await s.twin.getTrajectory(s.scope, story.S1.snapshot.id, story.CF1.snapshot.id), 'early trajectory');
check('trajectory', early.relation === 'DISTANCE_TO_INTENT' && /not a variance/.test(early.statement), 'before the period ends the gap is called a variance');
check('trajectory', early.unresolved.some((u) => /action intent/.test(u.why)), 'what still stands between now and the committed future is not listed');

// 4
const attention = itemsOf(story.S2, 'ATTENTION');
check('attention', attention.some((x) => x.state.condition === 'COMMITTED_FUTURE_OFF_TRACK'), 'S2 does not raise the committed future off track');
check('attention', itemsOf(story.S0, 'ATTENTION').some((x) => x.state.condition === 'CONSTRAINT_BREACHED'), 'S0 does not raise the inventory constraint');
check('attention', itemsOf(story.S1a, 'ATTENTION').some((x) => x.state.condition === 'APPROVAL_PENDING'), 'S1a does not raise the pending approval');
check('attention', attention.some((x) => x.state.condition === 'CRITICAL_ASSUMPTION_DISPROVED'), 'S2 does not raise the disproved assumption');
for (const snap of [story.S0, story.S1a, story.S2]) {
  for (const x of itemsOf(snap, 'ATTENTION')) {
    check('attention', typeof x.state.rule === 'string' && x.state.rule.includes('@') && x.state.causeItemKeys.length > 0, `attention "${x.label}" has no named rule or cause`);
    check('attention', !['score', 'priority', 'rank', 'weight'].some((k) => k in x.state), `attention "${x.label}" carries a score`);
  }
}
check('attention', c.deltaAttention.some((x) => x.condition === 'MATERIAL_VALUE_DETERIORATION' && /helm-demo-materiality@1/.test(x.rule)), 'the comparison does not name the deterioration and its line');

// 5
const words = JSON.stringify([c.statement, t.statement, early.statement, attention.map((x) => x.state.statement)]);
check('language', !/\b(good|bad|wrong|correct|should have|caused)\b/i.test(words), 'a comparison states a verdict or a cause');
check('language', /not a verdict on the decision/.test(t.statement), 'expected-vs-actual does not say it is not a verdict');

finish('Open → Committed → Approved; structure apart from value; v1 → v2 without rewriting; −0.6878 pts expected vs actual; attention named, never scored');
