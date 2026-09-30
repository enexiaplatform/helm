/**
 * verify:intelligence-grounding — an AI that misbehaves is caught by the runtime, never trusted.
 *
 * Every enterprise statement carries a class and rests on evidence this run's tools returned. Fabricated figures are
 * removed, an unsupported claim is marked as inference, a promoted class is reclassified, a recommendation is removed
 * however it is classed, a suggestion must be a question, a hypothesis a provider states as fact is downgraded, and
 * evidence ids are local to a run. A provider that fails fails the run — and is still audited.
 */

import { adminCaller, buildIntelligence, buildIntelligenceStory, contract, scriptedProvider, unwrap } from './lib/v1Stack.mjs';

const c = contract('verify:intelligence-grounding');
const s = await buildIntelligenceStory();
const run = async (draft, params = { decisionId: s.story.decisionId }, task = 'SUMMARIZE_ASSUMPTIONS') => {
  const b = buildIntelligence(s, scriptedProvider(draft));
  return unwrap(await b.intelligence.run(s.scope, adminCaller(), { task, params }), 'answer');
};

const fabricated = await run((input) => ({
  statements: [
    { text: 'The Rohto margin will be 44.4% next quarter.', class: 'MODEL_RESULT', evidenceIds: [input.evidence[0].id] },
    { text: input.evidence[0].label, class: input.evidence[0].kind, evidenceIds: [input.evidence[0].id] },
  ],
}));
c.check('fabricated-figure', fabricated.statements.length === 1 && fabricated.grounding.removed === 1 && /44\.4.*fabricated/.test(fabricated.grounding.removals[0].reason), 'a figure that is in no cited evidence survived');

const unsupported = await run({ statements: [{ text: 'Distributor D is likely to default.', class: 'MANAGEMENT_RECORD', evidenceIds: [] }] });
c.check('unsupported', unsupported.statements[0].class === 'AI_INFERENCE' && unsupported.statements[0].qualified === true, 'an unsupported claim about the enterprise was passed as a record');

const recommend = await run({
  statements: [
    { text: 'Management should approve alternative A.', class: 'SUGGESTION', evidenceIds: [] },
    { text: 'The best option is to expedite.', class: 'AI_INFERENCE', evidenceIds: [] },
    { text: 'Approve it now.', class: 'SUGGESTION', evidenceIds: [] },
    { text: 'What would change the tender assumption?', class: 'SUGGESTION', evidenceIds: [] },
  ],
});
c.check('no-recommendation', JSON.stringify(recommend.statements.map((x) => x.text)) === JSON.stringify(['What would change the tender assumption?']) && recommend.grounding.removed === 3, 'a recommendation survived, or a question did not');

const borrowed = await run({ statements: [{ text: 'It is confirmed.', class: 'MANAGEMENT_ASSUMPTION', evidenceIds: ['ev-999', 'ev-1'] }] });
c.check('run-local-ids', borrowed.statements[0].class === 'AI_INFERENCE', 'a claim resting on evidence ids that are not this run\'s was accepted as grounded');

