/**
 * verify:review-runtime — the canonical two-review proof, and the rules a review keeps.
 *
 *   Review 1 (the issue appears): opens with the twin BEFORE the decision, prepared from the kernel; records that
 *     management framed and committed BY REFERENCE; closes with the state after governance; nothing left hanging.
 *   Review 2 (the outcome has arrived): follows Review 1, inherits what it left open — the same objects, not copies —
 *     is prepared with what changed since Review 1's CLOSING state, and shows expected against actual, the disproved
 *     assumption, the episode, the pattern, the counterfactual, without a verdict.
 *   A review binds and never decides; a question is the one thing it owns; a closed review is memory; nothing in it
 *     is ranked, scored, weighted or totalled; a missing source is said out loud.
 */

import { computePack } from '../packages/review-runtime/src/index.ts';
import { buildReviewStack, buildReviewStory, contract, expectFail, unwrap } from './lib/v1Stack.mjs';
import { buildStory } from '../packages/twin-runtime/test/harness.mjs';

const c = contract('verify:review-runtime');
const s = await buildReviewStory();
const r1 = s.reviewStory.first;
const r2 = s.reviewStory.second;

// Review 1.
const commitment = unwrap(await s.decisionStore.getCommitment(s.scope, s.story.commitmentId), 'commitment');
c.check('r1-opening', Date.parse(r1.review.openingLens.recordedThrough) < Date.parse(commitment.committedAt), 'Review 1 did not open before the commitment existed');
const pack1 = unwrap(await s.review.prepare(s.gm, r1.review.id), 'pack 1');
c.check('r1-prepared', pack1.attention.items.some((a) => /inventory|own stock/i.test(a.statement)) && pack1.decisionsNeeded.items.some((d) => d.decisionId === s.story.decisionId), 'Review 1 was not prepared from the kernel with the inventory breach and the decision it needs');
c.check('r1-first', pack1.since === null && /first review/.test(pack1.changed.statement), 'the first review measured change from something');
c.check('r1-lens', pack1.learning.episodes.items.length === 0 && pack1.learning.counterfactuals.items.length === 0 && pack1.causalChanges.items.length === 0, 'Review 1 shows learning that did not exist yet at its lens');
const framed = r1.items.find((i) => i.kind === 'DECISION');
const committed = r1.items.find((i) => i.kind === 'COMMITMENT');
c.check('r1-by-reference', framed?.role === 'FRAMED' && framed.ref.id === s.story.decisionId && committed?.role === 'COMMITTED' && committed.ref.id === s.story.commitmentId, 'Review 1 does not record the framing and the commitment by reference');
c.check('r1-closing', r1.status === 'CLOSED' && r1.changeDuringReview.counts.decision + r1.changeDuringReview.counts.governance >= 1, 'Review 1 did not close with what changed during it');
c.check('nothing-hanging', r1.closure.dispositions.length === r1.items.length && r1.closure.dispositions.every((d) => d.reason.length > 0), 'Review 1 left an item without a disposition or a reason');

// Review 2.
const carriedFrom = r1.closure.dispositions.filter((d) => d.disposition === 'CARRIED_FORWARD').map((d) => d.itemId);
const carried = r2.items.filter((i) => i.carriedFromItemId);
c.check('carry-forward', r2.review.previousReviewId === r1.review.id && JSON.stringify(carried.map((i) => i.carriedFromItemId).sort()) === JSON.stringify([...carriedFrom].sort()), 'Review 2 does not inherit exactly what Review 1 carried forward');
c.check('carry-forward', carried.every((i) => JSON.stringify(i.ref) === JSON.stringify(r1.items.find((x) => x.id === i.carriedFromItemId).ref)), 'a carried-forward item is a copy, not a reference to the same object');
const pack2 = unwrap(await s.review.prepare(s.gm, r2.review.id), 'pack 2');
c.check('since', pack2.changed.fromSnapshotId === r1.closure.closingSnapshotId && pack2.changed.toSnapshotId === r2.review.openingSnapshotId && JSON.stringify(pack2.since) === JSON.stringify(r1.closure.closingLens), 'Review 2 was not prepared with what changed since the previous review\'s CLOSING state');
const off = pack2.commitmentsOffTrack.items.find((o) => o.commitmentId === s.story.commitmentId);
const gm = off?.lines.find((l) => /Gross Margin %/.test(l.label));
c.check('expected-vs-actual', gm?.committed === '32.3878' && gm.current === '31.7' && gm.difference === '-0.6878', 'the commitment is not shown off-track as committed 32.3878 against current 31.7');
c.check('no-verdict', !/good decision|bad decision|mistake|regret/i.test(JSON.stringify(pack2)), 'the pack passes a verdict on the decision');
c.check('learning', pack2.learning.episodes.items.some((e) => e.id === s.genomeStory.episodes.E1.episode.id) && pack2.learning.patterns.items.length >= 1 && pack2.learning.counterfactuals.items.some((x) => x.id === s.counterfactualStory.cases.CF1.case.id) && pack2.causalChanges.items.length >= 1 && pack2.assumptionsChanged.items.some((a) => a.outcome === 'DISPROVED'), 'Review 2 does not bring the episode, pattern, counterfactual, causal beliefs and the disproved assumption');
c.check('nothing-unavailable', pack2.unavailable.length === 0, 'Review 2 was prepared with a source missing');
c.check('question-carried-on', r2.closure.dispositions.filter((d) => d.disposition === 'CARRIED_FORWARD').length === 1 && /buffer stock/.test(r2.items.find((i) => i.id === r2.closure.dispositions.find((d) => d.disposition === 'CARRIED_FORWARD').itemId).note), 'Review 2 did not carry its open question on');

