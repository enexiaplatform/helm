/**
 * verify:counterfactual-temporality — a counterfactual is anchored to the past,
 * and the past stays the past.
 *
 *   - no anchor, or an anchor recorded after the decision boundary, is refused;
 *   - AS_KNOWN_THEN uses only what was known at the boundary; a hindsight input
 *     learned before it belongs in AS_KNOWN_THEN, and one learned in the future
 *     was not learned;
 *   - hindsight about something the CHOSEN alternative set is a consequence of
 *     the choice, not news about the world;
 *   - a case, a world and a review are reconstructed at any lens from
 *     append-only records; a later estimate is a new world, never a rewrite.
 */

import { MERIDIAN_COUNTERFACTUAL_TIMES as T } from '../packages/counterfactual-runtime/src/index.ts';
import { at, buildCounterfactualStory, contract, rohtoAlternatives, unwrap } from './lib/counterfactualStack.mjs';

const c = contract('verify:counterfactual-temporality');
const s = await buildCounterfactualStory();
const g = s.counterfactualStory;
const alts = await rohtoAlternatives(s);
const pharma = { kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] };
const open = (over = {}) =>
  s.counterfactual.openCase(s.scope, {
    decisionId: s.story.decisionId,
    title: 'temporality probe',
    question: 'A probe?',
    intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id },
    anchorSnapshotId: s.story.S0.snapshot.id,
    scope: pharma,
    authoredByLabel: 'contract',
    ...over,
  });

// ---- anchored to the past.
const noAnchor = await open({ anchorSnapshotId: null });
c.check('anchor-required', !noAnchor.ok, 'a case was opened with no anchor: today would be the starting point');
for (const snap of [s.story.S1a, s.story.S1, s.story.S2]) {
  const r = await open({ anchorSnapshotId: snap.snapshot.id });
  c.check('anchor-in-the-past', !r.ok, `a snapshot recorded after the decision (${snap.snapshot.spec.label}) was accepted as the anchor`);
}

// ---- hindsight is later, exogenous, and never a consequence of the choice.
const probe = unwrap(await open({ carriesClasses: ['COMMERCIAL_CONFIDENTIAL'], intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id } }), 'probe case');
const input = (over = {}) => ({
  label: 'the tender did not draw',
  source: { kind: 'OUTCOME_REVIEW', ref: g.hindsightReviewId },
  override: { overrideType: 'VALUE_OVERRIDE', targetNodeId: s.nodeIds.oppProbNext, operation: 'SET', value: '0', unit: 'ratio', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'The review disproved it.', confidence: 0.9 },
  exogeneity: "The customer's decision, not ours to affect by how we allocated.",
  ...over,
});
const est = (hindsight) => s.counterfactual.estimate(s.scope, probe.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 'contract', hindsight });
const codeOf = (r) => (r.ok ? 'ok' : r.error.code);
c.check('hindsight-needs-input', codeOf(await est([])) === 'counterfactual.no_hindsight_inputs', 'a WITH_HINDSIGHT world was computed from no hindsight: it would be AS_KNOWN_THEN renamed');
c.check('hindsight-later', codeOf(await est([input({ source: { kind: 'EXTERNAL_RECORD', ref: 'a quote', learnedAt: '2026-09-20T00:00:00.000Z' } })])) === 'counterfactual.not_hindsight', 'a fact knowable at the boundary was accepted as hindsight');
c.check('hindsight-later', !(await est([input({ source: { kind: 'EXTERNAL_RECORD', ref: 'a quote', learnedAt: '2099-01-01T00:00:00.000Z' } })])).ok, 'a fact learned in the future was accepted');
c.check('exogeneity', !(await est([input({ exogeneity: 'no' })])).ok, 'hindsight without a stated exogeneity was accepted');
for (const node of ['freightOpex', 'availDist', 'availOwn']) {
  const r = await est([input({ override: { ...input().override, targetNodeId: s.nodeIds[node], unit: node === 'freightOpex' ? 'currency' : 'units', currency: node === 'freightOpex' ? 'VND' : null } })]);
  c.check('consequence', codeOf(r) === 'counterfactual.hindsight_is_consequence', `hindsight about ${node}, which the chosen alternative set, was accepted as news about the world`);
}

// ---- as known then reads only what was known at the boundary.
const then = g.worlds.cf1Then.world;
c.check('as-known-then', JSON.stringify(then.knowledge) === JSON.stringify(g.cases.CF1.case.boundary), 'AS_KNOWN_THEN was read at a later lens than the decision boundary');
c.check('as-known-then', Date.parse(then.anchorFork.recordedThrough) <= Date.parse(g.cases.CF1.case.boundary.recordedThrough), 'the alternative\'s run forked after the decision boundary');
const decision = unwrap(await s.decisionStore.getDecision(s.scope, s.story.decisionId), 'decision');
const cf2 = g.worlds.cf2Then.world;
c.check('own-fork', cf2.anchorFork.effectiveAsOf === decision.fork.effectiveAsOf && cf2.anchorFork.recordedThrough === decision.fork.recordedThrough, 'an override world was built from today\'s state, not the decision\'s fork');

// ---- the past stays the past.
const between = unwrap(await s.counterfactual.getCase(s.scope, g.cases.CF1.case.id, at(T.betweenWorlds)), 'between');
c.check('reconstruction', between.status === 'ESTIMATED' && between.worlds.asKnownThen && between.worlds.withHindsight === null && between.reviews.length === 0, 'between the worlds the case shows the hindsight world or its review');
const early = await s.counterfactual.getCase(s.scope, g.cases.CF1.case.id, at('2027-04-11T00:00:00.000Z'));
c.check('reconstruction', !early.ok && early.error.code === 'counterfactual.not_known_at_lens', 'a case was visible before it was asked');
const cmpBetween = unwrap(await s.counterfactual.compare(s.scope, g.cases.CF1.case.id, at(T.betweenWorlds)), 'compare between');
c.check('reconstruction', cmpBetween.fingerprint !== g.comparison.fingerprint, 'the comparison at an earlier lens is identical to the current one');

// ---- a later estimate is a new world; nothing is rewritten.
const worldsBefore = unwrap(await s.counterfactualStore.listWorlds(s.scope, g.cases.CF1.case.id), 'worlds');
unwrap(await s.counterfactual.estimate(s.scope, g.cases.CF1.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 'contract' }), 're-estimate');
const worldsAfter = unwrap(await s.counterfactualStore.listWorlds(s.scope, g.cases.CF1.case.id), 'worlds after');
c.check('append-only', worldsAfter.length === worldsBefore.length + 1, 're-estimating did not append a world');
c.check('append-only', worldsBefore.every((w, i) => JSON.stringify(w) === JSON.stringify(worldsAfter[i])), 're-estimating changed an earlier world');
const stillBetween = unwrap(await s.counterfactual.getCase(s.scope, g.cases.CF1.case.id, at(T.betweenWorlds)), 'still between');
c.check('append-only', JSON.stringify(stillBetween.worlds) === JSON.stringify(between.worlds), 'a later estimate changed what the earlier lens showed');
c.check('review-pinned', unwrap(await s.counterfactualStore.listReviews(s.scope, g.cases.CF1.case.id), 'reviews')[0].comparisonFingerprint === g.comparison.fingerprint, 'a later world rewrote what the review was pinned to');

c.finish('no anchor and no post-decision anchor; hindsight later, stated and exogenous; as-known-then read at the boundary; overrides forked at the decision; the past reconstructed at any lens; estimates append');
