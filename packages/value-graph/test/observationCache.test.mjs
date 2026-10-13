/**
 * Audit 2026-10-13: a scenario state read one node's observations per request, in sequence — the Scenarios page took
 * 25 s. With a read generation, the organization's observations are read once per generation and every per-node read
 * is answered from them; a new generation (a write, a Refresh) reads them again. Paging keeps PostgREST's 1000-row cap
 * from cutting anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresValueGraph } from '../src/postgres.ts';

const row = (id, node, type, value, extra = {}) => ({
  id, org_id: 'org', node_id: node, observation_type: type, numeric_value: String(value), text_value: null, unit_type: 'currency', currency: 'SGD',
  effective_at: '2026-10-01T00:00:00Z', period_start: null, period_end: null, observed_at: null, recorded_at: `2026-10-0${1 + (Number(id.slice(1)) % 8)}T00:00:00Z`,
  scenario_entity_id: null, assumption_entity_id: null, confidence: null, source_system: null, provenance_id: null, calculation_run_id: null, metadata: {}, created_by: null, ...extra,
});

function fakeClient(rows) {
  const calls = [];
  const builder = (table) => {
    const q = { table, filters: [], range: null };
    const api = {
      select: () => api,
      eq: (c, v) => (q.filters.push([c, v]), api),
      is: () => api,
      in: () => api,
      order: () => api,
      limit: () => run(),
      range: (a, b) => ((q.range = [a, b]), run()),
      then: undefined,
    };
    const run = async () => {
      calls.push(q);
      let data = rows.filter((r) => q.filters.every(([c, v]) => r[c] === v));
      if (q.range) data = data.slice(q.range[0], q.range[1] + 1);
      return { data, error: null };
    };
    return api;
  };
  return { client: { from: builder }, calls };
}

const graphOver = (client, readEpoch) =>
  createPostgresValueGraph({ client, metrics: { allMetrics: () => [], metric: () => null }, ontology: {}, graphStore: {}, clock: { now: () => new Date() }, readEpoch });

describe('observations are read once per read generation', () => {
  const rows = [row('o1', 'n1', 'ACTUAL', 10), row('o2', 'n1', 'FORECAST', 12), row('o3', 'n2', 'ACTUAL', 5), row('o4', 'n2', 'SCENARIO', 7, { scenario_entity_id: 's1' })];

  it('two nodes, one read; filters apply as the database would', async () => {
    const { client, calls } = fakeClient(rows);
    const g = graphOver(client, () => 1);
    const a = await g.getObservations({ orgId: 'org' }, { nodeId: 'n1', types: ['ACTUAL'] });
    const b = await g.getObservations({ orgId: 'org' }, { nodeId: 'n2', scenarioEntityId: null });
    assert.equal(calls.length, 1);
    assert.deepEqual(a.value.map((o) => o.id), ['o1']);
    assert.deepEqual(b.value.map((o) => o.id), ['o3'], 'a scenario observation is not a baseline one');
    const s = await g.getObservations({ orgId: 'org' }, { nodeId: 'n2', scenarioEntityId: 's1' });
    assert.deepEqual(s.value.map((o) => o.id), ['o4']);
  });

  it('a new generation reads again', async () => {
    const { client, calls } = fakeClient(rows);
    let epoch = 1;
    const g = graphOver(client, () => epoch);
    await g.getObservations({ orgId: 'org' }, { nodeId: 'n1' });
    epoch = 2;
    await g.getObservations({ orgId: 'org' }, { nodeId: 'n1' });
    assert.equal(calls.length, 2);
  });

  it('more than a page is read in pages, nothing cut', async () => {
    const many = Array.from({ length: 2300 }, (_, i) => row(`o${i}`, `n${i % 3}`, 'ACTUAL', i));
    const { client, calls } = fakeClient(many);
    const g = graphOver(client, () => 1);
    const r = await g.getObservations({ orgId: 'org' }, { nodeId: 'n0', limit: 5000 });
    assert.equal(calls.length, 3);
    assert.equal(r.value.length, many.filter((x) => x.node_id === 'n0').length);
  });

  it('without a generation, every read goes to the database', async () => {
    const { client, calls } = fakeClient(rows);
    const g = graphOver(client, undefined);
    await g.getObservations({ orgId: 'org' }, { nodeId: 'n1' });
    await g.getObservations({ orgId: 'org' }, { nodeId: 'n1' });
    assert.equal(calls.length, 2);
  });
});
