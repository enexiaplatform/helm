/**
 * The genome REFERENCES a counterfactual case (ADR-0029 §9): beside, never inside,
 * how management decided and what happened. What might have happened otherwise
 * is a different question.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGenomeStory, buildGenomeWithCounterfactuals, expectFail, unwrap } from './harness.mjs';

describe('a counterfactual case bound to an episode', () => {
  let plain;
  let s;
  let e1;
  before(async () => {
    plain = await buildGenomeStory();
    s = await buildGenomeWithCounterfactuals();
    e1 = s.genomeStory.episodes.E1.episode;
  });

  it('is listed in its own section, with the lenses that exist and no verdict', async () => {
    const v = unwrap(await s.genome.getEpisode(s.scope, e1.id), 'episode');
    assert.equal(v.counterfactuals.length, 1);
    const cf = v.counterfactuals[0];
    assert.equal(cf.caseId, s.counterfactualStory.cases.CF1.case.id);
    assert.deepEqual(cf.lenses, { asKnownThen: true, withHindsight: true });
    assert.equal(cf.status, 'REVIEWED');
    assert.doesNotMatch(JSON.stringify(cf), /regret|verdict|better|worse|should have/i);
  });

  it('leaves how management decided and what happened byte-identical', async () => {
    const before = unwrap(await plain.genome.getEpisode(plain.scope, plain.genomeStory.episodes.E1.episode.id), 'plain');
    const after = unwrap(await s.genome.getEpisode(s.scope, e1.id), 'with');
    assert.equal(JSON.stringify(after.process), JSON.stringify(before.process), 'a counterfactual rewrote the process section');
    assert.equal(JSON.stringify(after.outcome), JSON.stringify(before.outcome), 'a counterfactual rewrote the outcome section');
    assert.equal(after.counterfactuals.length, 1);
    assert.equal(before.counterfactuals.length, 0);
  });

  it('references the case; it does not copy it', async () => {
    const v = unwrap(await s.genome.getEpisode(s.scope, e1.id), 'episode');
    const refs = v.refs.filter((r) => r.role === 'COUNTERFACTUAL_CASE');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref.kind, 'COUNTERFACTUAL_CASE');
    assert.doesNotMatch(JSON.stringify(v.counterfactuals), /30\.517|32\.3878|-1\.7905/, 'a compared value was copied into the episode');
  });

  it('a case is not in the episode at a lens before it was bound', async () => {
    const early = { effectiveAsOf: '2027-04-06T03:00:00.000Z', recordedThrough: '2027-04-06T03:00:00.000Z' };
    const v = unwrap(await s.genome.getEpisode(s.scope, e1.id, early), 'early');
    assert.equal(v.counterfactuals.length, 0);
  });
});

describe('what may be bound', () => {
  let s;
  before(async () => {
    s = await buildGenomeWithCounterfactuals();
  });

  it('only a case reviewing the episode\'s own decision', async () => {
    const other = s.genomeStory.episodes.E2.episode;
    const r = await s.genome.bindRef(s.scope, other.id, 'COUNTERFACTUAL_CASE', { kind: 'COUNTERFACTUAL_CASE', id: s.counterfactualStory.cases.CF2.case.id, pin: null, label: null });
    assert.match(expectFail(r, 'another decision').message, /reviews another decision/);
  });

  it('only a case that exists, of that kind', async () => {
    const e1 = s.genomeStory.episodes.E1.episode;
    assert.equal(expectFail(await s.genome.bindRef(s.scope, e1.id, 'COUNTERFACTUAL_CASE', { kind: 'COUNTERFACTUAL_CASE', id: 'no-such-case', pin: null, label: null }), 'unknown').code, 'counterfactual.not_found');
    assert.match(expectFail(await s.genome.bindRef(s.scope, e1.id, 'COUNTERFACTUAL_CASE', { kind: 'TWIN_SNAPSHOT', id: 'x', pin: null, label: null }), 'kind').message, /COUNTERFACTUAL_CASE/);
  });

  it('the same case cannot be bound twice in one episode', async () => {
    const e1 = s.genomeStory.episodes.E1.episode;
    const r = await s.genome.bindRef(s.scope, e1.id, 'COUNTERFACTUAL_CASE', { kind: 'COUNTERFACTUAL_CASE', id: s.counterfactualStory.cases.CF1.case.id, pin: null, label: null });
    assert.equal(r.ok, false);
  });
});
