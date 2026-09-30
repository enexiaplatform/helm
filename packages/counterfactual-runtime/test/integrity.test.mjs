/**
 * Integrity: a counterfactual is anchored to the past, its intervention differs
 * from reality, hindsight brings information and never the state the decision
 * produced, what cannot be estimated is not, and computing a world writes
 * nothing below except scenarios labelled as counterfactual.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { at, buildCounterfactualStory, expectFail, rohtoAlternatives, unwrap } from './harness.mjs';

let s;
let g;
let alts;
before(async () => {
  s = await buildCounterfactualStory();
  g = s.counterfactualStory;
  alts = await rohtoAlternatives(s);
});

const pharma = () => ({ kind: 'ANCHORED', anchors: [{ entityId: s.governance.entities.buPharma.entityId, label: 'Pharma BU', dimension: '' }] });
const base = () => ({
  decisionId: s.story.decisionId,
  title: 'a case',
  question: 'What might have happened?',
  intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id },
  anchorSnapshotId: s.story.S0.snapshot.id,
  scope: pharma(),
  authoredByLabel: 'test',
});
const tender = (over = {}) => ({
  label: 'The tender did not draw',
  source: { kind: 'OUTCOME_REVIEW', ref: g.hindsightReviewId },
  override: { overrideType: 'VALUE_OVERRIDE', targetNodeId: s.nodeIds.oppProbNext, operation: 'SET', value: '0', unit: 'ratio', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'The review disproved it.', confidence: 0.9 },
  exogeneity: 'The customer\'s decision, not ours to affect by how we allocated.',
  ...over,
});
const open = async (over = {}) => unwrap(await s.counterfactual.openCase(s.scope, { ...base(), carriesClasses: ['COMMERCIAL_CONFIDENTIAL'], ...over }), 'open');

describe('a counterfactual is anchored to the past', () => {
  it('needs an anchor: today\'s state is never one', async () => {
    const r = await s.counterfactual.openCase(s.scope, { ...base(), anchorSnapshotId: null });
    assert.equal(expectFail(r, 'unanchored').code, 'counterfactual.unanchored');
  });

  it('refuses a snapshot recorded after the decision boundary, whichever it is', async () => {
    for (const snap of [s.story.S1a, s.story.S1, s.story.S2]) {
      const r = await s.counterfactual.openCase(s.scope, { ...base(), anchorSnapshotId: snap.snapshot.id });
      assert.equal(expectFail(r, snap.snapshot.spec.label).code, 'counterfactual.hindsight_as_anchor');
    }
  });

  it('a decision that does not exist, or was never committed, is not reviewed', async () => {
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), decisionId: 'no-such-decision' }), 'unknown decision').code, 'counterfactual.not_found');
  });
});

describe('the intervention is explicit and differs from what was chosen', () => {
  it('management\'s own choice is not an intervention; an alternative the decision never recorded does not exist', async () => {
    const same = await s.counterfactual.openCase(s.scope, { ...base(), intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.reallocate.id } });
    assert.equal(expectFail(same, 'the chosen alternative').code, 'counterfactual.not_an_intervention');
    const ghost = await s.counterfactual.openCase(s.scope, { ...base(), intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: 'no-such-alternative' } });
    assert.equal(expectFail(ghost, 'an unrecorded alternative').code, 'counterfactual.not_found');
  });

  it('HELM proposes none: no intervention, no overrides, or an override with no reason is refused', async () => {
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), intervention: undefined }), 'no intervention').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), intervention: { kind: 'OVERRIDES', label: 'nothing', overrides: [] } }), 'no overrides').code, 'counterfactual.invalid_input');
    const noReason = { kind: 'OVERRIDES', label: 'unexplained', overrides: [{ overrideType: 'VALUE_OVERRIDE', targetNodeId: s.nodeIds.availOwn, operation: 'ADD', value: '1', unit: 'units', provenanceKind: 'MANAGEMENT_ASSUMPTION', rationale: '' }] };
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), intervention: noReason }), 'no reason').code, 'counterfactual.invalid_input');
  });

  it('is scoped — nothing is global by default — titled, authored, and opened by a member', async () => {
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), scope: { kind: 'ANCHORED', anchors: [] } }), 'unscoped').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), scope: { kind: 'ENTERPRISE_WIDE', justification: 'yes' } }), 'unjustified').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), question: '  ' }), 'no question').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.openCase(s.scope, { ...base(), carriesClasses: ['NOT_A_CLASS'] }), 'unknown class').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.openCase({ ...s.scope, role: 'viewer' }, base()), 'a viewer').code, 'counterfactual.forbidden');
  });
});

describe('hindsight brings information, never the state the decision produced', () => {
  it('needs at least one input — without it, WITH_HINDSIGHT would be AS_KNOWN_THEN renamed', async () => {
    const c = await open();
    const r = await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [] });
    assert.equal(expectFail(r, 'no inputs').code, 'counterfactual.no_hindsight_inputs');
  });

  it('every input says why it is news about the world and not a consequence of the choice', async () => {
    const c = await open();
    const r = await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [tender({ exogeneity: 'no' })] });
    assert.match(expectFail(r, 'no exogeneity').message, /state why this is news about the world/);
  });

  it('a fact that was knowable at the boundary belongs in AS_KNOWN_THEN; one learned in the future was not learned', async () => {
    const c = await open();
    const early = tender({ source: { kind: 'EXTERNAL_RECORD', ref: 'a quote', learnedAt: '2026-09-20T00:00:00.000Z' } });
    assert.equal(expectFail(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [early] }), 'knowable').code, 'counterfactual.not_hindsight');
    const future = tender({ source: { kind: 'EXTERNAL_RECORD', ref: 'a quote', learnedAt: '2099-01-01T00:00:00.000Z' } });
    assert.match(expectFail(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [future] }), 'future').message, /cannot have been learned in the future/);
    const ghost = tender({ source: { kind: 'OUTCOME_REVIEW', ref: 'no-such-review' } });
    assert.equal(expectFail(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [ghost] }), 'unknown review').code, 'counterfactual.not_found');
  });

  it('a value the CHOSEN alternative set is a consequence of the choice: the freight cost and the distributor stock are refused', async () => {
    const c = await open();
    for (const node of ['freightOpex', 'availDist', 'availOwn']) {
      const consequence = tender({ override: { ...tender().override, targetNodeId: s.nodeIds[node], unit: node === 'freightOpex' ? 'currency' : 'units', currency: node === 'freightOpex' ? 'VND' : null } });
      const r = await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [consequence] });
      assert.equal(expectFail(r, node).code, 'counterfactual.hindsight_is_consequence', node);
      assert.match(r.error.message, /consequence of the actual choice, not news about the world/);
    }
  });

  it('for an alternative that was never modelled, hindsight cannot repair it: NOT_ESTIMABLE', async () => {
    const c = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.replace.id } });
    const w = unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [tender()] }), 'not estimable');
    assert.equal(w.world.estimability, 'NOT_ESTIMABLE');
    assert.equal(w.world.hindsightInputs.length, 1);
  });
});

describe('what a case may reveal', () => {
  it('an estimate that would move an input of a class the case does not carry is refused, and the scenario it began is archived, not left as a draft', async () => {
    const plain = await open({ carriesClasses: [], intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id } });
    const r = await s.counterfactual.estimate(s.scope, plain.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [tender()] });
    assert.equal(expectFail(r, 'class exceeds case').code, 'counterfactual.class_exceeds_case');
    const mine = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios').filter((x) => x.key.startsWith(`cf-${plain.case.id}-`));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'ARCHIVED', 'the abandoned scenario is archived');
    assert.equal(unwrap(await s.counterfactualStore.listWorlds(s.scope, plain.case.id), 'worlds').length, 0, 'the refused world left nothing behind');
    // A second, legal attempt is not blocked by the first one\'s scenario key.
    const legal = tender({ label: 'Supplier A\'s air lead time', source: { kind: 'EXTERNAL_RECORD', ref: 'Supplier A performance review', learnedAt: '2027-02-01T00:00:00.000Z' }, override: { overrideType: 'ASSUMPTION_OVERRIDE', targetNodeId: s.nodeIds.leadTime, operation: 'SET', value: '9', unit: 'days', provenanceKind: 'EXTERNAL_SIGNAL', rationale: 'Its performance review.', confidence: 0.8 } });
    const ok2 = unwrap(await s.counterfactual.estimate(s.scope, plain.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [legal] }), 'legal attempt');
    assert.equal(ok2.world.estimability, 'ESTIMATED');
  });
});

describe('an alternative that itself moves a class the case does not carry cannot be estimated by that case', () => {
  it('the delay alternative moves the value of the tender: without declaring COMMERCIAL_CONFIDENTIAL the case cannot show it', async () => {
    const plain = await open({ carriesClasses: [], intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id } });
    const r = await s.counterfactual.estimate(s.scope, plain.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' });
    assert.equal(expectFail(r, 'delay without the class').code, 'counterfactual.class_exceeds_case');
    const declared = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id } });
    const w = unwrap(await s.counterfactual.estimate(s.scope, declared.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'declared');
    assert.equal(w.world.estimability, 'ESTIMATED');
  });
});

describe('worlds are appended, never rewritten', () => {
  it('a second estimate is a new world; both are known, the latest of each lens is the current reading, and the earlier one stays readable at its own lens', async () => {
    const c = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.alternativeProduct.id } });
    const first = unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'first');
    const between = s.clock.now().toISOString();
    const second = unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'second');
    assert.notEqual(first.world.id, second.world.id);
    assert.equal(first.world.fingerprint, second.world.fingerprint, 'the same question over the same run is the same world');
    const now = unwrap(await s.counterfactual.getCase(s.scope, c.case.id), 'now');
    assert.equal(now.history.length, 2);
    assert.equal(now.worlds.asKnownThen.world.id, second.world.id);
    const then = unwrap(await s.counterfactual.getCase(s.scope, c.case.id, at(between)), 'then');
    assert.equal(then.history.length, 1);
    assert.equal(then.worlds.asKnownThen.world.id, first.world.id);
  });

  it('records are frozen: neither a case nor a world can be edited', () => {
    assert.ok(Object.isFrozen(g.cases.CF1.case));
    assert.ok(Object.isFrozen(g.worlds.cf1Then.world));
    assert.ok(Object.isFrozen(g.worlds.cf1Then.world.readings[0]));
  });

  it('an AS_KNOWN_THEN world over a bound alternative creates no scenario: it reads the run computed when the decision was made', async () => {
    const before = unwrap(await s.scenarios.listScenarios(s.scope), 'before').length;
    const c = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.delay.id } });
    const w = unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'then');
    assert.equal(w.world.origin, 'BOUND_TO_DECISION');
    assert.equal(w.world.scenario.runId, alts.delay.scenarioRunId);
    assert.equal(unwrap(await s.scenarios.listScenarios(s.scope), 'after').length, before, 'no scenario was created');
  });
});

describe('a review is a person\'s reading, of something', () => {
  it('needs a world to read, a reading, its limitations and a name', async () => {
    const c = await open();
    assert.equal(expectFail(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: 's', limitations: 'l', reviewedByLabel: 'r' }), 'nothing yet').code, 'counterfactual.nothing_to_review');
    unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'world');
    assert.match(expectFail(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: 's', limitations: '', reviewedByLabel: 'r' }), 'no limitations').message, /limitations.*not optional/);
    assert.equal(expectFail(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: '', limitations: 'l', reviewedByLabel: 'r' }), 'no reading').code, 'counterfactual.invalid_input');
    assert.equal(expectFail(await s.counterfactual.recordReview({ ...s.scope, role: 'viewer' }, c.case.id, { statement: 's', limitations: 'l', reviewedByLabel: 'r' }), 'a viewer').code, 'counterfactual.forbidden');
    const reviewed = unwrap(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: 's', limitations: 'l', reviewedByLabel: 'r' }), 'review');
    assert.equal(reviewed.status, 'REVIEWED');
  });

  it('a new world after the review is a different comparison: the review stays pinned to the one it read', async () => {
    const c = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id } });
    unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'then');
    const reviewed = unwrap(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: 'Read as known then.', limitations: 'One world.', reviewedByLabel: 'r' }), 'review');
    const pinned = reviewed.reviews[0].comparisonFingerprint;
    unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [tender()] }), 'hindsight');
    const after = unwrap(await s.counterfactual.compare(s.scope, c.case.id), 'compare');
    assert.notEqual(after.fingerprint, pinned, 'a new world is a new comparison');
    assert.equal(unwrap(await s.counterfactual.getCase(s.scope, c.case.id), 'case').reviews[0].comparisonFingerprint, pinned, 'the review is unchanged');
  });
});

describe('computing a world writes nothing below except labelled scenarios', () => {
  const kernel = async () => {
    const decisions = unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions');
    const parts = [];
    for (const d of decisions) {
      const commitments = unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'commitments').map((x) => `${x.id}:${x.fingerprint}`);
      const reviews = unwrap(await s.decisionStore.listOutcomeReviews(s.scope, d.id), 'reviews').map((x) => `${x.id}:${JSON.stringify(x.variances)}`);
      parts.push(`${d.id}:${d.state}|${commitments.join(',')}|${reviews.join(',')}`);
    }
    const snapshots = unwrap(await s.twin.listSnapshots(s.scope), 'snapshots').map((x) => `${x.id}:${x.fingerprint}`).sort();
    const claims = unwrap(await s.causal.listClaims(s.scope), 'claims').map((v) => `${v.claim.id}:${v.revision.revision}:${v.evaluation.status}`).sort();
    const calcs = s.registry.all().map((x) => `${x.key}@${x.version}`).sort();
    // Executing a scenario writes that scenario's own SCENARIO-typed results — as it does for any author. Everything else must not move.
    const obs = [];
    const scenarioObs = [];
    for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) {
      for (const o of unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'obs')) (o.observationType === 'SCENARIO' ? scenarioObs : obs).push(`${o.id}:${o.observationType}:${o.numericValue}`);
    }
    const scenarios = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios');
    const untouched = [];
    for (const sc of scenarios.filter((x) => !x.key.startsWith('cf-'))) {
      const revs = unwrap(await s.scenarios.listRevisions(s.scope, sc.id), 'revisions');
      untouched.push(`${sc.id}:${sc.status}:${revs.map((r) => r.id).join(',')}`);
    }
    return { fixed: JSON.stringify({ parts, snapshots, claims, calcs, obs: obs.sort(), untouched: untouched.sort() }), scenarioObs };
  };

  it('decisions, commitments, reviews, snapshots, causal claims, formulas, observations and every non-counterfactual scenario (and its revisions) are byte-identical', async () => {
    const before = await kernel();
    const c = await open({ intervention: { kind: 'CHOOSE_ALTERNATIVE', alternativeId: alts.expedite.id } });
    unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'AS_KNOWN_THEN', byLabel: 't' }), 'then');
    unwrap(await s.counterfactual.estimate(s.scope, c.case.id, { lens: 'WITH_HINDSIGHT', byLabel: 't', hindsight: [tender()] }), 'hindsight');
    unwrap(await s.counterfactual.recordReview(s.scope, c.case.id, { statement: 's', limitations: 'l', reviewedByLabel: 'r' }), 'review');
    const after = await kernel();
    assert.equal(after.fixed, before.fixed);
    assert.ok(before.scenarioObs.every((o) => after.scenarioObs.includes(o)), 'no earlier scenario result moved');
    assert.ok(after.scenarioObs.length > before.scenarioObs.length, 'the new worlds have scenario results of their own');
  });

  it('the scenario it creates is a labelled counterfactual: a child of the alternative\'s scenario, never a baseline, never bound to a decision', async () => {
    const w = g.worlds.cf1Hindsight.world;
    const sc = unwrap(await s.scenarios.getScenario(s.scope, w.scenario.scenarioId), 'scenario');
    assert.match(sc.key, /^cf-.*-hind-/);
    assert.equal(sc.parentScenarioId, alts.expedite.scenarioId);
    assert.deepEqual(sc.metadata.counterfactual, { caseId: g.cases.CF1.case.id, lens: 'WITH_HINDSIGHT', intervention: 'CHOOSE_ALTERNATIVE' });
    const bound = new Set(alts.all.map((a) => a.scenarioId));
    assert.ok(!bound.has(sc.id), 'no decision alternative is bound to it');
    const runs = unwrap(await s.scenarios.listRuns(s.scope, { scenarioId: sc.id }), 'runs');
    assert.ok(runs.every((r) => r.kind !== 'BASELINE' && r.scenarioId === sc.id));
  });

  it('the runtime source calls no write below the scenario runtime, and no rebase or new revision of an alternative\'s own scenario', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'meridianCounterfactual.ts')) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
      assert.doesNotMatch(code, /\.(recordObservation|commit|createCommitment|recordApproval|recordOutcomeReview|createClaim|reviseClaim|recordEvidence|supportClaim|declareGovernanceProfile|appendEvent|setState|saveSnapshot|buildSnapshot|rebase|createRevision|executeBaseline|register\w*|upsertValueNode|appendStep)\s*\(/, `${f} writes below itself`);
    }
  });
});
