/**
 * The canonical Rohto counterfactual review (DEMO COUNTERFACTUAL REVIEW): the
 * actual world beside two alternative worlds, four layers apart, with the
 * lenses never blended, the model labelled as a model, and causal support
 * judged separately at each world's own lens.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_COUNTERFACTUAL_LABEL, MERIDIAN_COUNTERFACTUAL_TIMES as T } from '../src/index.ts';
import { at, buildCounterfactualStory, unwrap } from './harness.mjs';

let s;
let g;
before(async () => {
  s = await buildCounterfactualStory();
  g = s.counterfactualStory;
});

const row = (cmp, key) => cmp.rows.find((r) => r.metric.metricKey === key);

describe('the question and its anchor', () => {
  it('asks an ex-post question about one decision, anchored to the snapshot BEFORE the decision — never to today', () => {
    const c = g.cases.CF1.case;
    assert.equal(c.decisionId, s.story.decisionId);
    assert.equal(c.commitmentId, s.story.commitmentId);
    assert.equal(c.anchor.snapshotId, s.story.S0.snapshot.id);
    assert.ok(Date.parse(c.anchor.lens.recordedThrough) <= Date.parse(c.boundary.recordedThrough), 'the anchor was known at or before the decision boundary');
    assert.equal(c.intervention.kind, 'CHOOSE_ALTERNATIVE');
    assert.match(g.cases.CF1.interventionLabel, /Expedite/);
    assert.match(g.cases.CF1.chosenLabel, /Reallocate/, 'the actual world is what was chosen');
  });

  it('compares the metrics the commitment expected to move, copied at opening; sensitivity classes derive from them and from what the case declares', () => {
    const c = g.cases.CF1.case;
    assert.deepEqual(c.compared.map((m) => m.metricKey), ['GrossMarginPct', 'DemandCoverage', 'CashImpact']);
    assert.deepEqual([...c.sensitivityClasses].sort(), ['COMMERCIAL_CONFIDENTIAL', 'FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT']);
    assert.deepEqual([...g.cases.CF3.case.sensitivityClasses].sort(), ['FINANCIAL_SENSITIVE', 'GENERAL_MANAGEMENT'], 'CF3 declared nothing extra');
  });
});

describe('AS_KNOWN_THEN — what management could reasonably have expected of the alternative', () => {
  it('reads the alternative\'s own run, computed when the decision was made, under a stated model — and labels it a model estimate', () => {
    const w = g.worlds.cf1Then.world;
    assert.equal(w.lens, 'AS_KNOWN_THEN');
    assert.equal(w.method, 'MODEL_COUNTERFACTUAL');
    assert.equal(w.estimability, 'ESTIMATED');
    assert.equal(w.origin, 'BOUND_TO_DECISION');
    assert.ok(w.model.engineVersion && w.model.calculations.length > 0, 'the model lineage is stated');
    assert.ok(Date.parse(w.anchorFork.recordedThrough) <= Date.parse(g.cases.CF1.case.boundary.recordedThrough));
    assert.equal(w.hindsightInputs.length, 0);
    assert.deepEqual(w.knowledge, g.cases.CF1.case.boundary, 'read at the decision boundary and no later');
    assert.match(w.readings[0].statement, /Under model .* the estimated counterfactual value of Gross margin % is 30\.517/);
    assert.match(w.readings[0].statement, /not what would have happened/);
    assert.ok(w.uncertainty.some((u) => /MODEL_COUNTERFACTUAL/.test(u)));
  });

  it('shows what the intervention moved: available stock, the freight premium and the lead time — as stated inputs', () => {
    const moved = g.worlds.cf1Then.world.movedInputs;
    assert.deepEqual(new Set(moved.map((m) => m.metricKey)), new Set(['AvailableInventory', 'Opex', 'LeadTime']));
    assert.ok(moved.every((m) => m.source === 'INTERVENTION' && m.rationale.length > 0));
    assert.equal(g.worlds.cf1Then.world.assumptions.length, 3);
  });

  it('has no causal support at the decision boundary: the claims about fulfilment cost were recorded in January', () => {
    const c = g.worlds.cf1Then.causal;
    assert.equal(c.level, 'MODEL_ONLY');
    assert.deepEqual(c.lens, g.cases.CF1.case.boundary);
    assert.ok(c.pairs.every((p) => p.state !== 'SUPPORTED_PATH'));
    assert.match(c.statement, /not a causal finding/);
  });
});

describe('WITH_HINDSIGHT — the same alternative, plus facts learned later', () => {
  it('adds exactly the disproved-tender assumption, with its source, when it was learned, and a person\'s statement that it does not depend on the choice', () => {
    const w = g.worlds.cf1Hindsight.world;
    assert.equal(w.lens, 'WITH_HINDSIGHT');
    assert.equal(w.origin, 'COMPUTED_FOR_CASE');
    assert.equal(w.hindsightInputs.length, 1);
    const h = w.hindsightInputs[0];
    assert.deepEqual(h.source, { kind: 'OUTCOME_REVIEW', ref: g.hindsightReviewId });
    assert.ok(Date.parse(h.learnedAt) > Date.parse(g.cases.CF1.case.boundary.recordedThrough), 'learned after the boundary');
    assert.match(h.exogeneity, /customer's decision/);
    assert.deepEqual(w.movedInputs.filter((m) => m.source === 'HINDSIGHT').map((m) => m.nodeId), [s.nodeIds.oppProbNext], 'the one input from hindsight is the tender');
    assert.equal(w.movedInputs.filter((m) => m.source === 'INTERVENTION').length, 3, 'the alternative\'s own three inputs are unchanged');
    assert.ok(w.uncertainty.some((u) => /cannot verify that/.test(u)), 'the exogeneity assertion is flagged as unverifiable');
  });

  it('is anchored to the same state: hindsight brings information, never the state the actual decision produced', () => {
    assert.deepEqual(g.worlds.cf1Hindsight.world.anchorFork, g.worlds.cf1Then.world.anchorFork);
    assert.ok(Date.parse(g.worlds.cf1Hindsight.world.knowledge.recordedThrough) > Date.parse(g.worlds.cf1Then.world.knowledge.recordedThrough));
  });

  it('has causal support only at ITS lens: the January claims exist for the world with hindsight and not for the world as known then', () => {
    const then = g.worlds.cf1Then.causal;
    const hind = g.worlds.cf1Hindsight.causal;
    assert.equal(then.level, 'MODEL_ONLY');
    assert.notEqual(hind.level, 'MODEL_ONLY', `with hindsight the freight-cost claim supports a link (${hind.level})`);
    const supported = hind.pairs.filter((p) => p.state === 'SUPPORTED_PATH');
    assert.ok(supported.length > 0);
    assert.ok(supported[0].claims.every((k) => k.status === 'SUPPORTED' && k.applies));
    assert.ok(hind.pairs.every((p) => p.modelDependency === null || /does not count towards any causal claim|model/i.test(p.modelDependency)), 'a known value dependency is shown apart');
  });
});

describe('the comparison keeps four layers apart', () => {
  it('lays expected, actual, alternative as known then and alternative with hindsight side by side, per metric', () => {
    const cmp = g.comparison;
    const gm = row(cmp, 'GrossMarginPct');
    assert.equal(gm.expected.value, '32.3878');
    assert.equal(gm.actual.value, '31.7');
    assert.equal(gm.alternativeThen.value, '30.517');
    assert.equal(gm.alternativeWithHindsight.value, '30.517');
    assert.deepEqual([gm.expected.layer, gm.actual.layer, gm.alternativeThen.layer, gm.alternativeWithHindsight.layer], ['EXPECTED_AT_COMMITMENT', 'ACTUAL', 'ALTERNATIVE_THEN', 'ALTERNATIVE_WITH_HINDSIGHT']);
    const cov = row(cmp, 'DemandCoverage');
    assert.equal(cov.alternativeThen.value, '96.8858');
    assert.equal(cov.alternativeWithHindsight.value, '100');
    const cash = row(cmp, 'CashImpact');
    assert.equal(cash.alternativeThen.value, '-1790500000');
    assert.equal(cash.alternativeWithHindsight.value, '-925600000');
  });

  it('never estimates what it cannot read: the actual coverage and cash were never reviewed, so those cells are UNAVAILABLE and their differences are null', () => {
    const cov = row(g.comparison, 'DemandCoverage');
    const cash = row(g.comparison, 'CashImpact');
    for (const r of [cov, cash]) {
      assert.equal(r.actual.status, 'UNAVAILABLE');
      assert.equal(r.actual.value, null);
      assert.match(r.actual.reason, /No outcome review recorded this metric/);
      assert.equal(r.alternativeWithHindsightMinusActual, null);
    }
  });

  it('computes exactly two differences, each between layers of the same kind, named for what they are', () => {
    const gm = row(g.comparison, 'GrossMarginPct');
    assert.equal(gm.alternativeThenMinusExpected, '-1.8708', 'ex ante with ex ante: the alternative as known then, minus what the commitment expected');
    assert.equal(gm.alternativeWithHindsightMinusActual, '-1.183', 'ex post with ex post: the alternative with hindsight, minus what happened');
    for (const r of g.comparison.rows) {
      assert.deepEqual(Object.keys(r).filter((k) => /minus/i.test(k)).sort(), ['alternativeThenMinusExpected', 'alternativeWithHindsightMinusActual']);
    }
  });

  it('never says a decision was good or bad, regrets it, or ranks the alternatives', () => {
    const text = JSON.stringify(g.comparison);
    assert.doesNotMatch(text, /regret|better decision|worse decision|wrong call|mistake|best alternative|winner/i);
    assert.match(g.comparison.important, /not a judgement of the decision/);
    assert.match(g.comparison.important, /Decision Process Quality ≠ Outcome Quality/);
    assert.match(g.comparison.important, /never brings the state the actual decision produced/);
    for (const key of Object.keys(g.comparison)) assert.doesNotMatch(key, /score|rank|regret|verdict|quality/i, key);
  });

  it('says whether the model changed between the two worlds', () => {
    assert.equal(g.comparison.modelChangedSinceThen, false);
  });
});

describe('what cannot be estimated is not', () => {
  it('an alternative management never modelled is NOT_ESTIMABLE, with the reason — HELM invents no future', () => {
    const w = g.worlds.cf3Then.world;
    assert.equal(w.estimability, 'NOT_ESTIMABLE');
    assert.equal(w.scenario, null);
    assert.equal(w.model, null);
    assert.ok(w.readings.every((r) => r.status === 'UNAVAILABLE' && r.value === null));
    assert.match(w.notEstimableReasons[0], /never modelled|no simulated future/i);
    assert.match(w.uncertainty.join(' '), /does not invent a future/);
    assert.equal(g.worlds.cf3Then.causal.level, 'MODEL_ONLY');
  });
});

describe('an explicit set of overrides is built at the decision\'s own boundary', () => {
  it('CF2 reallocates AND prices the urgency: a computed world on a new labelled scenario, at the decision\'s fork, not from today\'s state', async () => {
    const w = g.worlds.cf2Then.world;
    assert.equal(w.origin, 'COMPUTED_FOR_CASE');
    assert.equal(w.estimability, 'ESTIMATED');
    const decision = unwrap(await s.decisionStore.getDecision(s.scope, s.story.decisionId), 'decision');
    assert.deepEqual({ effectiveAsOf: w.anchorFork.effectiveAsOf, recordedThrough: w.anchorFork.recordedThrough }, { effectiveAsOf: decision.fork.effectiveAsOf, recordedThrough: decision.fork.recordedThrough });
    const scenario = unwrap(await s.scenarios.getScenario(s.scope, w.scenario.scenarioId), 'scenario');
    assert.match(scenario.key, /^cf-/);
    assert.equal(scenario.metadata.counterfactual.caseId, g.cases.CF2.case.id);
    assert.equal(scenario.parentScenarioId, null);
    assert.ok(w.movedInputs.some((m) => m.metricKey === 'AspProduct' || /Price|Selling|Asp/i.test(m.nodeLabel)), 'the price is among the stated inputs');
  });
});

describe('a person\'s reading is recorded, pinned to what they saw', () => {
  it('CF1 is REVIEWED by Finance, not its author; the review states limitations and the comparison fingerprint it read', () => {
    const v = g.cases.CF1;
    assert.equal(v.status, 'REVIEWED');
    assert.equal(v.reviews.length, 1);
    const r = v.reviews[0];
    assert.match(r.reviewedByLabel, new RegExp(DEMO_COUNTERFACTUAL_LABEL));
    assert.match(r.limitations, /model estimate/);
    assert.equal(r.comparisonFingerprint, g.comparison.fingerprint, 'the review is pinned to the comparison it was a review OF');
    assert.match(r.statement, /Neither figure says the reallocation was the wrong call/);
    assert.equal(g.cases.CF2.status, 'ESTIMATED');
  });

  it('the fingerprint is the content of the comparison, not the day it was read: reading it later changes nothing', async () => {
    const later = unwrap(await s.counterfactual.compare(s.scope, g.cases.CF1.case.id), 'later');
    assert.equal(later.fingerprint, g.comparison.fingerprint);
    const reviews = unwrap(await s.counterfactualStore.listReviews(s.scope, g.cases.CF1.case.id), 'reviews');
    assert.equal(reviews[0].comparisonFingerprint, later.fingerprint);
  });

  it('CF2 and CF3 are ESTIMATED, not reviewed', () => {
    assert.equal(g.cases.CF2.status, 'ESTIMATED');
    assert.equal(g.cases.CF3.status, 'ESTIMATED');
  });
});

describe('the past stays the past', () => {
  it('between the two worlds only the world as known then exists; before the case was asked nothing does', async () => {
    const between = unwrap(await s.counterfactual.getCase(s.scope, g.cases.CF1.case.id, at(T.betweenWorlds)), 'between');
    assert.equal(between.status, 'ESTIMATED');
    assert.ok(between.worlds.asKnownThen);
    assert.equal(between.worlds.withHindsight, null);
    assert.equal(between.reviews.length, 0);
    const cmp = unwrap(await s.counterfactual.compare(s.scope, g.cases.CF1.case.id, at(T.betweenWorlds)), 'compare then');
    assert.equal(row(cmp, 'DemandCoverage').alternativeWithHindsight.status, 'UNAVAILABLE');
    assert.match(row(cmp, 'DemandCoverage').alternativeWithHindsight.reason, /No WITH_HINDSIGHT world/);
    const early = await s.counterfactual.getCase(s.scope, g.cases.CF1.case.id, at('2027-04-11T00:00:00.000Z'));
    assert.equal(early.ok, false);
    assert.equal(early.error.code, 'counterfactual.not_known_at_lens');
  });
});
