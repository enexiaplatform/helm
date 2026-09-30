/**
 * verify:council — perspectives over ONE enterprise truth; an Agent Perspective is not Decision Authority.
 *
 *   - perspectives exist only where HELM holds data (People is reported as not instantiated, never spoken for);
 *   - the evidence is gathered once, as the caller, and every perspective cites only that pool;
 *   - every perspective returns the same structure, grounded against its own evidence subset;
 *   - disagreement is preserved as a fact about the alternatives — gains and concessions side by side, nothing netted;
 *   - there is no consensus, vote, score, rank, weight, preference or recommendation, at any depth, and the
 *     orchestrator has one method that opens a council;
 *   - a council leaves every kernel record byte-identical; each perspective and the orchestrator are audited;
 *   - the council is handed what the caller may see, and a misbehaving perspective is held to the same grounding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { PERSPECTIVES, relevantTo } from '../packages/agent-runtime/src/index.ts';
import { ALL_CLASSES, USERS, adminCaller, buildCouncil, buildCouncilStory, caller, contract, expectFail, scriptedProvider, unwrap, viewer } from './lib/v1Stack.mjs';

const c = contract('verify:council');
const s = await buildCouncilStory();
const question = 'Should the Rohto allocation be reconsidered given what has happened?';
const council = unwrap(await s.council.convene(s.scope, adminCaller(), { question, decisionId: s.story.decisionId, reviewId: s.reviewStory.second.review.id }), 'council');

// Only where HELM has data.
const people = council.notInstantiated.find((n) => n.perspective === 'PEOPLE');
c.check('people', !!people && /no people data/.test(people.reason) && /never scores or ranks a person/.test(people.reason) && !council.perspectives.some((p) => p.perspective === 'PEOPLE'), 'People was spoken for, or not reported as not instantiated');
const accounted = new Set([...council.perspectives.map((p) => p.perspective), ...council.notInstantiated.map((n) => n.perspective), ...council.silent.map((x) => x.perspective)]);
c.check('accounted', JSON.stringify([...accounted].sort()) === JSON.stringify(PERSPECTIVES.map((p) => p.id).sort()), 'a perspective is silently absent');
for (const id of ['COMMERCIAL', 'FINANCE', 'SUPPLY_CHAIN', 'RISK']) c.check('speaks-where-data', council.perspectives.some((p) => p.perspective === id), `${id} has data and evidence here and did not speak`);
const peopleOnly = unwrap(await s.council.convene(s.scope, adminCaller(), { question: 'What does the people side of this look like?', perspectives: ['PEOPLE'] }), 'people only');
c.check('refuse-not-fake', peopleOnly.perspectives.length === 0 && peopleOnly.notInstantiated.length === 1, 'a perspective HELM cannot support was faked when asked for by name');

// One truth, gathered once.
const pool = new Set(council.evidence.map((e) => e.id));
c.check('one-pool', council.perspectives.every((p) => p.supportingEvidence.every((e) => pool.has(e.id))) && new Set(council.evidence.map((e) => e.tool)).size >= 4, 'a perspective cites evidence outside the shared pool, or the pool did not come through several governed tools');
c.check('shared', council.sharedEvidence.length > 0 && council.sharedEvidence.every((x) => x.perspectives.length >= 2), 'a fact more than one perspective rests on was not reported once as shared');
const byP = Object.fromEntries(council.perspectives.map((p) => [p.perspective, new Set(p.supportingEvidence.map((e) => e.id))]));
c.check('relevance-not-another-world', JSON.stringify([...byP.FINANCE].sort()) !== JSON.stringify([...byP.SUPPLY_CHAIN].sort()) && council.evidence.filter((e) => byP.FINANCE.has(e.id) && e.dimension).every((e) => ['FINANCIAL', 'CAPITAL'].includes(e.dimension)), 'what each perspective is shown does not differ by relevance, or Finance was handed a reading outside its dimensions');

for (const p of council.perspectives) {
  const def = PERSPECTIVES.find((x) => x.id === p.perspective);
  c.check('own-subset', p.supportingEvidence.every((e) => relevantTo(def, e)), `${p.name} cites evidence that is not relevant to it: a perspective is handed its own subset, never the whole pool`);
}

// The structure, grounded.
for (const p of council.perspectives) {
  const all = Object.values(p.sections).flat();
  const ids = new Set(p.supportingEvidence.map((e) => e.id));
  c.check('structure', JSON.stringify(Object.keys(p.sections).sort()) === JSON.stringify(['CHALLENGED_ASSUMPTIONS', 'CONCERNS', 'OBSERVATIONS', 'TRADE_OFFS']) && Array.isArray(p.unknowns) && Array.isArray(p.questions), `${p.name} does not return the structure`);
  c.check('grounded', p.grounding.removed === 0 && all.length > 0 && all.every((st) => st.evidenceIds.every((id) => ids.has(id))), `${p.name} states something outside its supporting evidence`);
}
const text = (id) => Object.values(council.perspectives.find((p) => p.perspective === id).sections).flat().map((x) => x.text).join('\n');
c.check('own-lens', /Service level|service|Opportunity/i.test(text('COMMERCIAL')) && /Gross Margin|Cash|margin/i.test(text('FINANCE')) && /Inventory|stock|Lead time/i.test(text('SUPPLY_CHAIN')), 'the perspectives do not speak from their own evidence');
const raised = council.perspectives.filter((p) => p.sections.CHALLENGED_ASSUMPTIONS.some((a) => /DISPROVED/.test(a.text)));
c.check('challenged-assumption', raised.length >= 1 && raised.every((p) => p.questions.some((q) => /confirm or disprove/.test(q))), 'the disproved assumption is not raised with the question that would settle it');

// Disagreement preserved; nothing netted.
c.check('tensions', council.tensions.length >= 1 && council.tensions.every((t) => t.gains.length > 0 && t.concessions.length > 0 && t.gains.some((g) => t.concessions.some((x) => x.perspective !== g.perspective)) && /nothing is netted/.test(t.statement) && /does not say which is right/.test(t.statement) && [...t.gains, ...t.concessions].every((side) => /^(GAIN|CONCESSION) /.test(side.line))), 'a tension is not shown as gains and concessions of different perspectives with nothing netted');
const FORBIDDEN = /^(consensus|winner|vote|votes|score|rank|ranking|weight|preference|recommendation|verdict|decision|chosen|priority|agreement(?:Score)?)$/i;
const bad = (o, path = '', acc = []) => {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.test(k)) acc.push(`${path}.${k}`); bad(v, `${path}.${k}`, acc); }
  return acc;
};
c.check('no-consensus', bad(council).length === 0 && council.accountable === 'HUMAN_MANAGEMENT' && /does not vote, rank, weigh or choose/.test(council.notice), 'the council carries a consensus, vote, score, rank, weight, preference or recommendation');
const order = PERSPECTIVES.map((p) => p.id);
const seen = council.perspectives.map((p) => order.indexOf(p.perspective));
c.check('canonical-order', JSON.stringify(seen) === JSON.stringify([...seen].sort((a, b) => a - b)), 'perspectives are not in their fixed canonical order');
c.check('missing-said', council.missingEvidence.some((m) => /People: HELM holds no people data/.test(m)), 'what is missing is not said out loud');

// The orchestrator does not decide.
c.check('one-method', JSON.stringify(Object.keys(s.council)) === JSON.stringify(['convene']), 'the orchestrator has a method other than convening');
const dir = new URL('../packages/agent-runtime/src/', import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
  c.check('no-voting-step', !/\b(vote|tally|rankPerspectives|pickWinner|consensus|chooseDecision)\w*\s*\(/i.test(code), `${f} defines a voting or ranking step`);
}
const fp = async () => JSON.stringify({
  d: unwrap(await s.decisionStore.listDecisions(s.scope), 'd').map((x) => `${x.id}:${x.state}`),
  c: unwrap(await s.causal.listClaims(s.scope), 'c').map((v) => `${v.claim.id}:${v.revision.revision}`),
  s: unwrap(await s.twin.listSnapshots(s.scope), 's').map((x) => x.id),
  r: unwrap(await s.review.listReviews(s.scope), 'r').map((x) => `${x.review.id}:${x.status}:${x.items.length}`),
});
const before = await fp();
unwrap(await s.council.convene(s.scope, adminCaller(), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId }), 'again');
c.check('kernel-identical', (await fp()) === before, 'a council changed a kernel record');

// Audit.
const runs = unwrap(await s.aiStore.listRuns(s.scope, { task: 'COUNCIL' }), 'runs');
const templates = new Set(runs.map((r) => r.templateId));
const orch = runs.find((r) => r.id === council.orchestratorRunId);
c.check('audit', templates.has('council-orchestrator') && council.perspectives.every((p) => templates.has(`council-${p.perspective.toLowerCase()}`)) && orch.toolCalls.length >= 4 && orch.evidenceRefs.length === council.evidence.length && orch.output.statements.length === 0 && runs.every((r) => JSON.stringify(Object.keys(r.output).sort()) === JSON.stringify(['questions', 'statements', 'unknowns'])), 'a perspective or the orchestrator is not audited, or the orchestrator made a statement of its own');

// What the caller may see.
const blind = (id) => id !== s.story.decisionId;
const narrow = unwrap(await s.council.convene(s.scope, caller(viewer(USERS.countryGM, ALL_CLASSES), blind), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId, reviewId: s.reviewStory.second.review.id }), 'narrow');
c.check('as-the-caller', narrow.evidence.length < council.evidence.length && narrow.evidence.every((e) => !(e.ref.kind === 'COMMITMENT' && e.ref.id === s.story.commitmentId)) && narrow.missingEvidence.some((m) => /not visible to you|withheld/.test(m)), 'the council was handed what the caller may not see, or did not say what it could not read');
const uncleared = unwrap(await s.council.convene(s.scope, caller(viewer(USERS.pharmaAnalyst)), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId }), 'uncleared');
c.check('clearance', uncleared.evidence.length < council.evidence.length && uncleared.evidence.every((e) => !(e.dimension === 'FINANCIAL' && e.values.some((v) => /^layer /.test(v)))), 'a financial reading reached an uncleared caller');

// A perspective that misbehaves is held to the same grounding.
const misbehaving = scriptedProvider((input) => ({
  statements: [
    { text: 'Management should approve the reallocation.', class: 'AI_INFERENCE', evidenceIds: [], section: 'CONCERNS' },
    { text: 'A figure from nowhere: 91.4.', class: 'MODEL_RESULT', evidenceIds: [input.evidence[0].id], section: 'OBSERVATIONS' },
    { text: input.evidence[0].label, class: input.evidence[0].kind, evidenceIds: [input.evidence[0].id, 'ev-1'], section: 'OBSERVATIONS' },
  ],
}));
const held = unwrap(await buildCouncil(s, misbehaving).convene(s.scope, adminCaller(), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId, perspectives: ['FINANCE'] }), 'council');
c.check('held-to-grounding', held.perspectives[0].grounding.removed === 2 && Object.values(held.perspectives[0].sections).flat().length === 1, 'a perspective that recommended or fabricated a figure was not held to the grounding');
c.check('short-question', expectFail(await s.council.convene(s.scope, adminCaller(), { question: 'why' }), 'short').code === 'agents.invalid_input', 'a question shorter than a sentence was accepted');

c.finish('perspectives only where HELM has data (People never faked); one pool of evidence gathered as the caller; grounded structure per perspective; tensions shown, nothing netted; no consensus, vote, score, rank or recommendation at any depth; the orchestrator only convenes; kernel byte-identical; audited');
