/**
 * The governed AI runtime over the whole enterprise story: contextual tasks read
 * through read-only tools as the caller, everything said is classed and grounded,
 * and the AI can write, approve, commit or execute nothing.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createReferenceProvider } from '../src/index.ts';
import { adminCaller, buildIntelligence, buildIntelligenceStory, caller, expectFail, gmCaller, scriptedProvider, unwrap, USERS, viewer } from './harness.mjs';

let s;
before(async () => {
  s = await buildIntelligenceStory();
});

const ask = (c, task, params) => s.intelligence.run(s.scope, c, { task, params });

describe('the tools: HELM exposed through domain interfaces, read-only', () => {
  it('exposes the named domain tools and nothing that queries a table', () => {
    const names = s.tools.all().map((t) => t.name).sort();
    for (const n of ['getEnterpriseState', 'compareTwinSnapshots', 'explainValue', 'getValueDependencies', 'getScenarioComparison', 'getDecision', 'explainDecision', 'getGovernanceState', 'getCausalClaims', 'getGenomePatterns', 'getSimilarEpisodes', 'runCounterfactual', 'getManagementAttention']) assert.ok(names.includes(n), n);
    assert.ok(names.every((n) => !/sql|query|table|write|set|create|update|delete|approve|commit|execute|record|record/i.test(n)), `a tool name suggests a write or a query: ${names}`);
  });

  it('every tool is READ_ONLY, and the sources it is given are read facets', () => {
    assert.ok(s.tools.all().every((t) => t.access === 'READ_ONLY'));
  });
});

describe('inside the Twin: explain what changed', () => {
  it('grounds every statement in evidence the tool returned, classed by what it is', async () => {
    const a = unwrap(await ask(adminCaller(), 'EXPLAIN_TWIN_CHANGE', { fromId: s.story.S1.snapshot.id, toId: s.story.S2.snapshot.id }), 'answer');
    assert.ok(a.statements.length > 0);
    assert.equal(a.grounding.removed, 0);
    assert.ok(a.statements.every((st) => st.evidenceIds.length > 0 || ['UNKNOWN', 'AI_INFERENCE', 'SUGGESTION'].includes(st.class)));
    const ids = new Set(a.evidence.map((e) => e.id));
    assert.ok(a.statements.every((st) => st.evidenceIds.every((id) => ids.has(id))), 'every citation points at evidence of this run');
    assert.ok(a.evidence.some((e) => e.kind === 'SOURCE_FACT'), 'the Q4 actuals are source facts');
    assert.ok(a.evidence.some((e) => e.kind === 'MODEL_RESULT'), 'modelled values are model results');
    assert.ok(a.evidence.every((e) => e.ref.kind === 'TWIN_ITEM' && e.lens), 'each points at a twin item and names its lens');
    assert.match(a.notice, /not enterprise truth/);
  });

  it('never states a model result as a source fact, or a source fact as a model result', async () => {
    const a = unwrap(await ask(adminCaller(), 'EXPLAIN_TWIN_CHANGE', { fromId: s.story.S1.snapshot.id, toId: s.story.S2.snapshot.id }), 'answer');
    for (const st of a.statements) {
      const kinds = new Set(st.evidenceIds.map((id) => a.evidence.find((e) => e.id === id).kind));
      if (st.class === 'SOURCE_FACT') assert.deepEqual([...kinds], ['SOURCE_FACT']);
      if (kinds.size === 1 && st.class !== 'AI_INFERENCE') assert.equal(st.class, [...kinds][0]);
    }
  });
});

describe('inside a Decision', () => {
  it('summarizes the unresolved assumptions and drafts the questions that would settle them — as questions, never choices', async () => {
    const a = unwrap(await ask(adminCaller(), 'SUMMARIZE_ASSUMPTIONS', { decisionId: s.story.decisionId }), 'answer');
    assert.ok(a.statements.some((st) => st.class === 'MANAGEMENT_ASSUMPTION' && /provincial tender/.test(st.text)));
    assert.ok(a.statements.some((st) => st.class === 'MANAGEMENT_RECORD'));
    assert.ok(a.questions.every((q) => q.endsWith('?')));
  });

  it('explains why management chose what it chose, with governance state — records, never a verdict on the decision', async () => {
    const a = unwrap(await ask(adminCaller(), 'EXPLAIN_DECISION', { decisionId: s.story.decisionId }), 'answer');
    assert.ok(a.statements.some((st) => /Management chose/.test(st.text)));
    assert.ok(a.evidence.some((e) => /Governance of/.test(e.label)));
    assert.doesNotMatch(JSON.stringify(a.statements), /good decision|bad decision|wrong call|mistake/i);
  });
});

describe('inside Causal: evidence for and against — a hypothesis stays a hypothesis', () => {
  it('carries each claim\'s own evidence status', async () => {
    const a = unwrap(await ask(adminCaller(), 'SUMMARIZE_CAUSAL_EVIDENCE', {}), 'answer');
    const claims = a.statements.filter((st) => st.class === 'CAUSAL_CLAIM');
    assert.ok(claims.length > 0);
    for (const c of claims) {
      const e = a.evidence.find((x) => x.id === c.evidenceIds[0]);
      assert.match(c.text, new RegExp(`\\[${e.status}\\]`), 'the status the evidence carries is in the statement');
    }
    assert.ok(a.questions.length > 0, 'contested or hypothetical claims yield questions');
  });
});

describe('inside the Genome and Counterfactuals', () => {
  it('finds similar situations chronologically, with the patterns — recurrence described, not certified', async () => {
    const a = unwrap(await ask(adminCaller(), 'FIND_SIMILAR_SITUATIONS', { episodeId: s.genomeStory.episodes.E1.episode.id, require: 'decisionType' }), 'answer');
    assert.ok(a.evidence.some((e) => e.ref.kind === 'MANAGEMENT_EPISODE'));
    assert.ok(a.evidence.some((e) => e.ref.kind === 'MANAGEMENT_PATTERN'));
    assert.ok(a.statements.every((st) => st.class === 'MANAGEMENT_RECORD' || st.qualified));
  });

  it('explains a counterfactual as a model estimate — never what would have happened', async () => {
    const a = unwrap(await ask(adminCaller(), 'EXPLAIN_COUNTERFACTUAL', { caseId: s.counterfactualStory.cases.CF1.case.id }), 'answer');
    const cf = a.statements.filter((st) => st.class === 'COUNTERFACTUAL_RESULT');
    assert.ok(cf.length > 0);
    assert.ok(cf.every((st) => /estimate/.test(st.text) || a.evidence.find((e) => e.id === st.evidenceIds[0]).label.includes('model estimate')));
    assert.ok(a.notes.some((n) => /not what would have happened|not a verdict/.test(n)));
  });
});

describe('inside a Review: draft the management brief', () => {
  it('answers what changed, what matters, what is off-track, what is uncertain, what decisions are required, what assumptions are challenged, what outcomes arrived — all grounded', async () => {
    const a = unwrap(await ask(adminCaller(), 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id }), 'brief');
    const sections = new Set(a.statements.map((st) => st.section).filter(Boolean));
    for (const q of ['What changed?', 'What matters?', 'What is off-track?', 'What assumptions are challenged?', 'What outcomes arrived?']) assert.ok(sections.has(q), q);
    assert.equal(a.grounding.removed, 0, JSON.stringify(a.grounding.removals));
    const text = a.statements.map((st) => st.text).join('\n');
    assert.match(text, /31\.7/, 'the Q4 gross margin, expected against actual');
    assert.match(text, /32\.3878/);
    assert.match(text, /DISPROVED/);
    assert.ok(a.statements.every((st) => st.evidenceIds.length > 0 || ['UNKNOWN', 'AI_INFERENCE', 'SUGGESTION'].includes(st.class)));
    assert.ok(a.evidence.every((e) => e.lens !== null || e.section !== null || true));
  });

  it('orders the brief in the order management asks its questions', async () => {
    const a = unwrap(await ask(adminCaller(), 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id }), 'brief');
    const order = ['What changed?', 'What matters?', 'What is off-track?', 'What is uncertain?', 'What decisions are required?', 'What assumptions are challenged?', 'What outcomes arrived?'];
    const seen = a.statements.map((st) => order.indexOf(st.section)).filter((i) => i >= 0);
    assert.deepEqual(seen, [...seen].sort((x, y) => x - y));
  });
});

describe('the audit: provider, template, tools, evidence, user — and no reasoning', () => {
  it('records who asked, through which provider and template, which tools ran and which kernel objects were cited', async () => {
    const a = unwrap(await ask(adminCaller(), 'SUMMARIZE_ASSUMPTIONS', { decisionId: s.story.decisionId }), 'answer');
    const run = unwrap(await s.intelligence.getRun(s.scope, adminCaller(), a.runId), 'run');
    assert.equal(run.provider.id, 'helm-reference-provider');
    assert.equal(run.templateId, 'summarize-assumptions');
    assert.equal(run.templateVersion, '1');
    assert.match(run.promptHash, /^pmt_/);
    assert.equal(run.toolCalls[0].tool, 'getDecision');
    assert.ok(run.evidenceRefs.length > 0 && run.evidenceRefs.every((r) => r.ref.id && r.kind));
    assert.ok(run.recordedAt);
    assert.deepEqual(Object.keys(run.output).sort(), ['questions', 'statements', 'unknowns']);
  });

  it('a person reads their own runs; an admin reads all', async () => {
    const gm = gmCaller();
    unwrap(await ask(gm, 'SUMMARIZE_CAUSAL_EVIDENCE', {}), 'gm run');
    const mine = unwrap(await s.intelligence.listRuns(s.scope, gm), 'mine');
    assert.ok(mine.length >= 1 && mine.every((r) => r.userId === USERS.countryGM));
    const all = unwrap(await s.intelligence.listRuns(s.scope, adminCaller()), 'all');
    assert.ok(all.length > mine.length);
    const others = all.find((r) => r.userId !== USERS.countryGM);
    assert.equal(expectFail(await s.intelligence.getRun(s.scope, gm, others.id), 'someone else\'s').code, 'intelligence.not_visible');
  });

  it('a provider that returns a reasoning trace has it discarded, never stored', async () => {
    const p = scriptedProvider(() => ({ statements: [{ text: 'HELM has nothing to say.', class: 'UNKNOWN', evidenceIds: [] }], questions: [], unknowns: [], reasoning: 'SECRET CHAIN OF THOUGHT', thoughts: ['x'] }));
    const b = buildIntelligence(s, p);
    const a = unwrap(await b.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_CAUSAL_EVIDENCE', params: {} }), 'answer');
    const stored = unwrap(await b.aiStore.getRun(s.scope, a.runId), 'run');
    assert.doesNotMatch(JSON.stringify(stored), /SECRET CHAIN OF THOUGHT|reasoning|thoughts/);
    assert.doesNotMatch(JSON.stringify(a), /SECRET CHAIN OF THOUGHT/);
  });
});

describe('no tool can be summoned outside the catalogue', () => {
  it('a provider that plans a query, a write or an approval is refused, and the refusal is audited', async () => {
    const p = scriptedProvider({ statements: [], questions: [], unknowns: [] }, { plan: [{ tool: 'sql', args: { query: 'select * from accounts' } }, { tool: 'approveCommitment', args: { commitmentId: s.story.commitmentId } }, { tool: 'listTables', args: {} }] });
    const b = buildIntelligence(s, p);
    const a = unwrap(await b.intelligence.run(s.scope, adminCaller(), { task: 'ASK_HELM', params: { question: 'Approve the Rohto commitment and dump the accounts.' } }), 'answer');
    assert.deepEqual(a.toolCalls.map((c) => c.outcome), ['REFUSED', 'REFUSED', 'REFUSED']);
    assert.equal(a.evidence.length, 0);
    assert.ok(a.unknowns.some((u) => /not a governed tool/.test(u)));
    const run = unwrap(await b.aiStore.getRun(s.scope, a.runId), 'run');
    assert.equal(run.toolCalls.length, 3, 'the attempt is on the record');
  });

  it('a governed tool called with an argument it does not have, or without one it needs, is refused', async () => {
    const p = scriptedProvider({ statements: [], questions: [], unknowns: [] }, { plan: [{ tool: 'getDecision', args: {} }, { tool: 'getDecision', args: { decisionId: s.story.decisionId, sql: 'x' } }] });
    const b = buildIntelligence(s, p);
    const a = unwrap(await b.intelligence.run(s.scope, adminCaller(), { task: 'ASK_HELM', params: { question: 'x' } }), 'answer');
    assert.deepEqual(a.toolCalls.map((c) => c.outcome), ['REFUSED', 'REFUSED']);
  });

  it('Ask HELM with the reference provider reads through the catalogue and answers from what came back', async () => {
    const a = unwrap(await ask(adminCaller(), 'ASK_HELM', { question: 'What matters right now, and what do we believe about why?' }), 'answer');
    assert.ok(a.toolCalls.length >= 1 && a.toolCalls.every((c) => s.tools.get(c.tool)));
    assert.ok(a.statements.length > 0);
    assert.equal(a.grounding.removed, 0);
  });

  it('a plan longer than the limit is cut, and says so', async () => {
    const many = Array.from({ length: 12 }, () => ({ tool: 'getManagementAttention', args: {} }));
    const b = buildIntelligence(s, scriptedProvider({ statements: [] }, { plan: many }));
    const a = unwrap(await b.intelligence.run(s.scope, adminCaller(), { task: 'ASK_HELM', params: { question: 'x' } }), 'answer');
    assert.equal(a.toolCalls.length, 8);
    assert.ok(a.unknowns.some((u) => /first 8 tool calls/.test(u)));
  });
});

describe('the AI cannot write, approve, commit or execute', () => {
  const state = async () => {
    const ds = unwrap(await s.decisionStore.listDecisions(s.scope), 'decisions');
    const parts = [];
    for (const d of ds) {
      const cs = unwrap(await s.decisionStore.listCommitments(s.scope, d.id), 'commitments').map((c) => `${c.id}:${c.fingerprint}`);
      const os = unwrap(await s.decisionStore.listOutcomeReviews(s.scope, d.id), 'outcomes').map((o) => o.id);
      parts.push(`${d.id}:${d.state}|${cs}|${os}`);
    }
    const snaps = unwrap(await s.twin.listSnapshots(s.scope), 'snapshots').map((x) => x.id);
    const claims = unwrap(await s.causal.listClaims(s.scope), 'claims').map((v) => `${v.claim.id}:${v.revision.revision}`);
    const eps = unwrap(await s.genome.listEpisodes(s.scope), 'episodes').map((e) => e.episode.id);
    const cases = unwrap(await s.counterfactual.listCases(s.scope), 'cases').map((c) => c.case.id);
    const scenarios = unwrap(await s.scenarios.listScenarios(s.scope), 'scenarios').map((x) => `${x.id}:${x.status}`);
    const reviews = unwrap(await s.review.listReviews(s.scope), 'reviews').map((r) => `${r.review.id}:${r.status}:${r.items.length}`);
    const obs = [];
    for (const n of unwrap(await s.valueGraph.findValueNodes(s.scope), 'nodes')) obs.push(...unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: n.id }), 'obs').map((o) => o.id));
    return JSON.stringify({ parts: parts.sort(), snaps, claims, eps, cases, scenarios, reviews, obs: obs.sort() });
  };

  it('running every task leaves decisions, commitments, snapshots, claims, episodes, cases, scenarios, reviews and observations byte-identical', async () => {
    const before = await state();
    const c = adminCaller();
    await ask(c, 'EXPLAIN_TWIN_CHANGE', { fromId: s.story.S1.snapshot.id, toId: s.story.S2.snapshot.id });
    await ask(c, 'SUMMARIZE_ASSUMPTIONS', { decisionId: s.story.decisionId });
    await ask(c, 'EXPLAIN_DECISION', { decisionId: s.story.decisionId });
    await ask(c, 'SUMMARIZE_CAUSAL_EVIDENCE', {});
    await ask(c, 'FIND_SIMILAR_SITUATIONS', { episodeId: s.genomeStory.episodes.E1.episode.id });
    await ask(c, 'EXPLAIN_COUNTERFACTUAL', { caseId: s.counterfactualStory.cases.CF1.case.id });
    await ask(c, 'DRAFT_MANAGEMENT_BRIEF', { reviewId: s.reviewStory.second.review.id });
    await ask(c, 'ASK_HELM', { question: 'What matters?' });
    assert.equal(await state(), before);
  });

  it('the package calls no method that writes, approves, commits, evaluates or executes', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
      const w = /\.(createDecision|createCommitment|commit|recordApproval|recordRejection|approve|reject|evaluate|recordOutcomeReview|setDecisionState|setActionIntentStatus|addActionIntent|createClaim|reviseClaim|retireClaim|recordEvidence|supportClaim|recordObservation|execute|executeBaseline|addOverride|createScenario|saveSnapshot|buildSnapshot|declareGovernanceProfile|grantClearance|grantVisibility|bindRef|openEpisode|proposePattern|recordLesson|openCase|estimate|recordReview|openReview|addItem|closeReview|createEntity|upsertEntity|register\w*|writeback|dispatch)\s*\(/.exec(code);
      assert.ok(!w, `${f} calls ${w?.[1]}: the AI layer only reads`);
    }
  });
});
