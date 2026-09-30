/**
 * The council over the Rohto decision: perspectives over ONE enterprise truth,
 * instantiated only where HELM has data, structured output, disagreement preserved,
 * no vote, no rank, no choice.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PERSPECTIVES } from '../src/index.ts';
import { adminCaller, buildCouncil, buildCouncilStory, expectFail, gmCaller, scriptedProvider, unwrap, ALL_CLASSES, USERS, viewer, caller } from './harness.mjs';

let s;
let council;
before(async () => {
  s = await buildCouncilStory();
  council = unwrap(await s.council.convene(s.scope, adminCaller(), { question: 'Should the Rohto allocation be reconsidered given what has happened?', decisionId: s.story.decisionId, reviewId: s.reviewStory.second.review.id }), 'council');
});

describe('perspectives exist only where HELM holds data', () => {
  it('People is not instantiated: HELM holds no people data — and the council says so instead of speaking for it', () => {
    const people = council.notInstantiated.find((n) => n.perspective === 'PEOPLE');
    assert.ok(people, 'People was not reported as not instantiated');
    assert.match(people.reason, /no people data/);
    assert.match(people.reason, /never scores or ranks a person/);
    assert.ok(!council.perspectives.some((p) => p.perspective === 'PEOPLE'));
  });

  it('every perspective HELM does have data for either speaks or says it has nothing to say — none is silently absent', () => {
    const accounted = new Set([...council.perspectives.map((p) => p.perspective), ...council.notInstantiated.map((n) => n.perspective), ...council.silent.map((x) => x.perspective)]);
    assert.deepEqual([...accounted].sort(), PERSPECTIVES.map((p) => p.id).sort());
    for (const id of ['COMMERCIAL', 'FINANCE', 'SUPPLY_CHAIN', 'RISK']) assert.ok(council.perspectives.some((p) => p.perspective === id), `${id} has data and evidence here and should speak`);
  });

  it('a perspective asked for by name that HELM cannot support is refused with its reason, not faked', async () => {
    const r = unwrap(await s.council.convene(s.scope, adminCaller(), { question: 'What does the people side of this look like?', perspectives: ['PEOPLE'] }), 'people only');
    assert.equal(r.perspectives.length, 0);
    assert.equal(r.notInstantiated.length, 1);
  });
});

describe('the same truth, gathered once, seen from different places', () => {
  it('the shared evidence is gathered a single time as the caller; every perspective cites only evidence from that pool', () => {
    const pool = new Set(council.evidence.map((e) => e.id));
    for (const p of council.perspectives) for (const e of p.supportingEvidence) assert.ok(pool.has(e.id), `${p.name} cites evidence outside the shared pool`);
    const tools = new Set(council.evidence.map((e) => e.tool));
    assert.ok(tools.size >= 4, 'the evidence came through several governed tools');
  });

  it('a fact more than one perspective rests on is reported once, as shared', () => {
    assert.ok(council.sharedEvidence.length > 0);
    for (const x of council.sharedEvidence) assert.ok(x.perspectives.length >= 2);
  });

  it('what each perspective is shown differs, because relevance differs — not because it sees another world', () => {
    const byPerspective = Object.fromEntries(council.perspectives.map((p) => [p.perspective, new Set(p.supportingEvidence.map((e) => e.id))]));
    const finance = byPerspective['FINANCE'];
    const supply = byPerspective['SUPPLY_CHAIN'];
    assert.ok(finance.size > 0 && supply.size > 0);
    assert.notDeepEqual([...finance].sort(), [...supply].sort());
    for (const e of council.evidence.filter((e) => finance.has(e.id) && e.dimension)) assert.ok(['FINANCIAL', 'CAPITAL'].includes(e.dimension), `Finance was given a ${e.dimension} reading`);
  });
});

describe('every perspective returns the structure, grounded', () => {
  it('observations, concerns, challenged assumptions, trade-offs, supporting evidence, unknowns and questions', () => {
    for (const p of council.perspectives) {
      assert.deepEqual(Object.keys(p.sections).sort(), ['CHALLENGED_ASSUMPTIONS', 'CONCERNS', 'OBSERVATIONS', 'TRADE_OFFS']);
      assert.ok(Array.isArray(p.unknowns) && Array.isArray(p.questions) && Array.isArray(p.supportingEvidence));
      assert.equal(p.grounding.removed, 0, `${p.name}: ${JSON.stringify(p.grounding.removals)}`);
      const all = Object.values(p.sections).flat();
      assert.ok(all.length > 0);
      const ids = new Set(p.supportingEvidence.map((e) => e.id));
      for (const st of all) assert.ok(st.evidenceIds.every((id) => ids.has(id)), `${p.name} states something not in its supporting evidence`);
    }
  });

  it('the commercial perspective is concerned about service; the finance perspective about margin — each from its own evidence', () => {
    const text = (id) => Object.values(council.perspectives.find((p) => p.perspective === id).sections).flat().map((x) => x.text).join('\n');
    assert.match(text('COMMERCIAL'), /Service level|service|Opportunity/i);
    assert.match(text('FINANCE'), /Gross Margin|Cash|margin/i);
    assert.match(text('SUPPLY_CHAIN'), /Inventory|stock|Lead time/i);
  });

  it('the challenged assumption — the disproved tender — is raised by the perspectives it belongs to, with a question that would settle it', () => {
    const raised = council.perspectives.filter((p) => p.sections.CHALLENGED_ASSUMPTIONS.some((a) => /DISPROVED/.test(a.text)));
    assert.ok(raised.length >= 1);
    assert.ok(raised.every((p) => p.questions.some((q) => /confirm or disprove/.test(q))));
  });
});

describe('disagreement is preserved, and surfaced as a fact about the alternatives', () => {
  it('where an alternative gains for one perspective and concedes for another, the tension is shown side by side with the lines each stands on', () => {
    assert.ok(council.tensions.length >= 1, 'the Rohto alternatives trade service against margin or cash');
    for (const t of council.tensions) {
      assert.ok(t.gains.length > 0 && t.concessions.length > 0);
      assert.ok(t.gains.some((g) => t.concessions.some((c) => c.perspective !== g.perspective)), 'the two sides are different perspectives');
      assert.match(t.statement, /nothing is netted/);
      assert.match(t.statement, /does not say which is right/);
      for (const side of [...t.gains, ...t.concessions]) assert.match(side.line, /^(GAIN|CONCESSION) /);
    }
  });

  it('the council has no consensus to report: no winner, vote, score, rank, weight, preference or recommendation, at any depth', () => {
    const FORBIDDEN = /^(consensus|winner|vote|votes|score|rank|ranking|weight|preference|recommendation|verdict|decision|chosen|priority|agreement(?:Score)?)$/i;
    const bad = (o, path = '', acc = []) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.test(k)) acc.push(`${path}.${k}`); bad(v, `${path}.${k}`, acc); }
      return acc;
    };
    assert.deepEqual(bad(council), []);
    assert.equal(council.accountable, 'HUMAN_MANAGEMENT');
    assert.match(council.notice, /does not vote, rank, weigh or choose/);
  });

  it('perspectives come in a fixed canonical order, never by importance', () => {
    const order = PERSPECTIVES.map((p) => p.id);
    const seen = council.perspectives.map((p) => order.indexOf(p.perspective));
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  });

  it('what is missing is said out loud: unread sources, silent perspectives, perspectives with no data', () => {
    assert.ok(council.missingEvidence.some((m) => /People: HELM holds no people data/.test(m)));
  });
});

describe('the orchestrator does not decide', () => {
  it('has one method, and it opens a council — it has no vote, rank, choose, authorize, approve, commit or execute', () => {
    assert.deepEqual(Object.keys(s.council), ['convene']);
  });

  it('the package calls no method that writes, approves, commits, evaluates or executes', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
      const w = /\.(createDecision|createCommitment|commit|recordApproval|recordRejection|approve|reject|evaluate|recordOutcomeReview|setDecisionState|setActionIntentStatus|createClaim|reviseClaim|recordObservation|execute|executeBaseline|saveSnapshot|grantClearance|bindRef|openEpisode|openCase|estimate|openReview|addItem|closeReview|upsertEntity|dispatch)\s*\(/.exec(code);
      assert.ok(!w, `${f} calls ${w?.[1]}`);
      assert.doesNotMatch(code, /\b(vote|tally|rankPerspectives|pickWinner|consensus|chooseDecision)\w*\s*\(/i, `${f} defines a voting or ranking step`);
    }
  });

  it('a council leaves every kernel record byte-identical (only the audit of the run is added)', async () => {
    const fp = async () => JSON.stringify({
      d: unwrap(await s.decisionStore.listDecisions(s.scope), 'd').map((x) => `${x.id}:${x.state}`),
      c: unwrap(await s.causal.listClaims(s.scope), 'c').map((v) => `${v.claim.id}:${v.revision.revision}`),
      s: unwrap(await s.twin.listSnapshots(s.scope), 's').map((x) => x.id),
      r: unwrap(await s.review.listReviews(s.scope), 'r').map((x) => `${x.review.id}:${x.status}:${x.items.length}`),
    });
    const before = await fp();
    unwrap(await s.council.convene(s.scope, adminCaller(), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId }), 'again');
    assert.equal(await fp(), before);
  });
});

describe('the audit: one run per perspective and one for the orchestrator', () => {
  it('records each perspective\'s run under its own template, and the orchestrator\'s gathering — no reasoning', async () => {
    const runs = unwrap(await s.aiStore.listRuns(s.scope, { task: 'COUNCIL' }), 'runs');
    const templates = new Set(runs.map((r) => r.templateId));
    assert.ok(templates.has('council-orchestrator'));
    for (const p of council.perspectives) assert.ok(templates.has(`council-${p.perspective.toLowerCase()}`), p.perspective);
    const orch = runs.find((r) => r.id === council.orchestratorRunId);
    assert.ok(orch.toolCalls.length >= 4 && orch.evidenceRefs.length === council.evidence.length);
    assert.deepEqual(orch.output.statements, [], 'the orchestrator makes no statement of its own');
    for (const r of runs) assert.deepEqual(Object.keys(r.output).sort(), ['questions', 'statements', 'unknowns']);
  });
});

describe('what each perspective may see is what the caller may see', () => {
  const blind = (id) => id !== s.story.decisionId;

  it('without clearance or decision visibility the council is handed less, and says what it could not read', async () => {
    const full = council;
    const narrow = unwrap(await s.council.convene(s.scope, caller(viewer(USERS.countryGM, ALL_CLASSES), blind), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId, reviewId: s.reviewStory.second.review.id }), 'narrow');
    assert.ok(narrow.evidence.length < full.evidence.length);
    assert.ok(narrow.evidence.every((e) => !(e.ref.kind === 'COMMITMENT' && e.ref.id === s.story.commitmentId)));
    assert.ok(narrow.missingEvidence.some((m) => /not visible to you|withheld/.test(m)));
    const uncleared = unwrap(await s.council.convene(s.scope, caller(viewer(USERS.pharmaAnalyst)), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId }), 'uncleared');
    assert.ok(uncleared.evidence.length < full.evidence.length);
    assert.ok(uncleared.evidence.every((e) => !(e.dimension === 'FINANCIAL' && e.values.some((v) => /^layer /.test(v)))), 'a financial reading reached an uncleared caller');
  });
});

describe('an agent that misbehaves is held to the same grounding', () => {
  it('a perspective that recommends has the statement removed; one that cites another perspective\'s evidence has it downgraded', async () => {
    const misbehaving = scriptedProvider((input) => ({
      statements: [
        { text: 'Management should approve the reallocation.', class: 'AI_INFERENCE', evidenceIds: [], section: 'CONCERNS' },
        { text: 'A figure from nowhere: 91.4.', class: 'MODEL_RESULT', evidenceIds: [input.evidence[0].id], section: 'OBSERVATIONS' },
        { text: input.evidence[0].label, class: input.evidence[0].kind, evidenceIds: [input.evidence[0].id, 'ev-1'], section: 'OBSERVATIONS' },
      ],
    }));
    const r = unwrap(await buildCouncil(s, misbehaving).convene(s.scope, adminCaller(), { question: 'What does each function think of the Rohto outcome?', decisionId: s.story.decisionId, perspectives: ['FINANCE'] }), 'council');
    const p = r.perspectives[0];
    assert.equal(p.grounding.removed, 2, 'the recommendation and the fabricated figure');
    assert.equal(Object.values(p.sections).flat().length, 1);
  });

  it('a question shorter than a sentence is refused before anything is read', async () => {
    assert.equal(expectFail(await s.council.convene(s.scope, adminCaller(), { question: 'why' }), 'short').code, 'agents.invalid_input');
  });
});
