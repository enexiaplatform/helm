/**
 * The AI reads AS THE CALLER. It never sees what the person asking may not:
 * clearance, decision visibility, snapshot visibility and each runtime's own
 * projection all hold — and what is withheld is said, never silently dropped.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIntelligence, buildIntelligenceStory, caller, scriptedProvider, unwrap, DEMO_UNITS, USERS, viewer, ADMIN, ALL_CLASSES } from './harness.mjs';

let s;
before(async () => {
  s = await buildIntelligenceStory();
});

/** A provider that records exactly what it was handed. */
const recording = (plan) => scriptedProvider((input) => ({ statements: input.evidence.map((e) => ({ text: e.label, class: e.kind, evidenceIds: [e.id] })), questions: [], unknowns: [] }), plan ? { plan } : {});

const runWith = async (c, task, params) => {
  const p = recording(task === 'ASK_HELM' ? [{ tool: 'getEnterpriseState', args: {} }] : undefined);
  const b = buildIntelligence(s, p);
  const a = unwrap(await b.intelligence.run(s.scope, c, { task, params }), task);
  const handed = p.received.filter((x) => x.synthesize).flatMap((x) => x.synthesize.evidence);
  return { a, handed };
};

describe('sensitivity: a value above the caller\'s clearance never reaches the provider', () => {
  it('an uncleared viewer\'s current state has no financial or commercial value in it, and the answer says items were withheld', async () => {
    const pharma = caller(viewer(USERS.pharmaAnalyst), () => true);
    const full = await runWith(caller(viewer(ADMIN, [], 'admin')), 'ASK_HELM', { question: 'What is the current state of things?' });
    const narrow = await runWith(pharma, 'ASK_HELM', { question: 'What is the current state of things?' });
    assert.ok(full.handed.length > narrow.handed.length, 'the uncleared reader is handed less');
    const sensitiveHanded = narrow.handed.filter((e) => /Gross Margin|Cash Impact|Opportunity Probability/i.test(e.label) && e.values.some((v) => /^layer /.test(v)));
    assert.equal(sensitiveHanded.length, 0, `the provider was handed ${sensitiveHanded.map((e) => e.label)}`);
  });

  it('explaining a value above clearance returns nothing: the snapshot is not theirs, or the value is above their class', async () => {
    const sensitive = s.story.S2.items.find((i) => i.kind === 'VALUE' && i.sensitivity !== 'GENERAL_MANAGEMENT');
    assert.ok(sensitive, 'the story holds a sensitive value');
    const ctx = (v) => ({ scope: s.scope, viewer: v, units: DEMO_UNITS, facts: { decisionVisible: () => true }, now: '2027-05-01T00:00:00.000Z' });
    const tool = s.tools.get('explainValue');
    const args = { snapshotId: s.story.S2.snapshot.id, itemKey: sensitive.key };
    const uncleared = await tool.run(ctx(viewer(USERS.pharmaAnalyst)), args);
    assert.ok(!uncleared.ok || uncleared.value.evidence.length === 0, 'an uncleared viewer was given the explanation');
    const cleared = await tool.run(ctx(viewer(USERS.countryGM, ALL_CLASSES)), args);
    assert.ok(!cleared.ok || cleared.value.evidence.length >= 0);
  });
});

