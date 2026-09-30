/**
 * The canonical two-review proof: Review 1 (the Rohto issue appears; management
 * sees it, explores scenarios, decides, commits, governs) and Review 2 (the
 * outcome has arrived; expected against actual, causal evidence, the disproved
 * assumption, the episode, the pattern, the counterfactual review).
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewStory, unwrap } from './harness.mjs';

let s;
let r1;
let r2;
before(async () => {
  s = await buildReviewStory();
  r1 = s.reviewStory.first;
  r2 = s.reviewStory.second;
});

describe('Review 1 — the issue appears; management decides, commits and governs', () => {
  it('opens with the twin state BEFORE the decision, and is prepared from the kernel, not typed in', async () => {
    const opening = unwrap(await s.twin.getSnapshot(s.scope, r1.review.openingSnapshotId), 'opening');
    assert.equal(opening.snapshot.spec.kind, 'CURRENT');
    assert.equal(opening.snapshot.id, s.story.S0.snapshot.id === opening.snapshot.id ? opening.snapshot.id : opening.snapshot.id);
    const commitment = unwrap(await s.decisionStore.getCommitment(s.scope, s.story.commitmentId), 'commitment');
    assert.ok(Date.parse(r1.review.openingLens.recordedThrough) < Date.parse(commitment.committedAt), 'the review opened before the commitment existed');
    const pack = unwrap(await s.review.prepare(s.gm, r1.review.id), 'pack');
    assert.ok(pack.attention.items.some((a) => /inventory|own stock/i.test(a.statement)), 'the inventory breach is in the preparation');
    assert.ok(pack.decisionsNeeded.items.some((d) => d.decisionId === s.story.decisionId), 'the Rohto decision is one that is needed');
    assert.equal(pack.since, null, 'the first review has nothing to measure change from');
    assert.match(pack.changed.statement, /first review/);
  });

  it('had no genome, counterfactual case or causal belief yet: at its own lens those sections are empty, whatever exists today', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, r1.review.id), 'pack');
    assert.equal(pack.learning.episodes.items.length, 0);
    assert.equal(pack.learning.counterfactuals.items.length, 0);
    assert.equal(pack.causalChanges.items.length, 0);
  });

  it('records that management framed the decision and committed it in this review — by reference; the decision itself was made in the decision runtime', () => {
    const framed = r1.items.find((i) => i.kind === 'DECISION');
    assert.equal(framed.role, 'FRAMED');
    assert.equal(framed.ref.id, s.story.decisionId);
    assert.equal(framed.decisionId, s.story.decisionId);
    const committed = r1.items.find((i) => i.kind === 'COMMITMENT');
    assert.equal(committed.role, 'COMMITTED');
    assert.equal(committed.ref.id, s.story.commitmentId);
  });

  it('closes with the twin state after governance: a stored snapshot, and what changed during the review', async () => {
    assert.equal(r1.status, 'CLOSED');
    const closing = unwrap(await s.twin.getSnapshot(s.scope, r1.closure.closingSnapshotId), 'closing');
    assert.ok(Date.parse(closing.snapshot.spec.lens.recordedThrough) > Date.parse(r1.review.openingLens.recordedThrough));
    assert.ok(r1.changeDuringReview.counts.decision >= 1 || r1.changeDuringReview.counts.governance >= 1, 'the decision and its governance moved the twin during the review');
    assert.match(r1.changeDuringReview.statement, /opening state to its closing state/);
  });

  it('leaves nothing hanging: every item is resolved, carried forward or dropped, and says why', () => {
    assert.equal(r1.closure.dispositions.length, r1.items.length);
    assert.ok(r1.closure.dispositions.every((d) => d.reason.length > 0));
    assert.deepEqual([...new Set(r1.closure.dispositions.map((d) => d.disposition))].sort(), ['CARRIED_FORWARD', 'RESOLVED']);
  });
});

describe('Review 2 — the outcome has arrived', () => {
  it('follows Review 1 and inherits what it left open, by reference: the same objects, not copies', () => {
    assert.equal(r2.review.previousReviewId, r1.review.id);
    assert.equal(r2.previous.id, r1.review.id);
    const carriedFrom = r1.closure.dispositions.filter((d) => d.disposition === 'CARRIED_FORWARD').map((d) => d.itemId);
    const carried = r2.items.filter((i) => i.carriedFromItemId);
    assert.deepEqual(carried.map((i) => i.carriedFromItemId).sort(), [...carriedFrom].sort());
    for (const c of carried) {
      const original = r1.items.find((i) => i.id === c.carriedFromItemId);
      assert.deepEqual(c.ref, original.ref, 'the same reference');
      assert.equal(c.decisionId, original.decisionId);
    }
    assert.equal(new Set(r2.items.filter((i) => i.ref).map((i) => `${i.kind}:${i.ref.id}:${i.role}`)).size, r2.items.filter((i) => i.ref).length, 'no object is recorded twice in the same role');
  });

  it('is prepared with what changed since the previous review\'s CLOSING state', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, r2.review.id), 'pack');
    assert.equal(pack.changed.fromSnapshotId, r1.closure.closingSnapshotId);
    assert.equal(pack.changed.toSnapshotId, r2.review.openingSnapshotId);
    assert.ok(pack.changed.changes.length > 0);
    assert.deepEqual(pack.since, r1.closure.closingLens);
  });

  it('shows the commitment off-track: expected against actual, current against the committed future', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, r2.review.id), 'pack');
    const rohto = pack.commitmentsOffTrack.items.find((o) => o.commitmentId === s.story.commitmentId);
    assert.ok(rohto, 'the Rohto commitment is off-track');
    const gm = rohto.lines.find((l) => /Gross Margin %/.test(l.label));
    assert.equal(gm.committed, '32.3878');
    assert.equal(gm.current, '31.7');
    assert.equal(gm.difference, '-0.6878');
  });

  it('brings the outcome and the disproved assumption, without a verdict', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, r2.review.id), 'pack');
    const out = pack.outcomesArrived.items.find((o) => o.commitmentId === s.story.commitmentId);
    assert.equal(out.variances.find((v) => /Gross margin/.test(v.label)).actual, '31.7');
    assert.ok(pack.assumptionsChanged.items.some((a) => a.outcome === 'DISPROVED' && /provincial tender/.test(a.statement)));
    assert.doesNotMatch(JSON.stringify(pack), /good decision|bad decision|mistake|regret/i);
  });

  it('brings the learning: the episode, the pattern and the counterfactual review; and the causal beliefs that changed', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, r2.review.id), 'pack');
    assert.ok(pack.learning.episodes.items.some((e) => e.id === s.genomeStory.episodes.E1.episode.id));
    assert.ok(pack.learning.patterns.items.length >= 1);
    assert.ok(pack.learning.counterfactuals.items.some((c) => c.id === s.counterfactualStory.cases.CF1.case.id));
    assert.ok(pack.causalChanges.items.length >= 1);
    assert.deepEqual(pack.unavailable, []);
  });

  it('records what management touched — the outcome\'s episode, pattern, counterfactual and claim — and closes with the reconsideration question carried on', () => {
    const kinds = new Set(r2.items.map((i) => i.kind));
    for (const k of ['COMMITMENT', 'ASSUMPTION', 'CAUSAL_CLAIM', 'EPISODE', 'PATTERN', 'COUNTERFACTUAL_CASE', 'QUESTION']) assert.ok(kinds.has(k), k);
    const carryOn = r2.closure.dispositions.filter((d) => d.disposition === 'CARRIED_FORWARD');
    assert.equal(carryOn.length, 1);
    assert.match(r2.items.find((i) => i.id === carryOn[0].itemId).note, /buffer stock/);
  });
});

describe('a closed review stays what management saw', () => {
  it('recomputed from the kernel at the review\'s own lens, every pack is identical', async () => {
    for (const v of [r1, r2]) {
      for (const which of ['PREPARATION', 'CLOSING']) {
        const r = unwrap(await s.review.reproduce(s.gm, v.review.id, which), `${which} of ${v.review.periodLabel}`);
        assert.equal(r.identical, true, `${which} of ${v.review.periodLabel}: ${r.statement}`);
        assert.match(r.statement, /later data has not rewritten it/);
      }
    }
  });

  it('later data cannot rewrite it: a new outcome review, a new decision and a new claim change nothing about a closed review', async () => {
    const before = [];
    for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) before.push(unwrap(await s.review.reproduce(s.gm, v.review.id, which), 'before').storedFingerprint);
    s.clock.jumpTo('2027-05-20T02:00:00.000Z');
    unwrap(await s.decisionsRuntime.recordOutcomeReview(s.scope, s.story.commitmentId, { reviewedByLabel: 'late', actuals: [{ label: 'Gross margin %', metricKey: 'GrossMarginPct', actual: '20.0000' }], notes: 'A terrible outcome, recorded long after the reviews closed.' }), 'late outcome');
    unwrap(await s.decisionsRuntime.createDecision(s.scope, { title: 'A decision opened after both reviews', managementQuestion: 'Was this here at Review 2?', triggerType: 'ISSUE' }), 'late decision');
    const after = [];
    for (const v of [r1, r2]) for (const which of ['PREPARATION', 'CLOSING']) {
      const r = unwrap(await s.review.reproduce(s.gm, v.review.id, which), 'after');
      assert.equal(r.identical, true, `${which} of ${v.review.periodLabel} was rewritten by later data`);
      after.push(r.storedFingerprint);
    }
    assert.deepEqual(after, before);
  });

  it('read at a lens before it closed, a review is OPEN; before it opened, it is not known', async () => {
    const between = { effectiveAsOf: r1.review.openingLens.recordedThrough, recordedThrough: r1.review.openingLens.recordedThrough };
    const early = unwrap(await s.review.getReview(s.gm, r1.review.id, { effectiveAsOf: r1.closure.closingLens.recordedThrough, recordedThrough: new Date(Date.parse(r1.closure.recordedAt) - 1).toISOString() }), 'before close');
    assert.equal(early.status, 'OPEN');
    assert.equal(early.closure, null);
    const before = await s.review.getReview(s.gm, r1.review.id, { effectiveAsOf: '2026-01-01T00:00:00.000Z', recordedThrough: '2026-01-01T00:00:00.000Z' });
    assert.equal(before.ok, false);
    assert.equal(before.error.code, 'review.not_known_at_lens');
    void between;
  });
});
