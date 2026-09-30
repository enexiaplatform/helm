/**
 * verify:counterfactual-runtime — the canonical Rohto counterfactual review.
 *
 * The actual world beside two alternative worlds, four layers apart: what the
 * commitment expected, what happened, the alternative as known then, and with
 * hindsight. Two named differences, each between layers of the same kind. No
 * regret, no verdict, no ranking. What cannot be estimated is not.
 */

import { buildCounterfactualStory, contract, unwrap } from './lib/counterfactualStack.mjs';

const c = contract('verify:counterfactual-runtime');
const s = await buildCounterfactualStory();
const g = s.counterfactualStory;
const row = (cmp, key) => cmp.rows.find((r) => r.metric.metricKey === key);

// The question: one decision, one anchor before it, one explicit intervention.
const cf1 = g.cases.CF1;
c.check('question', cf1.case.decisionId === s.story.decisionId && cf1.case.commitmentId === s.story.commitmentId, 'the case does not review the Rohto decision and its commitment');
c.check('anchor', cf1.case.anchor.snapshotId === s.story.S0.snapshot.id, 'the case is not anchored to the snapshot BEFORE the decision');
c.check('anchor', Date.parse(cf1.case.anchor.lens.recordedThrough) <= Date.parse(cf1.case.boundary.recordedThrough), 'the anchor was recorded after the decision boundary');
c.check('intervention', cf1.case.intervention.kind === 'CHOOSE_ALTERNATIVE' && /Expedite/.test(cf1.interventionLabel), 'the intervention is not the named alternative');
c.check('intervention', g.cases.CF2.case.intervention.kind === 'OVERRIDES', 'CF2 is not an explicit set of overrides');

// Two lenses, computed apart.
const then = g.worlds.cf1Then.world;
const hind = g.worlds.cf1Hindsight.world;
c.check('lens', then.lens === 'AS_KNOWN_THEN' && hind.lens === 'WITH_HINDSIGHT', 'the two worlds are not the two retrospective lenses');
c.check('lens', then.hindsightInputs.length === 0 && hind.hindsightInputs.length >= 1, 'as-known-then holds hindsight, or with-hindsight holds none');
c.check('method', then.method === 'MODEL_COUNTERFACTUAL' && hind.method === 'MODEL_COUNTERFACTUAL', 'a world claims a method other than a model counterfactual');
c.check('method', then.model && then.model.calculations.length > 0 && hind.model && hind.model.calculations.length > 0, 'a world does not state the model that computed it');
c.check('method', then.readings.every((r) => r.statement === null || /not what would have happened/.test(r.statement)), 'a reading is worded as what would have happened');
c.check('uncertainty', then.uncertainty.length >= 2 && hind.uncertainty.some((u) => /cannot verify that/.test(u)), 'the uncertainty is a bare number, or hindsight hides that its exogeneity is a person\'s statement');
c.check('hindsight', hind.hindsightInputs.every((h) => h.exogeneity.length >= 12 && Date.parse(h.learnedAt) > Date.parse(cf1.case.boundary.recordedThrough) && ['OUTCOME_REVIEW', 'EXTERNAL_RECORD'].includes(h.source.kind)), 'a hindsight input lacks a source, a learned-at after the boundary, or an exogeneity statement');
c.check('anchor', JSON.stringify(hind.anchorFork) === JSON.stringify(then.anchorFork), 'hindsight moved the anchor: it brings information, never the state the decision produced');

// Four layers.
const gm = row(g.comparison, 'GrossMarginPct');
c.check('layers', gm.expected.layer === 'EXPECTED_AT_COMMITMENT' && gm.actual.layer === 'ACTUAL' && gm.alternativeThen.layer === 'ALTERNATIVE_THEN' && gm.alternativeWithHindsight.layer === 'ALTERNATIVE_WITH_HINDSIGHT', 'the comparison does not keep four layers');
c.check('layers', gm.expected.value === '32.3878' && gm.actual.value === '31.7' && gm.alternativeThen.value === '30.517', `the four layers hold ${gm.expected.value}, ${gm.actual.value}, ${gm.alternativeThen.value}`);
c.check('differences', gm.alternativeThenMinusExpected === '-1.8708' && gm.alternativeWithHindsightMinusActual === '-1.183', 'a named difference is not the exact decimal difference of two layers of the same kind');
for (const r of g.comparison.rows) {
  c.check('differences', Object.keys(r).filter((k) => /minus/i.test(k)).length === 2, 'a row carries a difference other than the two named ones');
}
const cov = row(g.comparison, 'DemandCoverage');
c.check('unavailable', cov.actual.status === 'UNAVAILABLE' && cov.actual.value === null && cov.alternativeWithHindsightMinusActual === null, 'HELM estimated an actual value nobody reviewed');
const text = JSON.stringify(g.comparison);
c.check('no-verdict', !/regret|better decision|worse decision|wrong call|mistake|best alternative|winner/i.test(text), 'the comparison says a decision was good or bad, regrets it or ranks alternatives');
c.check('no-verdict', Object.keys(g.comparison).every((k) => !/score|rank|regret|verdict|quality/i.test(k)), 'the comparison carries a score, rank, regret, verdict or quality');
c.check('important', /not a judgement of the decision/.test(g.comparison.important) && /Decision Process Quality ≠ Outcome Quality/.test(g.comparison.important), 'the comparison does not state what it is not');

// What cannot be estimated is not.
const cf3 = g.worlds.cf3Then.world;
c.check('not-estimable', cf3.estimability === 'NOT_ESTIMABLE' && cf3.scenario === null && cf3.readings.every((r) => r.value === null), 'HELM invented a future for an alternative that was never modelled');
c.check('not-estimable', cf3.notEstimableReasons.length >= 1 && /does not invent a future/.test(cf3.uncertainty.join(' ')), 'a world that cannot be estimated does not say why');

// A review is a person's reading, pinned to what they saw.
c.check('review', cf1.status === 'REVIEWED' && cf1.reviews[0].comparisonFingerprint === g.comparison.fingerprint, 'the review is not pinned to the comparison it read');
c.check('review', /model estimate/.test(cf1.reviews[0].limitations), 'the review does not state its limitations');
const later = unwrap(await s.counterfactual.compare(s.scope, cf1.case.id), 'later');
c.check('fingerprint', later.fingerprint === g.comparison.fingerprint, 'the comparison fingerprint depends on when it is read');

// The genome-facing view: a case is a question about a decision, never a verdict on a person.
for (const m of Object.keys(s.counterfactual)) c.check('no-person-view', !/byPerson|byManager|byAuthor|byOwner|leaderboard|performance|regret|rank/i.test(m), `the runtime offers ${m}`);

c.finish('question anchored before the decision; two lenses apart; four layers, two named differences; NOT_ESTIMABLE invents nothing; reviews pinned to the fingerprint; no regret, rank or verdict');
