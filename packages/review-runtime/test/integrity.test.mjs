/**
 * Integrity: a review binds and never decides; a closed review is memory; nothing is
 * left hanging; carrying forward references the same object; a missing source is
 * said out loud.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { computePack } from '../src/index.ts';
import { buildReviewStack, buildReviewStory, expectFail, unwrap } from './harness.mjs';
import { buildStory } from '../../twin-runtime/test/harness.mjs';

let s;
let vn;
before(async () => {
  s = await buildReviewStory();
  vn = s.story.scopes.vietnam;
});

const open = (over = {}) => s.review.openReview(s.gm, { title: 'A review', cadence: 'MONTHLY', periodLabel: '2027-05', scope: vn, periods: ['2026-Q4'], grantedUnitIds: ['unit-vn'], openedByLabel: 'test', ...over });

describe('one open review per scope and cadence; a review follows a closed one', () => {
  it('opening a second review of the same scope and cadence while one is open is refused', async () => {
    const a = unwrap(await open(), 'first');
    assert.equal(expectFail(await open({ periodLabel: '2027-06' }), 'second').code, 'review.already_open');
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Closed.', dispositions: [], closedByLabel: 'test' }), 'close');
  });

  it('a review cannot follow one that is still open, or one of another scope', async () => {
    const a = unwrap(await open({ cadence: 'STRATEGIC', periodLabel: '2027-S1' }), 'open');
    assert.equal(expectFail(await open({ cadence: 'WEEKLY', periodLabel: '2027-W22', previousReviewId: a.review.id }), 'follows an open review').code, 'review.previous_not_closed');
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Closed.', dispositions: [], closedByLabel: 'test' }), 'close');
    const pharma = { kind: 'ENTITY', entityId: s.governance.entities.buPharma.entityId, entityTypeKey: 'BusinessUnit', label: 'Pharma BU' };
    assert.equal(expectFail(await open({ scope: pharma, cadence: 'WEEKLY', periodLabel: '2027-W22', previousReviewId: a.review.id }), 'other scope').code, 'review.previous_other_scope');
  });

  it('the first review of a scope, opened without stating periods, reads the twin default periods instead of none', async () => {
    const pharma = s.story.scopes.pharma;
    const a = unwrap(await s.review.openReview(s.gm, { title: 'First pharma review', cadence: 'MONTHLY', periodLabel: '2026-10', scope: pharma, grantedUnitIds: ['unit-vn'], openedByLabel: 'test' }), 'first review, no periods');
    assert.equal(a.review.previousReviewId, null);
    const opening = unwrap(await s.twin.getSnapshot(s.gm, a.review.openingSnapshotId), 'opening snapshot');
    assert.ok(opening.snapshot.spec.periods.length > 0, 'the opening state reads at least one business period');
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Closed.', dispositions: [], closedByLabel: 'test' }), 'close');
  });

  it('a review of the same scope and cadence, opened after the last closed, follows it by default', async () => {
    const a = unwrap(await open({ cadence: 'WEEKLY', periodLabel: '2027-W30', previousReviewId: null }), 'open');
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Closed.', dispositions: [], closedByLabel: 'test' }), 'close');
    const b = unwrap(await open({ cadence: 'WEEKLY', periodLabel: '2027-W31' }), 'next');
    assert.equal(b.review.previousReviewId, a.review.id);
    unwrap(await s.review.closeReview(s.gm, b.review.id, { summary: 'Closed.', dispositions: [], closedByLabel: 'test' }), 'close');
  });
});

describe('items bind existing objects; a question is the one thing a review owns', () => {
  let v;
  before(async () => {
    v = unwrap(await open({ cadence: 'QUARTERLY', periodLabel: '2027-Q2' }), 'open');
  });

  it('a question is a sentence; every other item points at an object that exists, of its own kind', async () => {
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'QUESTION', note: 'why?' }), 'short').code, 'review.invalid_input');
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'DECISION' }), 'no ref').code, 'review.invalid_input');
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: 'nope', label: 'x' } }), 'unknown decision').code, 'review.bad_reference');
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'COMMITMENT', ref: { kind: 'DECISION', id: s.story.decisionId, label: 'x' } }), 'wrong kind').code, 'review.invalid_input');
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'ATTENTION', ref: { kind: 'ATTENTION', id: 'value:not-an-attention-item', label: 'x' } }), 'not attention').code, 'review.bad_reference');
  });

  it('a role must fit its object: only a commitment is committed, only a decision is framed or reconsidered', async () => {
    const ref = (kind, id) => ({ kind, id, label: 'x' });
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'DECISION', ref: ref('DECISION', s.story.decisionId), role: 'COMMITTED' }), 'committed decision').code, 'review.invalid_input');
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'COMMITMENT', ref: ref('COMMITMENT', s.story.commitmentId), role: 'FRAMED' }), 'framed commitment').code, 'review.invalid_input');
    unwrap(await s.review.addItem(s.gm, v.review.id, { kind: 'DECISION', ref: ref('DECISION', s.story.decisionId), role: 'RECONSIDERED', note: 'Management asks whether to reconsider.' }), 'reconsidered');
  });

  it('the same thing is not recorded twice in the same role', async () => {
    const r = await s.review.addItem(s.gm, v.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: s.story.decisionId, label: 'x' }, role: 'RECONSIDERED' });
    assert.equal(expectFail(r, 'duplicate').code, 'review.duplicate');
  });

  it('a review cannot be closed with an item left hanging, a disposition without a reason, or one for an item it does not hold', async () => {
    const q = unwrap(await s.review.addItem(s.gm, v.review.id, { kind: 'QUESTION', note: 'What did the quarter teach us?' }), 'question');
    const current = unwrap(await s.review.getReview(s.gm, v.review.id), 'view');
    assert.equal(expectFail(await s.review.closeReview(s.gm, v.review.id, { summary: 'x', dispositions: [], closedByLabel: 't' }), 'hanging').code, 'review.items_without_disposition');
    assert.equal(expectFail(await s.review.closeReview(s.gm, v.review.id, { summary: 'x', dispositions: current.items.map((i) => ({ itemId: i.id, disposition: 'RESOLVED', reason: i.id === q.id ? '' : 'ok' })), closedByLabel: 't' }), 'no reason').code, 'review.invalid_input');
    assert.equal(expectFail(await s.review.closeReview(s.gm, v.review.id, { summary: 'x', dispositions: [...current.items.map((i) => ({ itemId: i.id, disposition: 'RESOLVED', reason: 'ok' })), { itemId: 'stranger', disposition: 'DROPPED', reason: 'ok' }], closedByLabel: 't' }), 'stranger').code, 'review.bad_reference');
    unwrap(await s.review.closeReview(s.gm, v.review.id, { summary: 'Done.', dispositions: current.items.map((i) => ({ itemId: i.id, disposition: 'DROPPED', reason: 'Not pursued.' })), closedByLabel: 't' }), 'close');
  });

  it('a closed review is memory: it takes no more items and cannot be closed again', async () => {
    assert.equal(expectFail(await s.review.addItem(s.gm, v.review.id, { kind: 'QUESTION', note: 'Anything else at all?' }), 'late').code, 'review.closed');
    assert.equal(expectFail(await s.review.closeReview(s.gm, v.review.id, { summary: 'again', dispositions: [], closedByLabel: 't' }), 'twice').code, 'review.closed');
  });
});

describe('a review binds; it never decides', () => {
  it('reviewing, adding items and closing leave decisions, commitments, outcome reviews and governance identical', async () => {
    const state = async () => {
      const ds = unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions');
      const parts = [];
      for (const d of ds) {
        const cs = unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'commitments').map((c) => `${c.id}:${c.fingerprint}`);
        const os = unwrap(await s.decisionStore.listOutcomeReviews(s.scope, d.id), 'outcomes').map((o) => o.id);
        const intents = [];
        for (const c of unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'commitments')) intents.push(...unwrap(await s.decisionStore.listActionIntents(s.scope, c.id), 'intents').map((i) => `${i.id}:${i.status}:${i.handoffRef}`));
        parts.push(`${d.id}:${d.state}|${cs}|${os}|${intents}`);
      }
      return JSON.stringify(parts.sort());
    };
    const before = await state();
    const a = unwrap(await open({ cadence: 'STRATEGIC', periodLabel: '2027-S2' }), 'open');
    unwrap(await s.review.addItem(s.gm, a.review.id, { kind: 'DECISION', ref: { kind: 'DECISION', id: s.story.decisionId, label: 'x' }, role: 'FRAMED' }), 'framed');
    unwrap(await s.review.addItem(s.gm, a.review.id, { kind: 'COMMITMENT', ref: { kind: 'COMMITMENT', id: s.story.commitmentId, label: 'x' }, role: 'COMMITTED' }), 'committed');
    const cur = unwrap(await s.review.getReview(s.gm, a.review.id), 'view');
    unwrap(await s.review.closeReview(s.gm, a.review.id, { summary: 'Closed.', dispositions: cur.items.map((i) => ({ itemId: i.id, disposition: 'RESOLVED', reason: 'ok' })), closedByLabel: 't' }), 'close');
    assert.equal(await state(), before);
  });

  it('recording that a commitment was "committed" in a review does not commit anything: the commitment was made in the decision runtime, earlier', async () => {
    const commitment = unwrap(await s.decisionStore.getCommitment(s.scope, s.story.commitmentId), 'commitment');
    const first = s.reviewStory.first;
    const item = first.items.find((i) => i.kind === 'COMMITMENT');
    assert.ok(Date.parse(commitment.committedAt) < Date.parse(item.recordedAt), 'the commitment predates the review item that records it');
  });

  it('the source calls no method that decides, commits, approves, evaluates or executes, and reads only through the runtimes\' own ports', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'meridianReviews.ts')) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
      const w = /\.(createDecision|createCommitment|commit|recordApproval|recordRejection|evaluate|approve|reject|recordOutcomeReview|setDecisionState|setActionIntentStatus|addActionIntent|createClaim|reviseClaim|recordObservation|execute|executeBaseline|createScenario|saveSnapshot|declareGovernanceProfile|grantClearance|bindRef|openEpisode|proposePattern|recordLesson|openCase|estimate)\s*\(/.exec(code);
      assert.ok(!w, `${f} calls ${w?.[1]}: a review binds, it does not decide`);
    }
  });
});

describe('a missing source is said out loud, never silently empty', () => {
  it('a pack computed where no genome, counterfactual engine or causal graph is connected lists each as unavailable', async () => {
    const stack = await buildReviewStack();
    const withStory = await buildStory({ stack });
    const opening = unwrap(await withStory.twin.buildSnapshot(withStory.scope, { kind: 'CURRENT', label: 'x', scope: withStory.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: ['unit-vn'] }), 'snapshot');
    const pack = await computePack(withStory.reviewSources, withStory.scope, { lens: opening.snapshot.spec.lens, since: null, previousReviewId: null, snapshotId: opening.snapshot.id, previousClosingSnapshotId: null });
    assert.ok(pack.unavailable.some((u) => /genome/.test(u)));
    assert.ok(pack.unavailable.some((u) => /counterfactual/.test(u)));
    assert.ok(pack.unavailable.some((u) => /causal/.test(u)));
  });

  it('an item that needs an unconnected source is refused, not invented', async () => {
    const stack = await buildReviewStack();
    const withStory = await buildStory({ stack });
    const a = unwrap(await withStory.review.openReview(withStory.gm, { title: 'x', cadence: 'WEEKLY', periodLabel: 'w', scope: withStory.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: ['unit-vn'], openedByLabel: 't' }), 'open');
    const r = await withStory.review.addItem(withStory.gm, a.review.id, { kind: 'EPISODE', ref: { kind: 'EPISODE', id: 'e', label: 'x' } });
    assert.equal(expectFail(r, 'no genome').code, 'review.source_unavailable');
  });
});

describe('no ranking, no score, no meeting-note software', () => {
  it('no view carries a score, rank, priority or weight; a pack is in kernel order', async () => {
    const pack = unwrap(await s.review.prepare(s.gm, s.reviewStory.second.review.id), 'pack');
    const FORBIDDEN = /^(score|rank|ranking|priority|importance|weight|rating|health)$/i;
    const bad = (o, path = '', acc = []) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.test(k)) acc.push(`${path}.${k}`); bad(v, `${path}.${k}`, acc); }
      return acc;
    };
    assert.deepEqual(bad(pack), []);
    assert.deepEqual(bad(s.reviewStory.second), []);
    assert.match(pack.statement, /nothing is ranked, weighted or totalled/);
  });

  it('a review has no free-text agenda, minutes or action-item list of its own: the only content it owns is a question', () => {
    const view = s.reviewStory.second;
    assert.deepEqual(Object.keys(view.review).filter((k) => /minutes|agenda|notes|attendees|actions/i.test(k)), []);
    assert.ok(view.items.every((i) => i.kind === 'QUESTION' || i.ref !== null));
  });
});
