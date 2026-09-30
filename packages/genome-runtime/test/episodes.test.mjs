/**
 * Episode integrity: hindsight is never the situation, references are bound for
 * what they are, one container per experience, and lessons are inert.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { at, buildGenomeStory, expectFail, unwrap } from './harness.mjs';

let s;
let g;
let rohto;
before(async () => {
  s = await buildGenomeStory();
  g = s.genomeStory;
  rohto = g.episodes.E1.episode;
});

const pharmaScope = () => ({ kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] });

describe('hindsight is not the situation', () => {
  it('a snapshot recorded after the decision cannot be opened as the situation, whichever snapshot it is', async () => {
    for (const snap of [s.story.S1a, s.story.S1, s.story.S2]) {
      const r = await s.genome.openEpisode(s.scope, { decisionId: s.story.decisionId, title: 'x', scope: pharmaScope(), situationSnapshotId: snap.snapshot.id, authoredByLabel: 't' });
      assert.equal(expectFail(r, snap.snapshot.spec.label).code, 'genome.hindsight_as_situation');
    }
  });

  it('nor bound to an existing episode as its situation; an outcome snapshot must come after the decision; the committed future is this commitment\'s own', async () => {
    const bind = (role, snapId) => s.genome.bindRef(s.scope, rohto.id, role, { kind: 'TWIN_SNAPSHOT', id: snapId, pin: null, label: null });
    assert.equal(expectFail(await bind('SITUATION_SNAPSHOT', s.story.S2.snapshot.id), 'S2 as situation').code, 'genome.hindsight_as_situation');
    assert.match(expectFail(await bind('OUTCOME_SNAPSHOT', s.story.S0.snapshot.id), 'S0 as outcome').message, /known before it/);
    assert.match(expectFail(await bind('COMMITTED_FUTURE', s.story.S2.snapshot.id), 'S2 as committed future').message, /COMMITTED_FUTURE snapshot of this episode's own commitment/);
  });

  it('the situation of the Rohto decision is read at its boundary, not from today: key account, inventory breached', () => {
    assert.equal(rohto.boundary.recordedThrough, g.episodes.E1.episode.boundary.recordedThrough);
    assert.ok(Date.parse(rohto.boundary.recordedThrough) < Date.parse(s.story.S1a.snapshot.spec.lens.recordedThrough));
    assert.deepEqual(rohto.situation.values.customerClass, ['KEY_ACCOUNT']);
    assert.deepEqual(rohto.situation.values.constraintKind, ['INVENTORY']);
  });
});

describe('references are bound for what they are', () => {
  it('a role takes only its kind of reference, and only things that exist and belong', async () => {
    const bind = (role, ref) => s.genome.bindRef(s.scope, rohto.id, role, ref);
    assert.match(expectFail(await bind('OUTCOME_REVIEW', { kind: 'TWIN_SNAPSHOT', id: 'x', pin: null, label: null }), 'wrong kind').message, /points at a OUTCOME_REVIEW, not a TWIN_SNAPSHOT/);
    assert.equal(expectFail(await bind('CAUSAL_CONTEXT', { kind: 'CAUSAL_CLAIM', id: 'no-such-claim', pin: null, label: null }), 'unknown claim').code, 'causal.not_found');
    const other = unwrap(await s.decisionStore.listOutcomeReviews(s.scope, g.episodes.E2.episode.decisionId), 'reviews')[0];
    assert.match(expectFail(await bind('OUTCOME_REVIEW', { kind: 'OUTCOME_REVIEW', id: other.id, pin: null, label: null }), "another decision's review").message, /does not belong to this episode's decision/);
    assert.equal(expectFail(await s.genome.bindRef(s.scope, rohto.id, 'MADE_UP', { kind: 'TWIN_SNAPSHOT', id: 'x', pin: null, label: null }), 'unknown role').code, 'genome.invalid_input');
  });

  it('the same reference is bound once per role', async () => {
    const already = g.episodes.E1.refs.find((r) => r.role === 'COMMITTED_FUTURE');
    const again = await s.genome.bindRef(s.scope, rohto.id, 'COMMITTED_FUTURE', already.ref);
    assert.equal(expectFail(again, 'twice').code, 'genome.duplicate');
  });

  it('a management experience has one container', async () => {
    const dup = await s.genome.openEpisode(s.scope, { decisionId: s.story.decisionId, title: 'the same again', scope: pharmaScope(), authoredByLabel: 't' });
    assert.equal(expectFail(dup, 'duplicate episode').code, 'genome.duplicate');
  });

  it('a scope names entities that existed at the boundary; nothing is global by default', async () => {
    const bogus = await s.genome.openEpisode(s.scope, { decisionId: g.episodes.E2.episode.decisionId, title: 'x', scope: { kind: 'ANCHORED', anchors: [{ entityId: 'no-such-entity', label: 'Nowhere', dimension: '' }] }, authoredByLabel: 't' });
    assert.equal(bogus.ok, false);
    const empty = await s.genome.openEpisode(s.scope, { decisionId: g.episodes.E2.episode.decisionId, title: 'x', scope: { kind: 'ANCHORED', anchors: [] }, authoredByLabel: 't' });
    assert.equal(expectFail(empty, 'empty scope').code, 'genome.invalid_input');
    const unjustified = await s.genome.openEpisode(s.scope, { decisionId: g.episodes.E2.episode.decisionId, title: 'x', scope: { kind: 'ENTERPRISE_WIDE', justification: 'yes' }, authoredByLabel: 't' });
    assert.equal(expectFail(unjustified, 'unjustified').code, 'genome.invalid_input');
  });
});

describe('patterns are hypotheses a person owns', () => {
  it('a pattern states its limitations and only conditions HELM can check; nothing about a person', async () => {
    const base = { title: 't', scope: pharmaScope(), characteristic: { kind: 'PROCESS_FEATURE', feature: 'CHALLENGE_OPEN_AT_COMMITMENT' }, statement: 's', authoredByLabel: 't' };
    assert.match(expectFail(await s.genome.proposePattern(s.scope, { ...base, limitations: '' }), 'no limitations').message, /limitations.*not optional/);
    assert.match(expectFail(await s.genome.proposePattern(s.scope, { ...base, limitations: 'l', conditions: { committedBy: ['Country GM'] } }), 'a person as a condition').message, /not a feature a pattern may condition on/);
    assert.match(expectFail(await s.genome.proposePattern(s.scope, { ...base, limitations: 'l', characteristic: { kind: 'MANAGER_JUDGEMENT', level: 'good' } }), 'invented characteristic').message, /Unknown characteristic kind/);
    assert.equal(expectFail(await s.genome.proposePattern(s.scope, { ...base, limitations: 'l', scope: { kind: 'ANCHORED', anchors: [] } }), 'unscoped').code, 'genome.invalid_input');
  });

  it('only its author or an admin retires a pattern; a retired one takes no more episodes and no revisions', async () => {
    const member = (userId) => ({ ...s.as(userId), role: 'member' });
    const p = unwrap(await s.genome.proposePattern(member(s.causalStory.claims.H1.claim.authoredBy), { title: 'to retire', scope: pharmaScope(), conditions: { decisionType: ['INVENTORY_ALLOCATION'] }, characteristic: { kind: 'PROCESS_FEATURE', feature: 'ALTERNATIVE_UNMODELLED' }, statement: 's', limitations: 'l', authoredByLabel: 't' }), 'pattern');
    const stranger = member(s.causalStory.claims.D1.claim.authoredBy);
    assert.equal(expectFail(await s.genome.retirePattern(stranger, p.pattern.id, 'not mine'), 'someone else retires').code, 'genome.forbidden');
    const retired = unwrap(await s.genome.retirePattern(member(s.causalStory.claims.H1.claim.authoredBy), p.pattern.id, 'Superseded.'), 'retire');
    assert.equal(retired.status, 'RETIRED');
    assert.equal(expectFail(await s.genome.linkEpisode(s.scope, p.pattern.id, g.episodes.E1.episode.id, 'CONTEXTUAL_EPISODE', 'late'), 'link after retirement').code, 'genome.immutable');
    assert.equal(expectFail(await s.genome.revisePattern(s.scope, p.pattern.id, { statement: 'again' }), 'revise after retirement').code, 'genome.immutable');
  });

  it('a revision keeps the earlier wording readable at the earlier lens', async () => {
    const before = s.clock.now().toISOString();
    const revised = unwrap(await s.genome.revisePattern(s.scope, g.patterns.P3.pattern.id, { limitations: 'One episode, and its tender assumption was the postponed one.' }), 'revise');
    assert.equal(revised.revision.revision, 2);
    const then = unwrap(await s.genome.getPattern(s.scope, g.patterns.P3.pattern.id, at(before)), 'then');
    assert.equal(then.revision.revision, 1);
    assert.equal(then.revision.limitations, 'One episode. One case is a hint, not a pattern.');
  });
});

describe('lessons are authored, reviewed by someone else, and inert', () => {
  it('an author cannot endorse their own lesson; anyone else may; both are on the record', async () => {
    const member = (userId) => ({ ...s.as(userId), role: 'member' });
    const author = member(s.causalStory.claims.C3.claim.authoredBy);
    const lesson = unwrap(
      await s.genome.recordLesson(author, { claim: 'Confirm the freight premium with Finance first.', scope: pharmaScope(), evidence: [{ kind: 'MANAGEMENT_EPISODE', id: rohto.id, pin: null, label: null }], authoredByLabel: 'author' }),
      'lesson',
    );
    assert.equal(lesson.status, 'PROPOSED');
    const self = await s.genome.reviewLesson(author, lesson.lesson.id, 'ENDORSED', 'I agree with myself.', 'author');
    assert.equal(expectFail(self, 'self endorsement').code, 'genome.self_endorsement');
    const endorsed = unwrap(await s.genome.reviewLesson(member(s.causalStory.claims.D1.claim.authoredBy), lesson.lesson.id, 'ENDORSED', 'The Rohto record supports it.', 'reviewer'), 'endorse');
    assert.equal(endorsed.status, 'ENDORSED');
    assert.equal(endorsed.reviews.length, 1);
    const earlier = unwrap(await s.genome.listLessons(s.scope, at(lesson.lesson.recordedAt)), 'lessons then').find((x) => x.lesson.id === lesson.lesson.id);
    assert.equal(earlier.status, 'PROPOSED', 'the lesson was PROPOSED at the moment it was recorded');
  });

  it('a lesson rests on episodes or patterns of this genome — not free text, not a causal claim, not a calculation', async () => {
    const base = { claim: 'c', scope: pharmaScope(), authoredByLabel: 'a' };
    assert.match(expectFail(await s.genome.recordLesson(s.scope, { ...base, evidence: [] }), 'no evidence').message, /at least one episode or pattern/);
    assert.match(expectFail(await s.genome.recordLesson(s.scope, { ...base, evidence: [{ kind: 'CAUSAL_CLAIM', id: s.causalStory.claims.H1.claim.id, pin: null, label: null }] }), 'a causal claim').message, /not on free text, not on a calculation/);
    assert.match(expectFail(await s.genome.recordLesson(s.scope, { ...base, evidence: [{ kind: 'MANAGEMENT_EPISODE', id: 'ghost', pin: null, label: null }] }), 'a ghost episode').message, /is not in this organization/);
  });

  it('nothing consumes a lesson or a pattern: the genome has no way to change a policy, a calculation, a belief or an authority rule', async () => {
    const methods = Object.keys(s.genome);
    for (const m of methods) assert.doesNotMatch(m, /apply|promote|enforce|autoUpdate|setPolicy|recalculat|propagat|infer|discover|recommend|optimi/i, m);
    const dir = new URL('../src/', import.meta.url);
    for (const f of ['runtime.ts', 'situation.ts', 'policy.ts']) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      assert.doesNotMatch(code, /\.(recordObservation|execute|commit|createCommitment|recordApproval|createClaim|reviseClaim|recordEvidence|linkEvidence|declareGovernanceProfile|appendEvent|setDecisionState|saveSnapshot|buildSnapshot)\s*\(/, `${f} writes below itself`);
    }
  });
});