// A closed review stays what management saw.
const stored = [];
for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) {
  const rr = unwrap(await s.review.reproduce(s.gm, v.review.id, which), `${which}`);
  c.check('reproducible', rr.identical === true && /later data has not rewritten it/.test(rr.statement), `${which} of ${v.review.periodLabel} is not reproduced identically`);
  stored.push(rr.storedFingerprint);
}
s.clock.jumpTo('2027-05-20T02:00:00.000Z');
unwrap(await s.decisionsRuntime.recordOutcomeReview(s.scope, s.story.commitmentId, { reviewedByLabel: 'late', actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: '20.0000' }], notes: 'A terrible outcome recorded long after the reviews closed.' }), 'late outcome');
unwrap(await s.decisionsRuntime.createDecision(s.scope, { title: 'A decision opened after both reviews', managementQuestion: 'Was this here at Review 2?', triggerType: 'ISSUE' }), 'late decision');
const after = [];
for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) {
  const rr = unwrap(await s.review.reproduce(s.gm, v.review.id, which), 'after');
  c.check('later-data-cannot-rewrite', rr.identical === true, `${which} of ${v.review.periodLabel} was rewritten by later data`);
  after.push(rr.storedFingerprint);
}
c.check('later-data-cannot-rewrite', JSON.stringify(after) === JSON.stringify(stored), 'a stored fingerprint moved');
const early = unwrap(await s.review.getReview(s.gm, r1.review.id, { effectiveAsOf: r1.closure.closingLens.recordedThrough, recordedThrough: new Date(Date.parse(r1.closure.recordedAt) - 1).toISOString() }), 'before close');
c.check('lens', early.status === 'OPEN' && early.closure === null, 'read before it closed, a review is not OPEN');
const unknown = await s.review.getReview(s.gm, r1.review.id, { effectiveAsOf: '2026-01-01T00:00:00.000Z', recordedThrough: '2026-01-01T00:00:00.000Z' });
c.check('lens', unknown.ok === false && unknown.error.code === 'review.not_known_at_lens', 'a review is known before it opened');

