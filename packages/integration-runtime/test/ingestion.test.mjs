/**
 * Ingestion: a Memoire opportunity becomes an ontology entity, an identity and
 * SOURCE observations in the value graph — with no manual duplication, idempotent,
 * and never overwriting or being overwritten by the model.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seqIdGen } from '@helm/shared';
import { createInMemoryIntegrationStore, createIngestionPipeline, createMemoireAdapter, sourceAndModel } from '../src/index.ts';
import { UNITS, buildIntegrationStack, row, unwrap } from './harness.mjs';

const HANOI = row({ id: 'opp-9001', account_id: 'acc-9001', account_name: 'Hanoi General Hospital', opportunity_name: 'Hanoi hospital tender', estimated_value: 2500000000, pipeline_probability: 60, updated_at: '2026-10-01T02:00:00.000Z' });
const HANOI_2 = row({ id: 'opp-9002', account_id: 'acc-9001', account_name: 'Hanoi General Hospital', opportunity_name: 'Hanoi hospital consumables', estimated_value: 400000000, pipeline_probability: 30, updated_at: '2026-10-02T02:00:00.000Z' });

describe('a new Memoire opportunity enters HELM without being typed in again', () => {
  let s;
  let first;
  before(async () => {
    s = await buildIntegrationStack();
    s.reader.rows.push(HANOI);
    first = unwrap(await s.pipeline.run(s.scope, s.adapter), 'first sync');
  });

  it('creates the opportunity and its customer as ontology entities keyed by Memoire\'s own ids', async () => {
    assert.equal(first.outcome, 'SUCCEEDED');
    assert.equal(first.counts.entitiesCreated, 2);
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
    const cust = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Customer', 'memoire:account:acc-9001'), 'customer');
    assert.equal(opp.sourceSystem, 'memoire');
    assert.equal(opp.sourceEntityId, 'opp-9001');
    assert.equal(cust.name, 'Hanoi General Hospital');
    const rels = unwrap(await s.graph.findRelationships(s.scope, { relationshipTypeKeys: ['HELD_BY'], sourceEntityId: opp.id }), 'relationships');
    assert.equal(rels.length, 1);
    assert.equal(rels[0].targetEntityId, cust.id);
  });

  it('registers each system\'s identifier as an alias, and resolves by it — never by name', async () => {
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
    const aliases = unwrap(await s.graph.getAliases(s.scope, opp.id), 'aliases');
    assert.ok(aliases.some((a) => a.system === 'memoire' && a.aliasKind === 'source_id' && a.aliasValue === 'opp-9001'));
    const viaAlias = unwrap(await s.graph.findByAlias(s.scope, 'memoire', 'opp-9001'), 'by alias');
    assert.equal(viaAlias[0].id, opp.id);
  });

  it('records value and probability as source observations that name Memoire and the source field', async () => {
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
    const nodes = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes');
    const prob = nodes.find((n) => n.metricKey === 'OpportunityProbability');
    const val = nodes.find((n) => n.metricKey === 'OpportunityValue');
    assert.ok(prob && val);
    const p = unwrap(await s.valueGraph.getLatestObservation(s.scope, { nodeId: prob.id, type: 'ACTUAL', scenarioEntityId: null }), 'prob');
    assert.equal(p.numericValue, 0.6, 'Memoire holds percent; HELM holds a ratio');
    assert.equal(p.sourceSystem, 'memoire');
    assert.equal(p.metadata.sourceField, 'pipeline_probability');
    assert.equal(p.metadata.sourceObjectId, 'opp-9001');
    const v = unwrap(await s.valueGraph.getLatestObservation(s.scope, { nodeId: val.id, type: 'ACTUAL', scenarioEntityId: null }), 'value');
    assert.equal(v.numericValue, 2500000000);
    assert.equal(v.currency, 'VND');
  });

  it('every ingested fact traces to its ingestion event, connector and source object', async () => {
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
    const prov = unwrap(await s.graph.getProvenance(s.scope, 'entity', opp.id), 'provenance');
    assert.equal(prov.length, 1);
    assert.equal(prov[0].method, 'ingested');
    assert.equal(prov[0].system, 'memoire');
    assert.match(prov[0].connector, /^memoire-connector@/);
    assert.equal(prov[0].sourceObjectId, 'opp-9001');
    assert.ok(prov[0].ingestionEventId);
    assert.equal(first.ingestionEventId, prov[0].ingestionEventId);
  });

  it('a second opportunity of the same account reuses the customer entity: identity is by id, not by a new name', async () => {
    s.reader.rows.push(HANOI_2);
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'second sync');
    assert.equal(r.counts.entitiesCreated, 1, 'only the new opportunity');
    assert.equal(r.counts.entitiesUnchanged, 1, 'the customer is the same entity');
    const custs = unwrap(await s.graph.findEntities(s.scope, { entityTypeKeys: ['Customer'], search: 'Hanoi' }), 'customers');
    assert.equal(custs.length, 1);
  });
});

describe('idempotency and checkpoints', () => {
  it('running the same sync twice changes nothing, and a fresh checkpoint re-reading everything changes nothing either', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(HANOI, HANOI_2);
    const a = unwrap(await s.pipeline.run(s.scope, s.adapter), 'first');
    const b = unwrap(await s.pipeline.run(s.scope, s.adapter), 'again from the checkpoint');
    assert.equal(b.counts.records, 0, 'the checkpoint resumes after the last record');
    assert.equal(b.cursorAfter, a.cursorAfter);
    // A store with no memory of having synced re-reads every row from the start.
    const amnesiac = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store: createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('am') }), clock: s.clock });
    const c = unwrap(await amnesiac.run(s.scope, s.adapter), 'full re-read');
    assert.equal(c.counts.records, 2);
    assert.equal(c.counts.entitiesCreated + c.counts.entitiesUpdated, 0, 'no entity written');
    assert.equal(c.counts.relationshipsCreated, 0);
    assert.equal(c.counts.aliasesRegistered, 0);
    assert.equal(c.counts.observationsRecorded, 0, 'no observation duplicated');
    assert.equal(c.counts.observationsUnchanged, 4);
  });

  it('a changed value is a new observation; the earlier one stays', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(HANOI);
    unwrap(await s.pipeline.run(s.scope, s.adapter), 'first');
    s.reader.rows[0] = { ...HANOI, pipeline_probability: 20, updated_at: '2026-10-05T02:00:00.000Z' };
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'changed');
    assert.equal(r.counts.observationsRecorded, 1);
    assert.equal(r.counts.observationsUnchanged, 1, 'the value did not change');
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
    const prob = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes').find((n) => n.metricKey === 'OpportunityProbability');
    const all = unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: prob.id, types: ['ACTUAL'] }), 'history');
    assert.deepEqual(all.map((o) => o.numericValue).sort(), [0.2, 0.6]);
  });

  it('the checkpoint does not move past a record HELM could not take', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(HANOI, row({ id: 'opp-bad', estimated_value: 5, currency: null, updated_at: '2026-10-03T02:00:00.000Z' }));
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync');
    assert.equal(r.outcome, 'PARTIAL');
    assert.equal(r.quarantined.length, 1);
    assert.match(r.quarantined[0].reason, /no currency; HELM will not guess one/);
    assert.equal(r.cursorAfter, null, 'the next run sees the record again');
  });
});

describe('Source Truth ≠ Model Truth', () => {
  let s;
  let node;
  before(async () => {
    s = await buildIntegrationStack();
    // opp-8821 is the Rohto Q4 tender the canonical value chain already holds.
    s.reader.rows.push(row({ id: 'opp-8821', account_id: 'acc-rohto', account_name: 'Rohto Vietnam', opportunity_name: 'Rohto Q4 tender', estimated_value: 4200000000, pipeline_probability: 70, updated_at: '2026-09-18T11:02:00.000Z' }));
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync');
    assert.equal(r.counts.observationsRecorded, 0, 'Memoire says what the seed already said: nothing new');
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-8821'), 'opportunity');
    node = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes').find((n) => n.metricKey === 'OpportunityProbability');
  });

  it('a model estimate of the same quantity sits beside the source value; neither overwrites the other', async () => {
    unwrap(await s.valueGraph.recordObservation(s.scope, { nodeId: node.id, observationType: 'ESTIMATE', numericValue: 0.35, unitType: 'ratio', effectiveAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:00:00.000Z', sourceSystem: 'helm', confidence: 0.5 }), 'model estimate');
    s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 55, updated_at: '2026-09-25T02:00:00.000Z' };
    unwrap(await s.pipeline.run(s.scope, s.adapter), 'memoire changed its probability');
    const view = unwrap(await sourceAndModel(s.valueGraph, s.scope, node.id), 'source and model');
    assert.equal(view.source.find((x) => x.type === 'ACTUAL').value, '0.55');
    assert.equal(view.source.find((x) => x.type === 'ACTUAL').sourceSystem, 'memoire');
    assert.equal(view.model.find((x) => x.type === 'ESTIMATE').value, '0.35', 'the model estimate was not overwritten by the source');
    assert.equal(view.model.find((x) => x.type === 'ESTIMATE').sourceSystem, 'helm');
    assert.match(view.statement, /neither overwrites the other, and HELM does not say which is right/);
  });

  it('the ingestion path has no way to assert model truth: a translation that tries is quarantined', async () => {
    const cheat = { ...s.adapter, translate: (rec) => {
      const t = s.adapter.translate(rec);
      return { ok: true, value: { ...t.value, facts: t.value.facts.map((f) => ({ ...f, observationType: 'ESTIMATE' })) } };
    } };
    s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 10, updated_at: '2026-09-26T02:00:00.000Z' };
    const r = unwrap(await s.pipeline.run(s.scope, cheat), 'a cheating adapter');
    assert.equal(r.outcome, 'PARTIAL');
    assert.match(r.quarantined[0].reason, /a source may record ACTUAL, FORECAST or TARGET, not ESTIMATE/);
  });

  it('the twin shows the source value as a source claim, and the change since as a difference that names its source and traces to its ingestion', async () => {
    const scope = s.scope;
    const build = (label) => s.twin.buildSnapshot(scope, { kind: 'CURRENT', label, scope: s.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: [UNITS.vietnam] });
    const before = unwrap(await build('before Memoire moves'), 'before');
    s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 0, updated_at: '2026-09-27T02:00:00.000Z' };
    unwrap(await s.pipeline.run(s.scope, s.adapter), 'memoire drops the probability to zero');
    const after = unwrap(await build('after Memoire moves'), 'after');
    const delta = unwrap(await s.twin.compareSnapshots(scope, before.snapshot.id, after.snapshot.id), 'delta');
    const key = `value:${node.id}:ACTUAL`;
    const changed = delta.knowledgeChanges.find((c) => c.itemKey === key);
    assert.ok(changed, 'the twin sees the source change as a change in what the source claims');
    assert.ok(delta.valueChanges.length > 0, 'and the modelled values downstream of it moved');
    assert.equal(changed.after.state.value, '0');
    assert.equal(changed.after.state.sourceSystem, 'memoire', 'the reading names the system that owns the fact');
    assert.equal(changed.before.state.value, '0.55', 'the earlier reading stays what it was');
    const explained = unwrap(await s.twin.explainItem(scope, after.snapshot.id, key), 'explain');
    assert.ok(explained.chain.length > 0, 'the value traces back through the model');
    const obs = unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: node.id, types: ['ACTUAL'] }), 'observations');
    const latest = obs.find((o) => o.id === changed.after.state.observationId);
    assert.equal(latest.metadata.sourceObjectId, 'opp-8821', 'and to the Memoire record it came from');
    const prov = unwrap(await s.graph.getProvenance(s.scope, 'value_observation', latest.id), 'provenance');
    assert.equal(prov[0].system, 'memoire');
    assert.ok(prov[0].ingestionEventId);
  });
});
