/**
 * verify:genome-runtime — the canonical Rohto management episode.
 *
 * One container over the immutable artifacts of a management experience: the
 * situation as it stood at the decision, the committed future, the outcome,
 * the review and the beliefs — held by reference, never copied. How management
 * decided and what happened are two sections with no combined verdict. Three
 * patterns are recorded over five demo episodes: P1 CONTESTED, P2 RECURRING,
 * P3 EMERGING (one case is a hint, not a pattern). Similarity is agreement on
 * named features listed in the order decided — never resemblance, never a score.
 */

import { buildGenomeStory, contract, unwrap } from './lib/genomeStack.mjs';

const c = contract('verify:genome-runtime');
const s = await buildGenomeStory();
const g = s.genomeStory;
const e1 = g.episodes.E1;

// The episode references the kernel and copies none of it.
c.check('episode-refs', e1.episode.decisionId === s.story.decisionId && e1.episode.commitmentId === s.story.commitmentId, 'the Rohto episode does not wrap the Rohto decision and commitment');
const byRole = (role) => e1.refs.filter((r) => r.role === role).map((r) => r.ref.id);
c.check('episode-refs', JSON.stringify(byRole('SITUATION_SNAPSHOT')) === JSON.stringify([s.story.S0.snapshot.id]), 'the situation is not the snapshot BEFORE the decision');
c.check('episode-refs', JSON.stringify(byRole('COMMITTED_FUTURE')) === JSON.stringify([s.story.CF1.snapshot.id]), 'the committed future is not CF1');
c.check('episode-refs', JSON.stringify(byRole('OUTCOME_SNAPSHOT')) === JSON.stringify([s.story.S2.snapshot.id]), 'the outcome is not the later snapshot');
c.check('episode-refs', byRole('CAUSAL_CONTEXT').length === 4 && byRole('OUTCOME_REVIEW').length === 1 && byRole('GOVERNANCE_EVALUATION').length === 1, 'the episode lacks its four causal claims, its review or its governance evaluation');
c.check('no-copies', !/32\.3878|31\.7|185220000/.test(JSON.stringify(e1.episode)), 'the stored episode holds a copy of an outcome number');
c.check('status', e1.status === 'COMPLETED', `the Rohto episode is ${e1.status}`);

// Process and outcome are two sections; no verdict joins them.
c.check('process', e1.process.chosen === 'B — Reallocate distributor stock' && e1.process.rejected.length >= 3, 'the chosen alternative and those set aside are not both kept');
c.check('process', e1.process.assumptions.filter((a) => a.criticality === 'CRITICAL' && a.owner === null).length === 1, 'the unowned critical assumption is not a fact of the process');
c.check('process', e1.process.challenges.filter((x) => x.openAtCommitment).length === 1, 'the challenge open at commitment is not kept');
const gm = e1.outcome.reviews[0]?.variances.find((v) => v.metricKey === 'GrossMarginPct');
c.check('outcome', gm?.expected === '32.3878' && gm?.actual === '31.7' && gm?.variance === '-0.6878', 'the gross margin variance is not expected 32.3878, actual 31.7, variance −0.6878');
c.check('outcome', e1.outcome.reviews[0]?.assumptionResults.some((a) => a.outcome === 'DISPROVED' && /provincial tender/.test(a.statement)), 'the disproved tender assumption is missing');
const keys = [...Object.keys(e1), ...Object.keys(e1.process), ...Object.keys(e1.outcome)];
c.check('no-verdict', keys.every((k) => !/quality|score|rating|verdict|good|bad/i.test(k)), 'an episode carries a quality, score, rating or verdict');
c.check('no-verdict', /Decision Process Quality ≠ Outcome Quality/.test(e1.statement), 'the episode does not say process quality is not outcome quality');

// Beliefs at the decision and since are two lists.
c.check('beliefs', e1.causal.atDecision.length === 0 && e1.causal.since.length === 4, `beliefs: ${e1.causal.atDecision.length} at the decision and ${e1.causal.since.length} since, expected 0 and 4`);