// Integrity.
const vn = s.story.scopes.vietnam;
const open = (over = {}) => s.review.openReview(s.gm, { title: 'A review', cadence: 'MONTHLY', periodLabel: '2027-05', scope: vn, periods: ['2026-Q4'], grantedUnitIds: ['unit-vn'], openedByLabel: 'test', ...over });
const a = unwrap(await open(), 'first');
c.check('one-open', expectFail(await open({ periodLabel: '2027-06' }), 'second').code === 'review.already_open', 'a second review of the same scope and cadence opened while one was open');
const q = unwrap(await s.review.addItem(s.gm, a.review.id, { kind: 'QUESTION', note: 'What did the month teach us?' }), 'question');
c.check('question-is-content', expectFail(await s.review.addItem(s.gm, a.review.id, { kind: 'QUESTION', note: 'why?' }), 'short').code === 'review.invalid_input' && expectFail(await s.review.addItem(s.gm, a.review.id, { kind: 'DECISION' }), 'no ref').code === 'review.invalid_input', 'an item can hold something other than a reference or a sentence');
c.check('bad-reference', expectFail(await s.review.addItem(s.gm, a.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: 'nope', label: 'x' } }), 'unknown').code === 'review.bad_reference', 'a reference to nothing was accepted');
const current = unwrap(await s.review.getReview(s.gm, a.review.id), 'view');
c.check('nothing-hanging', expectFail(await s.review.closeReview(s.gm, a.review.id, { summary: 'x', dispositions: [], closedByLabel: 't' }), 'hanging').code === 'review.items_without_disposition', 'a review closed with an item left hanging');
c.check('reason', expectFail(await s.review.closeReview(s.gm, a.review.id, { summary: 'x', dispositions: current.items.map((i) => ({ itemId: i.id, disposition: 'RESOLVED', reason: i.id === q.id ? '' : 'ok' })), closedByLabel: 't' }), 'no reason').code === 'review.invalid_input', 'a disposition without a reason was accepted');
unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Done.', dispositions: current.items.map((i) => ({ itemId: i.id, disposition: 'DROPPED', reason: 'Not pursued.' })), closedByLabel: 't' }), 'close');
c.check('closed-is-memory', expectFail(await s.review.addItem(s.gm, a.review.id, { kind: 'QUESTION', note: 'Anything else at all?' }), 'late').code === 'review.closed' && expectFail(await s.review.closeReview(s.gm, a.review.id, { summary: 'again', dispositions: [], closedByLabel: 't' }), 'twice').code === 'review.closed', 'a closed review took another item or closed twice');
const openStrategic = unwrap(await open({ cadence: 'STRATEGIC', periodLabel: '2027-S1' }), 'strategic');
c.check('chain', expectFail(await open({ cadence: 'WEEKLY', periodLabel: '2027-W22', previousReviewId: openStrategic.review.id }), 'follows an open review').code === 'review.previous_not_closed', 'a review followed one that was still open');

// A review binds; it never decides.
const state = async () => JSON.stringify(unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions').map((d) => d.id + d.state));
const beforeState = await state();
unwrap(await s.review.addItem(s.gm, openStrategic.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: s.story.decisionId, label: 'x' }, role: 'RECONSIDERED', note: 'Management asks whether to reconsider.' }), 'reconsidered');
c.check('binds-not-decides', (await state()) === beforeState, 'adding an item to a review changed a decision');
c.check('role-fits', expectFail(await s.review.addItem(s.gm, openStrategic.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: s.story.decisionId, label: 'x' }, role: 'COMMITTED' }), 'committed decision').code === 'review.invalid_input', 'a decision was recorded as committed by a review');

// No ranking, no score.
const FORBIDDEN = /^(score|rank|ranking|priority|importance|weight|rating|health)$/i;
const bad = (o, path = '', acc = []) => {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.test(k)) acc.push(`${path}.${k}`); bad(v, `${path}.${k}`, acc); }
  return acc;
};
c.check('no-ranking', bad(pack2).length === 0 && bad(r2).length === 0 && /nothing is ranked, weighted or totalled/.test(pack2.statement), 'a review carries a score, rank, priority or weight');
c.check('no-minutes', Object.keys(r2.review).every((k) => !/minutes|agenda|notes|attendees|actions/i.test(k)), 'a review keeps minutes, an agenda or attendees of its own');
for (const m of Object.keys(s.review)) c.check('no-person-view', !/byPerson|byManager|byAuthor|byOwner|byAttendee|leaderboard|performance|rank/i.test(m), `the review runtime offers ${m}`);

// A missing source is said out loud.
const bare = await buildStory({ stack: await buildReviewStack() });
const opening = unwrap(await bare.twin.buildSnapshot(bare.scope, { kind: 'CURRENT', label: 'x', scope: bare.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: ['unit-vn'] }), 'snapshot');
const barePack = await computePack(bare.reviewSources, bare.scope, { lens: opening.snapshot.spec.lens, since: null, previousReviewId: null, snapshotId: opening.snapshot.id, previousClosingSnapshotId: null });
c.check('unavailable', ['genome', 'counterfactual', 'causal'].every((w) => barePack.unavailable.some((u) => u.includes(w))), 'a pack with no genome, counterfactual or causal source did not list each as unavailable');

c.finish('Review 1 lived inside the twin story; Review 2 inherits by reference, measured since Review 1 closed; expected against actual without a verdict; closed reviews reproduce identically after later data; a review binds and never decides; nothing ranked; missing sources named');