const hypothesis = buildIntelligence(s, scriptedProvider((input) => {
  const claim = input.evidence.find((e) => e.kind === 'CAUSAL_CLAIM' && e.status !== 'SUPPORTED');
  return { statements: claim ? [{ text: `It is established that ${claim.label.toLowerCase().replace(/\.$/, '')}.`, class: 'CAUSAL_CLAIM', evidenceIds: [claim.id] }] : [] };
}));
const h = unwrap(await hypothesis.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_CAUSAL_EVIDENCE', params: {} }), 'answer');
c.check('hypothesis-stays', h.statements.length === 1 && h.statements[0].class === 'AI_INFERENCE' && /keeps the status its evidence carries/.test(h.statements[0].note), 'a hypothesis stated as fact was passed through: the AI rewrote a causal claim');

const failing = buildIntelligence(s, scriptedProvider(() => { throw new Error('upstream unavailable'); }));
const failed = await failing.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_ASSUMPTIONS', params: { decisionId: s.story.decisionId } });
const audited = unwrap(await failing.aiStore.listRuns(s.scope), 'runs');
c.check('provider-failure', failed.ok === false && failed.error.code === 'intelligence.provider_failed' && audited.length === 1 && /provider failed/.test(audited[0].output.unknowns[0]), 'a failing provider produced an answer or was not audited');

const trace = buildIntelligence(s, scriptedProvider(() => ({ statements: [{ text: 'HELM has nothing to say.', class: 'UNKNOWN', evidenceIds: [] }], questions: [], unknowns: [], reasoning: 'SECRET CHAIN OF THOUGHT', thoughts: ['x'] })));
const traced = unwrap(await trace.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_CAUSAL_EVIDENCE', params: {} }), 'answer');
const stored = unwrap(await trace.aiStore.getRun(s.scope, traced.runId), 'run');
c.check('no-reasoning-trace', !/SECRET CHAIN OF THOUGHT|reasoning|thoughts/.test(JSON.stringify(stored)) && !/SECRET CHAIN OF THOUGHT/.test(JSON.stringify(traced)), 'a reasoning trace was stored or returned');

// Real answers: grounded, classed by what they are, never a source fact from a model result.
const twin = unwrap(await buildIntelligence(s).intelligence.run(s.scope, adminCaller(), { task: 'EXPLAIN_TWIN_CHANGE', params: { fromId: s.story.S1.snapshot.id, toId: s.story.S2.snapshot.id } }), 'twin change');
const ids = new Set(twin.evidence.map((e) => e.id));
c.check('grounded', twin.statements.length > 0 && twin.grounding.removed === 0 && twin.statements.every((st) => st.evidenceIds.every((id) => ids.has(id)) && (st.evidenceIds.length > 0 || ['UNKNOWN', 'AI_INFERENCE', 'SUGGESTION'].includes(st.class))), 'a statement of the reference provider is not grounded in this run\'s evidence');
c.check('source-vs-model', twin.evidence.some((e) => e.kind === 'SOURCE_FACT') && twin.evidence.some((e) => e.kind === 'MODEL_RESULT') && twin.statements.every((st) => {
  const kinds = new Set(st.evidenceIds.map((id) => twin.evidence.find((e) => e.id === id).kind));
  return (st.class !== 'SOURCE_FACT' || (kinds.size === 1 && kinds.has('SOURCE_FACT'))) && (kinds.size !== 1 || st.class === 'AI_INFERENCE' || st.class === [...kinds][0]);
}), 'a model result was stated as a source fact, or the reverse');
c.check('not-truth', /not enterprise truth/.test(twin.notice), 'the answer does not say it is interpretation, not enterprise truth');
const cf = unwrap(await buildIntelligence(s).intelligence.run(s.scope, adminCaller(), { task: 'EXPLAIN_COUNTERFACTUAL', params: { caseId: s.counterfactualStory.cases.CF1.case.id } }), 'counterfactual');
c.check('counterfactual-is-an-estimate', cf.statements.filter((st) => st.class === 'COUNTERFACTUAL_RESULT').length > 0 && cf.notes.some((n) => /not what would have happened|not a verdict/.test(n)), 'a counterfactual was explained as what would have happened');
const decision = unwrap(await buildIntelligence(s).intelligence.run(s.scope, adminCaller(), { task: 'EXPLAIN_DECISION', params: { decisionId: s.story.decisionId } }), 'decision');
c.check('no-verdict-on-decision', !/good decision|bad decision|wrong call|mistake/i.test(JSON.stringify(decision.statements)), 'the explanation of a decision passed a verdict on it');

c.finish('fabricated figures removed, unsupported claims become inference, recommendations removed however classed, ids are run-local, a hypothesis stays a hypothesis, a failing provider is audited, no reasoning trace, answers grounded and classed by what they are');