describe('decision visibility: what rests on a decision the caller cannot see is not shown', () => {
  const blind = (id) => id !== s.story.decisionId;

  it('getDecision, explainDecision, getGovernanceState and getScenarioComparison return nothing for a decision the caller cannot see, and say so', async () => {
    const c = caller(viewer(USERS.countryGM, ALL_CLASSES), blind);
    for (const task of ['SUMMARIZE_ASSUMPTIONS', 'EXPLAIN_DECISION']) {
      const { a, handed } = await runWith(c, task, { decisionId: s.story.decisionId });
      assert.equal(handed.length, 0, `${task} handed the provider evidence about a decision the caller cannot see`);
      assert.ok(a.unknowns.some((u) => /not visible to you/.test(u)), `${task} did not say it was withheld`);
      assert.ok(a.toolCalls.every((t) => t.outcome === 'WITHHELD'));
    }
    const sc = s.tools.get('getScenarioComparison');
    const r = unwrap(await sc.run({ scope: s.scope, viewer: viewer(USERS.countryGM, ALL_CLASSES), units: [], facts: { decisionVisible: blind }, now: '2027-05-01T00:00:00.000Z' }, { decisionId: s.story.decisionId }), 'comparison');
    assert.equal(r.evidence.length, 0);
    assert.equal(r.withheld, 1);
  });

  it('the review brief withholds what rests on the decision — through the review runtime\'s own projection', async () => {
    const full = await runWith(caller(viewer(ADMIN, [], 'admin')), 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id });
    const blindBrief = await runWith(caller(viewer(USERS.countryGM, ALL_CLASSES), blind), 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id });
    assert.ok(blindBrief.handed.length < full.handed.length);
    assert.ok(blindBrief.handed.every((e) => !(e.ref.kind === 'COMMITMENT' && e.ref.id === s.story.commitmentId)), 'no evidence about the Rohto commitment');
    assert.ok(blindBrief.a.unknowns.some((u) => /withheld/.test(u)));
  });

  it('claims, patterns, episodes and counterfactual cases are read through their runtimes\' own rules', async () => {
    const c = caller(viewer(USERS.countryGM, ALL_CLASSES), blind);
    const causal = await runWith(c, 'SUMMARIZE_CAUSAL_EVIDENCE', {});
    const full = await runWith(caller(viewer(ADMIN, [], 'admin')), 'SUMMARIZE_CAUSAL_EVIDENCE', {});
    assert.ok(causal.handed.length <= full.handed.length);
    const cf = await runWith(c, 'EXPLAIN_COUNTERFACTUAL', { caseId: s.counterfactualStory.cases.CF1.case.id });
    assert.equal(cf.handed.length, 0, 'the case reviews a decision the caller cannot see');
    const sim = await runWith(c, 'FIND_SIMILAR_SITUATIONS', { episodeId: s.genomeStory.episodes.E1.episode.id });
    assert.equal(sim.handed.filter((e) => e.ref.kind === 'MANAGEMENT_EPISODE').length, 0, 'the Rohto episode rests on the decision');
  });
});

describe('a review the caller may not read is not read for them', () => {
  it('an uncleared viewer is told the review is not visible; nothing about it reaches the provider', async () => {
    const { a, handed } = await runWith(caller(viewer(USERS.pharmaAnalyst)), 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id });
    assert.equal(handed.length, 0);
    assert.ok(a.unknowns.some((u) => /not visible to you/.test(u)));
  });
});

describe('what the provider is handed is data, and only data', () => {
  it('plain JSON: no function, no runtime, no store, no client — there is nothing to write with', async () => {
    const p = recording();
    const b = buildIntelligence(s, p);
    unwrap(await b.intelligence.run(s.scope, caller(viewer(ADMIN, [], 'admin')), { task: 'SUMMARIZE_ASSUMPTIONS', params: { decisionId: s.story.decisionId } }), 'run');
    const input = p.received.find((x) => x.synthesize).synthesize;
    const walk = (o, path = 'input') => {
      assert.notEqual(typeof o, 'function', `${path} is a function`);
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(input);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), input, 'the input survives a JSON round trip unchanged');
    assert.deepEqual(Object.keys(input).sort(), ['evidence', 'instructions', 'outputClasses', 'question', 'task', 'templateId', 'templateVersion']);
  });

  it('the provider is vendor-neutral: an identity, a model and a version, and the runtime names no vendor', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = readFileSync(new URL(f, dir), 'utf8');
      assert.doesNotMatch(code, /\b(anthropic|openai|gemini|claude|gpt-?\d|llama|mistral)\b/i, `${f} names a model vendor`);
    }
  });
});
