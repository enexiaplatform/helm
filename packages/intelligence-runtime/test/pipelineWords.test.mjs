/**
 * Audit 2026-10-13: "Which opportunities are in stage Lost or Won?" came back with Discovery deals and "80 more rows";
 * "Top 5 largest deals of Samil" was refused. The words of a pipeline question now name a state, a stage, a brand, an
 * order the reader asked for — and a dimension HELM does not hold is said back, never silently dropped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceProvider, pipelineWords } from '../src/index.ts';

describe('the words of a pipeline question', () => {
  it('lost or won is a deal state, not ignored', () => {
    assert.deepEqual(pipelineWords('which opportunities are in stage lost or won?'), { state: 'LOST,WON' });
    assert.deepEqual(pipelineWords('cơ hội nào đã thắng?'), { state: 'WON' });
  });

  it('a stage the question names filters by it', () => {
    assert.deepEqual(pipelineWords('deals in proposal or negotiation'), { stage: 'proposal|negotiation' });
  });

  it('"top 5 largest" is an order the reader asked for, with its count', () => {
    assert.deepEqual(pipelineWords('top 5 largest deals of samil'), { sortBy: 'value', limit: 5 });
    assert.deepEqual(pipelineWords('5 deal lớn nhất'), { sortBy: 'value', limit: 5 });
    assert.deepEqual(pipelineWords('highest probability deals'), { sortBy: 'probability', limit: 5 });
    assert.deepEqual(pipelineWords('smallest deals'), { sortBy: 'value', order: 'asc', limit: 5 });
  });

  it('a brand the question names', () => {
    assert.deepEqual(pipelineWords('pipeline for brand tailin'), { brand: 'tailin' });
  });

  it('a dimension HELM does not hold is said back as not understood', () => {
    assert.match(String(pipelineWords('pipeline by rep and region').notUnderstood), /sales rep.*region/);
    assert.match(String(pipelineWords('deals against target').notUnderstood), /target/);
  });

  it('the router carries them into the pipeline tool', async () => {
    const tools = ['getManagementAttention', 'getPipelinePositions'].map((name) => ({ name, description: '', args: [] }));
    const calls = await createReferenceProvider().plan({ question: 'Which opportunities are in stage Lost or Won?', tools });
    assert.deepEqual(calls.find((c) => c.tool === 'getPipelinePositions')?.args, { state: 'LOST,WON', mentioning: 'Which opportunities are in stage Lost or Won?' });
    const top = await createReferenceProvider().plan({ question: 'Top 5 largest deals of Samil?', tools });
    assert.deepEqual(top.find((c) => c.tool === 'getPipelinePositions')?.args, { sortBy: 'value', limit: 5, mentioning: 'Top 5 largest deals of Samil?' });
  });
});

describe('live audit 2026-10-16: what a manager typed', () => {
  const tools = ['getManagementAttention', 'getPipelinePositions'].map((name) => ({ name, description: '', args: [] }));
  const pipe = async (question) => (await createReferenceProvider().plan({ question, tools, now: '2026-10-16T09:00:00.000Z' })).find((c) => c.tool === 'getPipelinePositions')?.args;

  it('a name at the start of the question is still a name', async () => {
    assert.equal((await pipe('Tailin deals due in Q4')).mentioning, 'Tailin deals due in Q4');
    assert.equal((await pipe('Which deals close this quarter?')).mentioning, undefined, 'an opening question word names nothing');
  });

  it('a bare quarter is this year\'s', async () => {
    assert.equal((await pipe('Tailin deals due in Q4')).closePeriod, '2026-Q4');
    assert.equal((await pipe('deal nào chốt trong quý 1?')).closePeriod, '2026-Q1');
    assert.equal((await pipe('deals in Q1 2027')).closePeriod, '2027-Q1', 'a stated year wins');
  });

  it('a short brand is passed on to be matched', async () => {
    assert.equal((await pipe('How much is weighted for PMM this quarter?')).mentioning, 'How much is weighted for PMM this quarter?');
  });

  it('time since the last touch and a year are said back, not dropped', () => {
    assert.match(String(pipelineWords('which deals have not moved for 30 days?').notUnderstood), /last touch/);
    assert.match(String(pipelineWords('which deals were lost this year?').notUnderstood), /a year/);
  });
});
