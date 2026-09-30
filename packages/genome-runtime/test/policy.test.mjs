/**
 * The pattern policy (ADR-0028 §6) and the consistency HELM demands of a link.
 * The policy is pure, so every status and every threshold is tested directly;
 * the runtime tests then prove the same rules against real episodes.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conditionsHold, decidePattern, observeCharacteristic, stanceAgrees } from '../src/index.ts';
import { at, buildGenomeStory, expectFail, unwrap } from './harness.mjs';

const ep = (n, context = 'ctx') => ({ episodeId: `e${n}`, decisionId: `d${n}`, contextKey: `${context}` });
const cover = { matching: 3, linked: 3, unlinkedMatching: [] };
const decide = (o) => decidePattern({ supporting: [], contradictory: [], contextual: 0, retired: { retired: false, reason: null }, coverage: cover, ...o });

describe('decidePattern — a description of recurrence, with stated thresholds', () => {
  it('nothing → EMERGING, weak; one case → EMERGING, weak and labelled a hint', () => {
    const none = decide({});
    assert.equal(none.status, 'EMERGING');
    assert.equal(none.weak, true);
    const one = decide({ supporting: [ep(1)] });
    assert.equal(one.status, 'EMERGING');
    assert.match(one.reasons[0], /hint, not a pattern/);
  });

  it('two supporting decisions → RECURRING; three across two contexts → SUPPORTED; three in one context stay RECURRING', () => {
    assert.equal(decide({ supporting: [ep(1, 'a'), ep(2, 'b')] }).status, 'RECURRING');
    assert.equal(decide({ supporting: [ep(1, 'a'), ep(2, 'b'), ep(3, 'a')] }).status, 'SUPPORTED');
    const same = decide({ supporting: [ep(1, 'a'), ep(2, 'a'), ep(3, 'a')] });
    assert.equal(same.status, 'RECURRING');
    assert.match(same.reasons[0], /share 1 context, so it is not yet SUPPORTED/);
  });

  it('two episodes of the SAME decision are one case', () => {
    const twice = decide({ supporting: [{ episodeId: 'e1', decisionId: 'd', contextKey: 'a' }, { episodeId: 'e2', decisionId: 'd', contextKey: 'b' }] });
    assert.equal(twice.status, 'EMERGING');
  });

  it('a contradictory episode makes any pattern CONTESTED — a majority does not erase it', () => {
    const many = decide({ supporting: [ep(1, 'a'), ep(2, 'b'), ep(3, 'c'), ep(4, 'd'), ep(5, 'e')], contradictory: [ep(6, 'f')] });
    assert.equal(many.status, 'CONTESTED');
    assert.match(many.reasons.join(' '), /does not vanish under a majority/);
  });

  it('retirement wins over everything', () => {
    assert.equal(decide({ supporting: [ep(1), ep(2)], retired: { retired: true, reason: 'superseded' } }).status, 'RETIRED');
  });

  it('coverage names the matching episodes nobody has linked', () => {
    const d = decide({ supporting: [ep(1)], coverage: { matching: 3, linked: 1, unlinkedMatching: ['x', 'y'] } });
    assert.match(d.reasons.join(' '), /1 of 3 recorded episode\(s\).*2 matching episode\(s\) have not been reviewed/);
  });

  it('carries no probability, score or weight', () => {
    const d = decide({ supporting: [ep(1, 'a'), ep(2, 'b'), ep(3, 'c')] });
    for (const key of Object.keys(d)) assert.doesNotMatch(key, /score|probab|weight|confidence/i, key);
  });
});

describe('observeCharacteristic — HELM checks from its own records', () => {
  const review = (variances = [], assumptionResults = []) => ({ id: 'r', reviewedAt: '2027-01-01T00:00:00.000Z', variances, assumptionResults });
  const facts = (o = {}) => ({ committedAt: '2026-09-23T00:00:00.000Z', assumptions: [], challenges: [], alternatives: [], reviews: [], ...o });
  const v = (variance) => ({ label: 'GM', metricKey: 'GrossMarginPct', expected: '32', actual: '31', variance });
  const gmBelow = { kind: 'OUTCOME_VS_EXPECTATION', metricKey: 'GrossMarginPct', direction: 'ACTUAL_BELOW_EXPECTED' };

  it('an outcome pattern reads the sign of the recorded variance, exactly', () => {
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([v('-0.6878')])] })).result, 'EXHIBITS');
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([v('0')])] })).result, 'DOES_NOT_EXHIBIT');
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([v('0.0000')])] })).result, 'DOES_NOT_EXHIBIT');
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([v('1.2')])] })).result, 'DOES_NOT_EXHIBIT');
    assert.equal(observeCharacteristic({ ...gmBelow, direction: 'ACTUAL_EQUALS_EXPECTED' }, facts({ reviews: [review([v('0')])] })).result, 'EXHIBITS');
  });

  it('no outcome yet, or no variance for the metric, is NOT_OBSERVABLE — never a guess', () => {
    assert.equal(observeCharacteristic(gmBelow, facts()).result, 'NOT_OBSERVABLE');
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([{ ...v(null) }])] })).result, 'NOT_OBSERVABLE');
    assert.equal(observeCharacteristic(gmBelow, facts({ reviews: [review([{ ...v('-1'), metricKey: 'CashImpact' }])] })).result, 'NOT_OBSERVABLE');
  });

  it('an assumption pattern joins the review to the assumption\'s criticality', () => {
    const results = [{ assumptionId: 'a1', outcome: 'DISPROVED', statement: 's', evidenceId: null, note: null }];
    const a = [{ id: 'a1', criticality: 'MATERIAL', owner: null }];
    assert.equal(observeCharacteristic({ kind: 'ASSUMPTION_OUTCOME', criticality: 'MATERIAL', outcome: 'DISPROVED' }, facts({ assumptions: a, reviews: [review([], results)] })).result, 'EXHIBITS');
    assert.equal(observeCharacteristic({ kind: 'ASSUMPTION_OUTCOME', criticality: 'CRITICAL', outcome: 'DISPROVED' }, facts({ assumptions: a, reviews: [review([], results)] })).result, 'DOES_NOT_EXHIBIT');
    assert.equal(observeCharacteristic({ kind: 'ASSUMPTION_OUTCOME', criticality: 'ANY', outcome: 'DISPROVED' }, facts({ assumptions: a, reviews: [review([], results)] })).result, 'EXHIBITS');
  });

  it('a process feature is observable at commitment, without any outcome', () => {
    const open = [{ id: 'c1', status: 'OPEN', resolvedAt: null }];
    const late = [{ id: 'c2', status: 'RESOLVED', resolvedAt: '2026-10-01T00:00:00.000Z' }];
    const early = [{ id: 'c3', status: 'RESOLVED', resolvedAt: '2026-09-20T00:00:00.000Z' }];
    const ch = { kind: 'PROCESS_FEATURE', feature: 'CHALLENGE_OPEN_AT_COMMITMENT' };
    assert.equal(observeCharacteristic(ch, facts({ challenges: open })).result, 'EXHIBITS');
    assert.equal(observeCharacteristic(ch, facts({ challenges: late })).result, 'EXHIBITS', 'resolved only after the commitment was still open at it');
    assert.equal(observeCharacteristic(ch, facts({ challenges: early })).result, 'DOES_NOT_EXHIBIT');
    const own = { kind: 'PROCESS_FEATURE', feature: 'CRITICAL_ASSUMPTION_UNOWNED' };
    assert.equal(observeCharacteristic(own, facts({ assumptions: [{ id: 'a', criticality: 'CRITICAL', owner: null }] })).result, 'EXHIBITS');
    assert.equal(observeCharacteristic(own, facts({ assumptions: [{ id: 'a', criticality: 'MINOR', owner: null }] })).result, 'DOES_NOT_EXHIBIT');
  });
});

describe('conditions and stances', () => {
  const features = (values, notStated = []) => ({ values: { decisionType: [], triggerType: [], reversibility: [], businessUnit: [], country: [], constraintKind: [], expectedMetric: [], overrideMetric: [], customerClass: [], ...values }, notStated, placement: {}, anchorIds: [] });

  it('every stated condition must hold; a feature the episode could not state fails it, loudly', () => {
    const f = features({ decisionType: ['INVENTORY_ALLOCATION'], triggerType: ['ISSUE'] }, ['constraintKind']);
    assert.equal(conditionsHold({ decisionType: ['INVENTORY_ALLOCATION'], triggerType: ['ISSUE', 'SIGNAL'] }, f).holds, true);
    const fail = conditionsHold({ triggerType: ['SIGNAL'] }, f);
    assert.equal(fail.holds, false);
    assert.match(fail.failed[0], /triggerType is \[ISSUE\], the pattern needs one of \[SIGNAL\]/);
    assert.match(conditionsHold({ constraintKind: ['INVENTORY'] }, f).failed[0], /not stated for this episode/);
    assert.equal(conditionsHold({}, f).holds, true, 'no condition, no restriction beyond scope');
  });

  it('a supporting link must be SUPPORTS, a contradictory link CONTRADICTS, and a contextual link is always allowed', () => {
    for (const c of ['SUPPORTS', 'CONTRADICTS', 'OUT_OF_SCOPE', 'NOT_OBSERVABLE']) {
      assert.equal(stanceAgrees('CONTEXTUAL_EPISODE', c).ok, true, `contextual / ${c}`);
      assert.equal(stanceAgrees('SUPPORTING_EPISODE', c).ok, c === 'SUPPORTS', `supporting / ${c}`);
      assert.equal(stanceAgrees('CONTRADICTORY_EPISODE', c).ok, c === 'CONTRADICTS', `contradictory / ${c}`);
    }
  });
});

describe('the runtime refuses to record what its own records contradict', () => {
  let s;
  let g;
  before(async () => {
    s = await buildGenomeStory();
    g = s.genomeStory;
  });

  it('classifies the episodes against P1 from its own records', async () => {
    const cls = async (key) => unwrap(await s.genome.classifyEpisode(s.scope, g.patterns.P1.pattern.id, g.episodes[key].episode.id), key);
    assert.equal((await cls('E1')).classification, 'SUPPORTS');
    assert.equal((await cls('E4')).classification, 'SUPPORTS');
    assert.equal((await cls('E5')).classification, 'CONTRADICTS');
    const e2 = await cls('E2');
    assert.equal(e2.classification, 'OUT_OF_SCOPE');
    assert.match(e2.reasons.join(' '), /triggerType is \[PLANNED_REVIEW\]/);
    const e3 = await cls('E3');
    assert.equal(e3.classification, 'OUT_OF_SCOPE');
    assert.match(e3.reasons.join(' '), /outside Pharma BU/);
  });

  it('a person cannot link a contradicting episode as supporting, or a matching one as contradictory', async () => {
    const p = await s.genome.proposePattern(s.scope, {
      title: 'a fresh pattern for the link tests',
      scope: { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] },
      conditions: { decisionType: ['INVENTORY_ALLOCATION'], triggerType: ['ISSUE', 'SIGNAL'], expectedMetric: ['GrossMarginPct'] },
      characteristic: { kind: 'OUTCOME_VS_EXPECTATION', metricKey: 'GrossMarginPct', direction: 'ACTUAL_BELOW_EXPECTED' },
      statement: 'Fixture.',
      limitations: 'Fixture.',
      authoredByLabel: 'test',
    });
    const pid = unwrap(p, 'pattern').pattern.id;
    const asSupport = await s.genome.linkEpisode(s.scope, pid, g.episodes.E5.episode.id, 'SUPPORTING_EPISODE', 'wishful');
    assert.equal(expectFail(asSupport, 'contradicting as support').code, 'genome.inconsistent_stance');
    assert.match(asSupport.error.message, /show the opposite of the characteristic/);
    const asContra = await s.genome.linkEpisode(s.scope, pid, g.episodes.E1.episode.id, 'CONTRADICTORY_EPISODE', 'wishful');
    assert.equal(expectFail(asContra, 'supporting as contradictory').code, 'genome.inconsistent_stance');
    const outside = await s.genome.linkEpisode(s.scope, pid, g.episodes.E3.episode.id, 'SUPPORTING_EPISODE', 'Thailand too');
    assert.match(expectFail(outside, 'another country as support').message, /outside the pattern's scope or conditions/);
    const okLink = await s.genome.linkEpisode(s.scope, pid, g.episodes.E1.episode.id, 'SUPPORTING_EPISODE', 'Margin came in 0.6878 pts below.');
    assert.equal(okLink.ok, true);
    const twice = await s.genome.linkEpisode(s.scope, pid, g.episodes.E1.episode.id, 'CONTEXTUAL_EPISODE', 'flip');
    assert.equal(expectFail(twice, 'a second link').code, 'genome.duplicate');
  });

  it('an episode that did not exist at a lens cannot be classified at it', async () => {
    const before = await s.genome.classifyEpisode(s.scope, g.patterns.P1.pattern.id, g.episodes.E5.episode.id, at('2027-03-30T00:00:00.000Z'));
    assert.equal(expectFail(before, 'episode not yet known').code, 'genome.not_known_at_lens');
  });
});
