/**
 * The canonical Rohto episode and the demo episodes around it (DEMO MANAGEMENT
 * EPISODES): a situation, the beliefs held then and since, how management
 * decided and what happened — kept apart — and the patterns recorded over them.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_GENOME_LABEL, MERIDIAN_GENOME_TIMES as T } from '../src/index.ts';
import { at, buildGenomeStory, unwrap } from './harness.mjs';

let s;
let g;
before(async () => {
  s = await buildGenomeStory();
  g = s.genomeStory;
});

describe('the Rohto episode', () => {
  it('references the kernel and copies none of it: the decision, the commitment, the snapshots, the review, the evaluation and the beliefs', () => {
    const e1 = g.episodes.E1;
    assert.equal(e1.episode.decisionId, s.story.decisionId);
    assert.equal(e1.episode.commitmentId, s.story.commitmentId);
    const roles = e1.refs.map((r) => r.role).sort();
    for (const role of ['SITUATION_SNAPSHOT', 'COMMITTED_FUTURE', 'OUTCOME_SNAPSHOT', 'OUTCOME_REVIEW', 'GOVERNANCE_EVALUATION', 'CAUSAL_CONTEXT']) assert.ok(roles.includes(role), role);
    const byRole = (role) => e1.refs.filter((r) => r.role === role).map((r) => r.ref.id);
    assert.deepEqual(byRole('SITUATION_SNAPSHOT'), [s.story.S0.snapshot.id], 'the situation is the snapshot BEFORE the decision');
    assert.deepEqual(byRole('COMMITTED_FUTURE'), [s.story.CF1.snapshot.id]);
    assert.deepEqual(byRole('OUTCOME_SNAPSHOT'), [s.story.S2.snapshot.id]);
    assert.equal(byRole('CAUSAL_CONTEXT').length, 4);
    // References only: no copied numbers.
    const stored = JSON.stringify(e1.episode);
    assert.doesNotMatch(stored, /32\.3878|31\.7|185220000/, 'the episode holds no copy of an outcome');
  });

  it('shows how management decided and what happened as two sections, and never a combined verdict', () => {
    const e1 = g.episodes.E1;
    assert.equal(e1.status, 'COMPLETED');
    assert.equal(e1.process.chosen, 'B — Reallocate distributor stock');
    assert.ok(e1.process.rejected.length >= 3, 'the alternatives management set aside are kept');
    assert.equal(e1.process.alternatives.total, e1.process.alternatives.modelled + e1.process.alternatives.unmodelled + 0, 'every alternative is accounted for');
    const unowned = e1.process.assumptions.filter((a) => a.criticality === 'CRITICAL' && a.owner === null);
    assert.equal(unowned.length, 1, 'the unowned critical assumption is a fact of the process');
    assert.equal(e1.process.challenges.filter((c) => c.openAtCommitment).length, 1, "Finance's cost challenge was open at commitment");
    const gm = e1.outcome.reviews[0].variances.find((v) => v.metricKey === 'GrossMarginPct');
    assert.equal(gm.expected, '32.3878');
    assert.equal(gm.actual, '31.7');
    assert.equal(gm.variance, '-0.6878');
    const disproved = e1.outcome.reviews[0].assumptionResults.find((a) => a.outcome === 'DISPROVED');
    assert.match(disproved.statement, /provincial tender/);
    for (const key of Object.keys(e1)) assert.doesNotMatch(key, /quality|score|rating|verdict|good|bad/i, key);
    for (const key of [...Object.keys(e1.process), ...Object.keys(e1.outcome)]) assert.doesNotMatch(key, /quality|score|rating|verdict/i, key);
    assert.match(e1.statement, /Decision Process Quality ≠ Outcome Quality/);
  });

  it('hindsight does not rewrite what management believed: no fulfilment-cost claim existed at the decision, four have arrived since', () => {
    const { causal } = g.episodes.E1;
    assert.equal(causal.atDecision.length, 0, 'on the day of the decision there was no recorded causal belief');
    assert.equal(causal.since.length, 4);
    assert.ok(causal.since.every((v) => Date.parse(v.claim.recordedAt) > Date.parse(g.episodes.E1.episode.boundary.recordedThrough)));
    assert.deepEqual(new Set(causal.since.map((v) => v.evaluation.status)), new Set(['SUPPORTED', 'UNRESOLVED', 'HYPOTHESIS']));
  });

  it('the episode is only what the lens can know: it did not exist before it was opened, and was OPEN before the outcome review', async () => {
    const early = await s.genome.getEpisode(s.scope, g.episodes.E1.episode.id, at(T.reviews));
    assert.equal(early.ok, false);
    assert.equal(early.error.code, 'genome.not_known_at_lens');
    const opened = unwrap(await s.genome.getEpisode(s.scope, g.episodes.E1.episode.id, at('2027-04-02T03:00:00.000Z')), 'at opening');
    assert.equal(opened.status, 'COMPLETED', 'the Rohto review was recorded in January, long before the episode was opened');
    assert.equal(opened.refs.length >= 1, true);
  });
});

describe('the demo episodes are labelled and honest', () => {
  it('every demo decision says it is a demonstration; the Rohto episode is the kernel\'s own story', async () => {
    for (const key of ['E2', 'E3', 'E4', 'E5']) {
      const view = g.episodes[key];
      assert.match(view.episode.title, /\(demo\)/, key);
      const d = unwrap(await s.decisionStore.getDecision(s.scope, view.episode.decisionId), 'decision');
      assert.match(d.context, new RegExp(DEMO_GENOME_LABEL), key);
    }
    assert.equal(g.episodes.E1.episode.decisionId, s.story.decisionId);
  });

  it('their situations are stated from kernel records: decision type, trigger, reversibility and the scope\'s org-chain', () => {
    const e4 = g.episodes.E4.episode.situation;
    assert.deepEqual(e4.values.decisionType, ['INVENTORY_ALLOCATION']);
    assert.deepEqual(e4.values.triggerType, ['ISSUE']);
    assert.deepEqual(e4.values.reversibility, ['PARTIALLY_REVERSIBLE']);
    assert.deepEqual(e4.values.businessUnit, [s.governance.entities.buPharma.entityId]);
    assert.deepEqual(e4.values.country, [s.governance.entities.vn.entityId]);
    assert.ok(e4.notStated.includes('constraintKind'), 'no situation snapshot was bound, so constraint kinds are not stated — and it says so');
    const th = g.episodes.E3.episode.situation;
    assert.deepEqual(th.values.country, [s.governance.entities.th.entityId]);
    const e1 = g.episodes.E1.episode.situation;
    assert.deepEqual(e1.values.constraintKind, ['INVENTORY'], 'the Rohto situation snapshot showed the inventory constraint breached');
    assert.deepEqual(e1.values.customerClass, ['KEY_ACCOUNT'], 'at the decision Rohto was a key account; the later reclassification is hindsight');
  });
});

describe('the patterns recorded over the episodes', () => {
  it('P1 is CONTESTED: two supporting, one contradictory, two outside it — with its limitations and its coverage', () => {
    const p1 = g.patterns.P1;
    assert.equal(p1.status, 'CONTESTED');
    assert.equal(p1.policy, 'helm-genome-pattern@1');
    assert.equal(p1.supporting.length, 2);
    assert.equal(p1.contradictory.length, 1);
    assert.equal(p1.contextual.length, 2);
    assert.deepEqual(p1.coverage.matching, 3);
    assert.deepEqual(p1.coverage.linked, 3);
    assert.match(p1.revision.limitations, /none is a sample/);
    assert.match(p1.caveat, /not a law/);
    assert.equal(p1.pattern.scope.anchors[0].label, 'Pharma BU');
  });

  it('P2 is RECURRING and P3 is EMERGING — one case is labelled weak, never a pattern', () => {
    assert.equal(g.patterns.P2.status, 'RECURRING');
    assert.equal(g.patterns.P2.weak, false);
    assert.equal(g.patterns.P3.status, 'EMERGING');
    assert.equal(g.patterns.P3.weak, true);
    assert.match(g.patterns.P3.reasons[0], /One case is a hint, not a pattern/);
  });

  it('no episode outside a pattern\'s scope supports or contradicts it: Thailand and the planned call-off are contextual only', () => {
    const p1 = g.patterns.P1;
    assert.deepEqual(new Set(p1.contextual.map((x) => x.episode.episode.id)), new Set([g.episodes.E2.episode.id, g.episodes.E3.episode.id]));
    assert.ok(p1.contextual.every((x) => x.evidence.observed === 'OUT_OF_SCOPE'));
  });

  it('what the genome knew about P1 on 6 April before the contradiction was linked: RECURRING — and it stays that way for that lens', async () => {
    const then = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id, at(T.beforeContradictionLinked)), 'then');
    assert.equal(then.status, 'RECURRING');
    assert.equal(then.contradictory.length, 0);
    const now = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id), 'now');
    assert.equal(now.status, 'CONTESTED');
    const again = unwrap(await s.genome.getPattern(s.scope, g.patterns.P1.pattern.id, at(T.beforeContradictionLinked)), 'then again');
    assert.equal(again.status, 'RECURRING');
  });
});

describe('have we seen a management situation like this before?', () => {
  it('finds the episodes that agree on every required feature, in the order they were decided, and never by resemblance', async () => {
    const r = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType', 'businessUnit', 'triggerType'] }), 'similar');
    assert.deepEqual(r.episodes.map((x) => x.view.episode.id), [g.episodes.E4.episode.id]);
    assert.ok(r.episodes[0].agreements.every((a) => a.agrees));
    assert.match(r.statement, /not by resemblance/);
    for (const key of Object.keys(r)) assert.doesNotMatch(key, /score|rank|similarity/i, key);
    const wide = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType', 'businessUnit'] }), 'wide');
    const dates = wide.episodes.map((x) => x.view.episode.boundary.recordedThrough);
    assert.deepEqual(dates, [...dates].sort(), 'chronological');
    assert.deepEqual(new Set(wide.episodes.map((x) => x.view.episode.id)), new Set([g.episodes.E2.episode.id, g.episodes.E4.episode.id, g.episodes.E5.episode.id]));
  });

  it('a situation nobody has faced returns nothing, and says that is not evidence it is new', async () => {
    const r = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E3.episode.id, require: ['country', 'decisionType'] }), 'thailand');
    assert.equal(r.episodes.length, 0);
    assert.match(r.statement, /not evidence the situation is new/);
  });

  it('a feature the situation does not state agrees with nothing, and the answer says "cannot tell", not "nothing like it"', async () => {
    const r = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E4.episode.id, require: ['constraintKind'] }), 'unstated');
    assert.equal(r.episodes.length, 0);
    assert.deepEqual(r.unstatedInTarget, ['constraintKind']);
    assert.match(r.statement, /does not state constraintKind/);
    assert.match(r.statement, /cannot tell/);
    const stated = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E1.episode.id, require: ['decisionType'] }), 'stated');
    assert.deepEqual(stated.unstatedInTarget, []);
  });

  it('a decision that has not concluded can ask too — before it is an episode', async () => {
    const r = unwrap(await s.genome.findSimilar(s.scope, { decisionId: g.episodes.E5.episode.decisionId, require: ['decisionType', 'reversibility'] }), 'open decision');
    assert.ok(r.episodes.length >= 3);
  });
});
