/**
 * An AI that misbehaves is caught by the runtime, not trusted: fabricated numbers,
 * unsupported claims, promoted classes, recommendations, borrowed evidence.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adminCaller, buildIntelligence, buildIntelligenceStory, scriptedProvider, unwrap } from './harness.mjs';

let s;
before(async () => {
  s = await buildIntelligenceStory();
});

const runDraft = async (draft, params = { decisionId: s.story.decisionId }, task = 'SUMMARIZE_ASSUMPTIONS') => {
  const b = buildIntelligence(s, scriptedProvider(draft));
  return unwrap(await b.intelligence.run(s.scope, adminCaller(), { task, params }), 'answer');
};

describe('a lying provider', () => {
  it('fabricated figures are removed; the report says which and why', async () => {
    const a = await runDraft((input) => ({
      statements: [
        { text: 'The Rohto margin will be 44.4% next quarter.', class: 'MODEL_RESULT', evidenceIds: [input.evidence[0].id] },
        { text: input.evidence[0].label, class: input.evidence[0].kind, evidenceIds: [input.evidence[0].id] },
      ],
    }));
    assert.equal(a.statements.length, 1);
    assert.equal(a.grounding.removed, 1);
    assert.match(a.grounding.removals[0].reason, /44\.4.*fabricated/);
  });

  it('an unsupported claim about the enterprise is marked as inference, not passed as fact', async () => {
    const a = await runDraft({ statements: [{ text: 'Distributor D is likely to default.', class: 'MANAGEMENT_RECORD', evidenceIds: [] }] });
    assert.equal(a.statements[0].class, 'AI_INFERENCE');
    assert.equal(a.statements[0].qualified, true);
  });

  it('a recommendation is removed however it is classed; a suggestion must be a question', async () => {
    const a = await runDraft({
      statements: [
        { text: 'Management should approve alternative A.', class: 'SUGGESTION', evidenceIds: [] },
        { text: 'The best option is to expedite.', class: 'AI_INFERENCE', evidenceIds: [] },
        { text: 'Approve it now.', class: 'SUGGESTION', evidenceIds: [] },
        { text: 'What would change the tender assumption?', class: 'SUGGESTION', evidenceIds: [] },
      ],
    });
    assert.deepEqual(a.statements.map((x) => x.text), ['What would change the tender assumption?']);
    assert.equal(a.grounding.removed, 3);
  });

  it('a claim resting on evidence from another decision\'s run is not evidence: ids are run-local', async () => {
    const a = await runDraft({ statements: [{ text: 'It is confirmed.', class: 'MANAGEMENT_ASSUMPTION', evidenceIds: ['ev-999', 'ev-1'] }] });
    assert.equal(a.statements[0].class, 'AI_INFERENCE');
  });

  it('a hypothesis a provider states as fact is downgraded — the AI cannot rewrite a causal claim', async () => {
    const b = buildIntelligence(s, scriptedProvider((input) => {
      const c = input.evidence.find((e) => e.kind === 'CAUSAL_CLAIM' && e.status !== 'SUPPORTED');
      return { statements: c ? [{ text: 'It is established that ' + c.label.toLowerCase().replace(/\.$/, '') + '.', class: 'CAUSAL_CLAIM', evidenceIds: [c.id] }] : [] };
    }));
    const a = unwrap(await b.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_CAUSAL_EVIDENCE', params: {} }), 'answer');
    assert.ok(a.statements.length === 1, 'the story holds a claim that is not SUPPORTED');
    assert.equal(a.statements[0].class, 'AI_INFERENCE');
    assert.match(a.statements[0].note, /keeps the status its evidence carries/);
  });

  it('a provider that throws fails the run and the failed attempt is still audited', async () => {
    const b = buildIntelligence(s, scriptedProvider(() => {
      throw new Error('upstream unavailable');
    }));
    const r = await b.intelligence.run(s.scope, adminCaller(), { task: 'SUMMARIZE_ASSUMPTIONS', params: { decisionId: s.story.decisionId } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'intelligence.provider_failed');
    const runs = unwrap(await b.aiStore.listRuns(s.scope), 'runs');
    assert.equal(runs.length, 1);
    assert.match(runs[0].output.unknowns[0], /provider failed/);
  });

  it('a malformed draft is contained: missing arrays, wrong types', async () => {
    const a = await runDraft({ statements: [{ text: 42, class: 'UNKNOWN' }, null].filter(Boolean), questions: 'not a list', unknowns: null });
    assert.ok(Array.isArray(a.statements));
    assert.deepEqual(a.questions, []);
  });
});

describe('a task needs what it needs', () => {
  it('an unknown task or missing parameter is refused before anything is read', async () => {
    const b = buildIntelligence(s);
    assert.equal((await b.intelligence.run(s.scope, adminCaller(), { task: 'WRITE_MEMO', params: {} })).error.code, 'intelligence.unknown_task');
    assert.equal((await b.intelligence.run(s.scope, adminCaller(), { task: 'EXPLAIN_DECISION', params: {} })).error.code, 'intelligence.invalid_input');
    assert.equal(unwrap(await b.aiStore.listRuns(s.scope), 'runs').length, 0, 'a refused task left no run and read nothing');
  });
});
