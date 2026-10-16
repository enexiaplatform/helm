/**
 * Step 3 (2026-10-17): Memoire's order costs become ACTUAL Cogs on the opportunity they fulfil — the landed cost,
 * purchase + duty + freight + other, in one currency. HELM never converts, never reads a sample, never records a cost
 * for an opportunity it has not read, and a second sync of the same costs records nothing new.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureOrderCostReader, createMemoireOrderCostAdapter, MEMOIRE_COST_CONNECTOR } from '../src/index.ts';
import { buildIntegrationStack, row, unwrap } from './harness.mjs';

const cost = (over) => ({
  id: 'cost-x',
  opportunity_id: 'opp-x',
  amount: 1000,
  currency: 'vnd',
  duty_amount: null,
  freight_amount: null,
  other_amount: null,
  extras_currency: null,
  is_sample: false,
  created_at: '2026-10-02T01:00:00.000Z',
  updated_at: '2026-10-02T02:00:00.000Z',
  ...over,
});

async function setup(costs) {
  const s = await buildIntegrationStack();
  s.reader.rows.push(row({ id: 'opp-a', opportunity_name: 'Alpha order' }), row({ id: 'opp-b', opportunity_name: 'Beta order', updated_at: '2026-10-01T03:00:00.000Z' }));
  unwrap(await s.pipeline.run(s.scope, s.adapter), 'opportunities');
  const costReader = createFixtureOrderCostReader(costs);
  const costs$ = createMemoireOrderCostAdapter(costReader);
  return { s, costs$, costReader };
}

async function cogsOf(s, sourceId) {
  const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', `memoire:opportunity:${sourceId}`), 'opportunity');
  const nodes = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes').filter((n) => n.metricKey === 'Cogs');
  if (nodes.length === 0) return null;
  const obs = unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: nodes[0].id }), 'observations');
  return obs.map((o) => ({ type: o.observationType, value: o.numericValue, currency: o.currency, source: o.sourceSystem, period: `${o.periodStart} → ${o.periodEnd}` }));
}

describe('Memoire order costs', () => {
  it('records the landed cost as ACTUAL Cogs on the opportunity, in its own connector', async () => {
    const { s, costs$ } = await setup([cost({ id: 'cost-a', opportunity_id: 'opp-a', amount: '1000.10', duty_amount: 50, freight_amount: 25.2, other_amount: 4.7 })]);
    const sync = unwrap(await s.pipeline.run(s.scope, costs$), 'costs');
    assert.equal(sync.connector, MEMOIRE_COST_CONNECTOR);
    assert.equal(sync.outcome, 'SUCCEEDED');
    assert.equal(sync.counts.observationsRecorded, 1);
    const cogs = await cogsOf(s, 'opp-a');
    assert.equal(cogs.length, 1);
    assert.equal(cogs[0].type, 'ACTUAL');
    assert.equal(Number(cogs[0].value), 1080);
    assert.equal(cogs[0].currency, 'VND');
    assert.equal(cogs[0].source, 'memoire');
    assert.equal(cogs[0].period, '2026-10-01T00:00:00.000Z → 2027-01-01T00:00:00.000Z', 'the quarter Memoire recorded the cost in');
  });

  it('records nothing again when nothing changed', async () => {
    const { s, costs$, costReader } = await setup([cost({ id: 'cost-a', opportunity_id: 'opp-a' })]);
    unwrap(await s.pipeline.run(s.scope, costs$), 'first');
    costReader.rows[0] = { ...costReader.rows[0], updated_at: '2026-10-03T02:00:00.000Z' };
    const again = unwrap(await s.pipeline.run(s.scope, costs$), 'again');
    assert.equal(again.counts.records, 1, 'the touched record is read again');
    assert.equal(again.counts.observationsRecorded, 0);
    assert.equal(again.counts.observationsUnchanged, 1);
  });

  it('never converts: extras in another currency stop the record, and say why', async () => {
    const { s, costs$ } = await setup([cost({ id: 'cost-b', opportunity_id: 'opp-b', freight_amount: 30, extras_currency: 'USD' })]);
    const sync = unwrap(await s.pipeline.run(s.scope, costs$), 'costs');
    assert.equal(sync.quarantined.length, 1);
    assert.match(sync.quarantined[0].reason, /never converts/);
    assert.equal(await cogsOf(s, 'opp-b'), null);
  });

  it('says nothing for a sample or a record with no purchase amount', async () => {
    const { s, costs$ } = await setup([cost({ id: 'cost-s', opportunity_id: 'opp-a', is_sample: true }), cost({ id: 'cost-n', opportunity_id: 'opp-b', amount: null, updated_at: '2026-10-02T03:00:00.000Z' })]);
    const sync = unwrap(await s.pipeline.run(s.scope, costs$), 'costs');
    assert.equal(sync.counts.observationsRecorded, 0);
    assert.deepEqual(sync.quarantined, []);
    assert.equal(await cogsOf(s, 'opp-a'), null);
  });

  it('quarantines a cost for an opportunity HELM has not read', async () => {
    const { s, costs$ } = await setup([cost({ id: 'cost-z', opportunity_id: 'opp-unknown' })]);
    const sync = unwrap(await s.pipeline.run(s.scope, costs$), 'costs');
    assert.equal(sync.quarantined.length, 1);
    assert.match(sync.quarantined[0].reason, /not ingested/);
  });
});
