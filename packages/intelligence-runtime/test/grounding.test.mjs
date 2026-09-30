/**
 * Grounding: what a provider proposes is checked against what the tools returned.
 * Pure — every adversarial draft an AI could produce is tested without a runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groundDraft, groundQuestions, numbersIn } from '../src/index.ts';

const ev = (id, kind, label, values, status = null) => ({ id, kind, ref: { kind: 'X', id: `ref-${id}` }, label, values, status, section: null, tool: 't', lens: null });
const EVIDENCE = [
  ev('ev-1', 'SOURCE_FACT', 'Opportunity Probability', ['0.7', 'source memoire']),
  ev('ev-2', 'MODEL_RESULT', 'Gross margin %', ['31.7 percentage', 'layer MODELLED']),
  ev('ev-3', 'CAUSAL_CLAIM', 'Fulfilment cost drove the margin shortfall', ['confidence LOW'], 'HYPOTHESIS'),
  ev('ev-4', 'COUNTERFACTUAL_RESULT', 'Gross margin under expedite', ['alternative 30.517'], 'MODEL_ONLY'),
  ev('ev-5', 'MANAGEMENT_ASSUMPTION', 'The provincial tender remains material', ['outcome DISPROVED'], 'DISPROVED'),
  ev('ev-6', 'MANAGEMENT_RECORD', 'Rohto Q4 order fulfilment', ['state COMMITTED']),
];
const g = (statements) => groundDraft({ statements }, EVIDENCE);
const s = (text, cls, evidenceIds) => ({ text, class: cls, evidenceIds });

describe('a statement that claims kernel truth must cite evidence of a kind it may rest on', () => {
  it('a correctly cited statement is kept as proposed', () => {
    const r = g([s('Memoire holds the opportunity probability at 0.7.', 'SOURCE_FACT', ['ev-1'])]);
    assert.equal(r.report.kept, 1);
    assert.equal(r.statements[0].class, 'SOURCE_FACT');
    assert.equal(r.statements[0].qualified, false);
  });

  it('a claim of kernel truth with no evidence is marked as inference — never passed as fact', () => {
    const r = g([s('Margin will recover next quarter.', 'MODEL_RESULT', [])]);
    assert.equal(r.statements[0].class, 'AI_INFERENCE');
    assert.equal(r.statements[0].reclassifiedFrom, 'MODEL_RESULT');
    assert.match(r.statements[0].note, /cited no evidence/);
    assert.equal(r.report.downgradedToInference, 1);
  });

  it('evidence this run never retrieved is not evidence', () => {
    const r = g([s('The margin is 31.7.', 'MODEL_RESULT', ['ev-99'])]);
    assert.equal(r.statements[0].class, 'AI_INFERENCE');
    assert.match(r.statements[0].note, /never retrieved/);
  });

  it('no accidental promotion: a model result cited as a source fact is relabelled what it is', () => {
    const r = g([s('The gross margin is 31.7 percentage.', 'SOURCE_FACT', ['ev-2'])]);
    assert.equal(r.statements[0].class, 'MODEL_RESULT');
    assert.equal(r.statements[0].reclassifiedFrom, 'SOURCE_FACT');
    assert.equal(r.report.reclassified, 1);
  });

  it('a statement resting on mixed kinds it cannot rest on is downgraded to inference', () => {
    const r = g([s('Probability 0.7 and margin 31.7 percentage are both facts.', 'SOURCE_FACT', ['ev-1', 'ev-2'])]);
    assert.equal(r.statements[0].class, 'AI_INFERENCE');
    assert.match(r.statements[0].note, /mixes SOURCE_FACT and MODEL_RESULT/);
  });

  it('a model result may cite its source inputs; a counterfactual may cite the model it estimates with', () => {
    assert.equal(g([s('Gross margin 31.7 percentage rests on probability 0.7.', 'MODEL_RESULT', ['ev-2', 'ev-1'])]).statements[0].class, 'MODEL_RESULT');
    assert.equal(g([s('A model estimate: gross margin 30.517 under expedite, against 31.7.', 'COUNTERFACTUAL_RESULT', ['ev-4', 'ev-2'])]).statements[0].class, 'COUNTERFACTUAL_RESULT');
  });
});

describe('a number the kernel did not return is a fabricated number', () => {
  it('a figure absent from the cited evidence removes the statement', () => {
    const r = g([s('The gross margin is 33.9 percentage.', 'MODEL_RESULT', ['ev-2'])]);
    assert.equal(r.statements.length, 0);
    assert.equal(r.report.removed, 1);
    assert.match(r.report.removals[0].reason, /33\.9.*fabricated/);
  });

  it('a figure that IS in the evidence passes, commas and all', () => {
    assert.deepEqual(numbersIn('Revenue of 4,200,000,000 VND and -0.6878 pts'), ['4200000000', '-0.6878']);
    const r = groundDraft({ statements: [s('Value 4,200,000,000.', 'SOURCE_FACT', ['ev-x'])] }, [ev('ev-x', 'SOURCE_FACT', 'Opportunity value', ['4200000000 VND'])]);
    assert.equal(r.statements[0].class, 'SOURCE_FACT');
  });

  it('a figure cannot be borrowed from evidence the statement does not cite', () => {
    const r = g([s('Probability is 31.7.', 'SOURCE_FACT', ['ev-1'])]);
    assert.equal(r.statements.length, 0, 'the margin figure belongs to ev-2, not ev-1');
  });
});

describe('wording may not promote a claim', () => {
  it('a hypothesis stated as fact is downgraded; stated with its status it is kept', () => {
    const asFact = g([s('Fulfilment cost drove the margin shortfall.', 'CAUSAL_CLAIM', ['ev-3'])]);
    assert.equal(asFact.statements[0].class, 'AI_INFERENCE');
    assert.match(asFact.statements[0].note, /keeps the status its evidence carries \(HYPOTHESIS\)/);
    const honest = g([s('It is a HYPOTHESIS that fulfilment cost drove the margin shortfall.', 'CAUSAL_CLAIM', ['ev-3'])]);
    assert.equal(honest.statements[0].class, 'CAUSAL_CLAIM');
  });

  it('a counterfactual that does not say it is an estimate is downgraded', () => {
    assert.equal(g([s('Margin would have been 30.517.', 'COUNTERFACTUAL_RESULT', ['ev-4'])]).statements[0].class, 'AI_INFERENCE');
  });

  it('a model result or scenario is not a cause: causal wording downgrades it', () => {
    const r = g([s('The margin of 31.7 percentage was caused by the reallocation.', 'MODEL_RESULT', ['ev-2'])]);
    assert.equal(r.statements[0].class, 'AI_INFERENCE');
    assert.match(r.statements[0].note, /not a cause/);
  });

  it('a source fact is what the source says now, not a prediction', () => {
    assert.equal(g([s('Memoire says the probability will be 0.7.', 'SOURCE_FACT', ['ev-1'])]).statements[0].class, 'AI_INFERENCE');
  });
});

describe('HELM never recommends', () => {
  const RECOMMENDATIONS = [
    'We should choose the expedite alternative.',
    'Management should approve the reallocation.',
    'I recommend reallocating the stock.',
    'The best option is to expedite.',
    'This should be approved.',
    'Commit to alternative B.',
  ];
  for (const text of RECOMMENDATIONS) {
    it(`removes: ${text}`, () => {
      for (const cls of ['AI_INFERENCE', 'SUGGESTION', 'MODEL_RESULT']) {
        const r = g([s(text, cls, ['ev-2'])]);
        assert.equal(r.statements.length, 0, `${cls} kept a recommendation`);
        assert.match(r.report.removals[0].reason, /recommendation/i);
      }
    });
  }

  it('a suggestion is a question to ask or evidence to gather — nothing else', () => {
    assert.equal(g([s('What would confirm the tender assumption?', 'SUGGESTION', [])]).statements.length, 1);
    assert.equal(g([s('Gather the Q1 distributor stock counts.', 'SUGGESTION', [])]).statements.length, 1);
    assert.equal(g([s('Reallocate the stock now.', 'SUGGESTION', [])]).statements.length, 0);
  });

  it('drafted questions are questions, and none is a recommendation in disguise', () => {
    assert.deepEqual(groundQuestions(['What did the quarter teach us?', 'Choose expedite.', 'We should approve B — right?', 'short?']), ['What did the quarter teach us?']);
  });
});

describe('what carries no kernel claim', () => {
  it('UNKNOWN needs no evidence; inference is always qualified; an invented class is removed', () => {
    assert.equal(g([s('HELM has no reading of distributor stock.', 'UNKNOWN', [])]).statements[0].class, 'UNKNOWN');
    const inf = g([s('The team may be over-committing.', 'AI_INFERENCE', [])]);
    assert.equal(inf.statements[0].qualified, true);
    assert.equal(g([s('Everything is fine.', 'TRUTH', [])]).statements.length, 0);
  });

  it('an empty statement says nothing', () => {
    assert.equal(g([s('   ', 'UNKNOWN', [])]).report.removed, 1);
  });

  it('a report accounts for every proposal: kept + removed = proposed', () => {
    const r = g([s('ok 0.7', 'SOURCE_FACT', ['ev-1']), s('Fake 12.5', 'MODEL_RESULT', ['ev-2']), s('We should approve it.', 'AI_INFERENCE', [])]);
    assert.equal(r.report.proposed, 3);
    assert.equal(r.report.kept + r.report.removed, 3);
  });
});