// The situation is stated from kernel records and says what it does not state.
const sit = e1.episode.situation;
c.check('situation', JSON.stringify(sit.values.constraintKind) === '["INVENTORY"]' && JSON.stringify(sit.values.customerClass) === '["KEY_ACCOUNT"]', 'the Rohto situation is not read at its boundary');
c.check('situation', g.episodes.E4.episode.situation.notStated.includes('constraintKind'), 'a situation without a snapshot does not say constraint kinds are not stated');
for (const key of ['E2', 'E3', 'E4', 'E5']) {
  const v = g.episodes[key];
  c.check('demo-labelled', /\(demo\)/.test(v.episode.title), `${key} is not labelled as a demonstration`);
}

// Patterns.
const p = g.patterns;
c.check('pattern-status', p.P1.status === 'CONTESTED' && p.P2.status === 'RECURRING' && p.P3.status === 'EMERGING', `patterns are ${p.P1.status}, ${p.P2.status}, ${p.P3.status}`);
c.check('pattern-status', p.P3.weak === true && /One case is a hint, not a pattern/.test(p.P3.reasons[0]), 'one case is not labelled a hint');
c.check('pattern-status', p.P1.supporting.length === 2 && p.P1.contradictory.length === 1 && p.P1.contextual.length === 2, 'P1 is not two supporting, one contradictory, two outside it');
c.check('pattern-status', p.P1.policy === 'helm-genome-pattern@1', `P1 was judged under ${p.P1.policy}`);
c.check('pattern-coverage', p.P1.coverage.matching === 3 && p.P1.coverage.linked === 3, 'P1 coverage is not 3 of 3');
c.check('pattern-caveat', Object.values(p).every((v) => /not a law/.test(v.caveat) && v.revision.limitations.trim().length > 0), 'a pattern lacks its caveat or its limitations');
c.check('no-scoring', Object.values(p).every((v) => !Object.keys(v).some((k) => /score|probab|weight|confidence|rank/i.test(k))), 'a pattern carries a score, probability, weight, confidence or rank');
c.check('contextual', p.P1.contextual.every((x) => x.evidence.observed === 'OUT_OF_SCOPE'), 'an episode outside the pattern supports or contradicts it');

// Similarity: agreement on required features, chronological, never scored.
const sim = unwrap(await s.genome.findSimilar(s.scope, { episodeId: e1.episode.id, require: ['decisionType', 'businessUnit', 'triggerType'] }), 'similar');
c.check('similarity', JSON.stringify(sim.episodes.map((x) => x.view.episode.id)) === JSON.stringify([g.episodes.E4.episode.id]), 'the episodes agreeing on decision type, business unit and trigger are not exactly E4');
c.check('similarity', sim.episodes.every((x) => x.agreements.every((a) => a.agrees)), 'an episode is offered that disagrees on a required feature');
c.check('similarity', /not by resemblance/.test(sim.statement) && Object.keys(sim).every((k) => !/score|rank|similarity/i.test(k)), 'similarity is scored or ranked');
const wide = unwrap(await s.genome.findSimilar(s.scope, { episodeId: e1.episode.id, require: ['decisionType', 'businessUnit'] }), 'wide');
const dates = wide.episodes.map((x) => x.view.episode.boundary.recordedThrough);
c.check('similarity', JSON.stringify(dates) === JSON.stringify([...dates].sort()), 'similar episodes are not chronological');
const none = unwrap(await s.genome.findSimilar(s.scope, { episodeId: g.episodes.E3.episode.id, require: ['country', 'decisionType'] }), 'none');
c.check('similarity', none.episodes.length === 0 && /not evidence the situation is new/.test(none.statement), 'no similar situation is presented as evidence the situation is new');
const open = unwrap(await s.genome.findSimilar(s.scope, { decisionId: g.episodes.E5.episode.decisionId, require: ['decisionType', 'reversibility'] }), 'open decision');
c.check('similarity', open.episodes.length >= 3, 'a decision that has not concluded cannot ask whether it has been seen before');

// Lessons are inert and reviewed by someone else.
c.check('lessons', g.lessons.L1.status === 'ENDORSED' && g.lessons.L2.status === 'PROPOSED', `lessons are ${g.lessons.L1.status} and ${g.lessons.L2.status}`);
c.check('lessons', g.lessons.L1.reviews.every((r) => r.reviewedBy !== g.lessons.L1.lesson.authoredBy), 'a lesson was endorsed by its own author');

c.finish('Rohto episode by reference with 4 causal beliefs since; process and outcome apart with no verdict; P1 CONTESTED, P2 RECURRING, P3 EMERGING (weak); similarity by named features, chronological, never scored');
