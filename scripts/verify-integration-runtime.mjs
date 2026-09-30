/**
 * verify:integration-runtime — a source system owns its facts, and HELM ingests them without duplicating them.
 *
 *   - a Memoire opportunity becomes an entity keyed by Memoire's own id, an alias and SOURCE observations that name
 *     the system and the field — with no manual entry, and traced to the ingestion event that brought it;
 *   - ingestion is idempotent by content: a fresh checkpoint re-reading everything changes nothing;
 *   - a changed value is a NEW observation and the earlier one stays;
 *   - a record HELM cannot take is quarantined and holds the checkpoint; breaking drift blocks the object type and
 *     writes nothing;
 *   - Source Truth ≠ Model Truth: a model estimate sits beside a source actual, neither overwrites the other, the
 *     ingestion path cannot assert model truth, and the twin shows the source change as a change of what the source claims;
 *   - identity is never a name, and a conflicting identifier is reported and never merged.
 */

import { seqIdGen } from '@helm/shared';
import { createIdentityMapper, createIngestionPipeline, createInMemoryIntegrationStore, sourceAndModel } from '../packages/integration-runtime/src/index.ts';
import { UNITS, buildIntegrationStack, contract, expectFail, row, unwrap } from './lib/v1Stack.mjs';

const c = contract('verify:integration-runtime');
const HANOI = row({ id: 'opp-9001', account_id: 'acc-9001', account_name: 'Hanoi General Hospital', opportunity_name: 'Hanoi hospital tender', estimated_value: 2500000000, pipeline_probability: 60, updated_at: '2026-10-01T02:00:00.000Z' });
const HANOI_2 = row({ id: 'opp-9002', account_id: 'acc-9001', account_name: 'Hanoi General Hospital', opportunity_name: 'Hanoi hospital consumables', estimated_value: 400000000, pipeline_probability: 30, updated_at: '2026-10-02T02:00:00.000Z' });

// A new opportunity enters HELM without being typed in again.
let s = await buildIntegrationStack();
s.reader.rows.push(HANOI);
const first = unwrap(await s.pipeline.run(s.scope, s.adapter), 'first sync');
c.check('ingest', first.outcome === 'SUCCEEDED' && first.counts.entitiesCreated === 2, 'a Memoire opportunity did not become an opportunity and its customer');
const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-9001'), 'opportunity');
c.check('identity', opp?.sourceSystem === 'memoire' && opp.sourceEntityId === 'opp-9001', 'the entity is not keyed by the source system\'s own id');
const aliases = unwrap(await s.graph.getAliases(s.scope, opp.id), 'aliases');
c.check('identity', aliases.some((a) => a.system === 'memoire' && a.aliasKind === 'source_id' && a.aliasValue === 'opp-9001'), 'the source identifier is not registered as an alias');
const nodes = unwrap(await s.valueGraph.findNodesForEntity(s.scope, opp.id), 'nodes');
const prob = nodes.find((n) => n.metricKey === 'OpportunityProbability');
const p = unwrap(await s.valueGraph.getLatestObservation(s.scope, { nodeId: prob.id, type: 'ACTUAL', scenarioEntityId: null }), 'probability');
c.check('source-typed', p.numericValue === 0.6 && p.sourceSystem === 'memoire' && p.metadata.sourceField === 'pipeline_probability' && p.metadata.sourceObjectId === 'opp-9001', 'the probability is not a source observation that names Memoire, the field and the object');
const prov = unwrap(await s.graph.getProvenance(s.scope, 'entity', opp.id), 'provenance');
c.check('lineage', prov.length === 1 && prov[0].method === 'ingested' && /^memoire-connector@/.test(prov[0].connector) && prov[0].ingestionEventId === first.ingestionEventId, 'an ingested fact does not trace to its ingestion event, connector and source object');

// Idempotency, by content.
s.reader.rows.push(HANOI_2);
const second = unwrap(await s.pipeline.run(s.scope, s.adapter), 'second sync');
c.check('identity-by-id', second.counts.entitiesCreated === 1 && second.counts.entitiesUnchanged === 1, 'a second opportunity of the same account did not reuse the customer entity');
const resumed = unwrap(await s.pipeline.run(s.scope, s.adapter), 'from the checkpoint');
c.check('checkpoint', resumed.counts.records === 0 && resumed.cursorAfter === second.cursorAfter, 'the checkpoint does not resume after the last record');
const amnesiac = createIngestionPipeline({ graph: s.graph, valueGraph: s.valueGraph, store: createInMemoryIntegrationStore({ clock: s.clock, idGen: seqIdGen('am') }), clock: s.clock });
const reread = unwrap(await amnesiac.run(s.scope, s.adapter), 'full re-read');
c.check('idempotent', reread.counts.records === 2 && reread.counts.entitiesCreated + reread.counts.entitiesUpdated === 0 && reread.counts.relationshipsCreated === 0 && reread.counts.aliasesRegistered === 0 && reread.counts.observationsRecorded === 0 && reread.counts.observationsUnchanged === 4, 'a full re-read changed something: ingestion is not idempotent by content');

// A changed value is a new observation.
s.reader.rows[0] = { ...HANOI, pipeline_probability: 20, updated_at: '2026-10-05T02:00:00.000Z' };
const changed = unwrap(await s.pipeline.run(s.scope, s.adapter), 'changed');
c.check('append', changed.counts.observationsRecorded === 1 && changed.counts.observationsUnchanged === 1, 'a changed value did not become exactly one new observation');
const history = unwrap(await s.valueGraph.getObservations(s.scope, { nodeId: prob.id, types: ['ACTUAL'] }), 'history');
c.check('append', JSON.stringify(history.map((o) => o.numericValue).sort()) === JSON.stringify([0.2, 0.6]), 'the earlier observation did not stay');

// Quarantine holds the checkpoint; breaking drift blocks and writes nothing.
s = await buildIntegrationStack();
s.reader.rows.push(HANOI, row({ id: 'opp-bad', estimated_value: 5, currency: null, updated_at: '2026-10-03T02:00:00.000Z' }));
const partial = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync with a bad record');
c.check('quarantine', partial.outcome === 'PARTIAL' && partial.quarantined.length === 1 && /no currency; HELM will not guess one/.test(partial.quarantined[0].reason) && partial.cursorAfter === null, 'a record HELM could not take was guessed at, or the checkpoint moved past it');

s = await buildIntegrationStack();
s.reader.rows.push(row({ id: 'opp-good', account_id: 'acc-g', updated_at: '2026-10-01T02:00:00.000Z' }));
const ok = unwrap(await s.pipeline.run(s.scope, s.adapter), 'good sync');
s.reader.rows.push(row({ id: 'opp-drift', stage: null, updated_at: '2026-10-02T02:00:00.000Z' }));
const blocked = unwrap(await s.pipeline.run(s.scope, s.adapter), 'drifted sync');
c.check('drift', blocked.outcome === 'BLOCKED_BY_DRIFT' && blocked.cursorAfter === ok.cursorAfter && blocked.counts.entitiesCreated === 0 && blocked.drift[0].status === 'BREAKING', 'breaking drift did not block the run, hold the checkpoint and write nothing');
c.check('drift', unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-drift'), 'lookup') === null, 'something about a drifted record entered HELM');
const cp = unwrap(await s.integrationStore.checkpointOf(s.scope, 'memoire', s.adapter.connector), 'checkpoint');
c.check('checkpoint-derived', cp.cursor === ok.cursorAfter, 'the checkpoint moved after a blocked run');

// Source Truth ≠ Model Truth.
s = await buildIntegrationStack();
s.reader.rows.push(row({ id: 'opp-8821', account_id: 'acc-rohto', account_name: 'Rohto Vietnam', opportunity_name: 'Rohto Q4 tender', estimated_value: 4200000000, pipeline_probability: 70, updated_at: '2026-09-18T11:02:00.000Z' }));
const seedSync = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync against the canonical chain');
c.check('no-double-entry', seedSync.counts.observationsRecorded === 0, 'Memoire restated what the seed already said and HELM recorded it twice');
const rohto = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-8821'), 'rohto');
const node = unwrap(await s.valueGraph.findNodesForEntity(s.scope, rohto.id), 'nodes').find((n) => n.metricKey === 'OpportunityProbability');
unwrap(await s.valueGraph.recordObservation(s.scope, { nodeId: node.id, observationType: 'ESTIMATE', numericValue: 0.35, unitType: 'ratio', effectiveAt: '2026-09-20T00:00:00.000Z', observedAt: '2026-09-20T00:00:00.000Z', sourceSystem: 'helm', confidence: 0.5 }), 'model estimate');
s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 55, updated_at: '2026-09-25T02:00:00.000Z' };
unwrap(await s.pipeline.run(s.scope, s.adapter), 'memoire moved');
const view = unwrap(await sourceAndModel(s.valueGraph, s.scope, node.id), 'source and model');
c.check('source-vs-model', view.source.find((x) => x.type === 'ACTUAL').value === '0.55' && view.model.find((x) => x.type === 'ESTIMATE').value === '0.35', 'the source value or the model estimate was overwritten by the other');
c.check('source-vs-model', /neither overwrites the other, and HELM does not say which is right/.test(view.statement), 'the difference between source and model is not stated as two claims');
const cheat = { ...s.adapter, translate: (rec) => { const t = s.adapter.translate(rec); return { ok: true, value: { ...t.value, facts: t.value.facts.map((f) => ({ ...f, observationType: 'ESTIMATE' })) } }; } };
s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 10, updated_at: '2026-09-26T02:00:00.000Z' };
const cheated = unwrap(await s.pipeline.run(s.scope, cheat), 'a cheating adapter');
c.check('no-model-truth-from-a-source', cheated.outcome === 'PARTIAL' && /a source may record ACTUAL, FORECAST or TARGET, not ESTIMATE/.test(cheated.quarantined[0].reason), 'the ingestion path can assert model truth');

const build = (label) => s.twin.buildSnapshot(s.scope, { kind: 'CURRENT', label, scope: s.story.scopes.vietnam, periods: ['2026-Q4'], grantedUnitIds: [UNITS.vietnam] });
s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 55, updated_at: '2026-09-27T01:00:00.000Z' };
unwrap(await s.pipeline.run(s.scope, s.adapter), 'settle');
const before = unwrap(await build('before Memoire moves'), 'before');
s.reader.rows[0] = { ...s.reader.rows[0], pipeline_probability: 0, updated_at: '2026-09-27T02:00:00.000Z' };
unwrap(await s.pipeline.run(s.scope, s.adapter), 'memoire drops the probability');
const after = unwrap(await build('after Memoire moves'), 'after');
const delta = unwrap(await s.twin.compareSnapshots(s.scope, before.snapshot.id, after.snapshot.id), 'delta');
const change = delta.knowledgeChanges.find((k) => k.itemKey === `value:${node.id}:ACTUAL`);
c.check('twin-shows-source', change?.after.state.value === '0' && change.after.state.sourceSystem === 'memoire' && change.before.state.value === '0.55', 'the twin does not show the source change as a change in what the source claims, naming the system');

// Identity is never a name.
const identity = createIdentityMapper(s.graph);
c.check('identity', expectFail(await identity.register(s.scope, rohto.id, 'memoire', 'name', 'Rohto Q4 tender'), 'name').code === 'integration.name_is_not_identity', 'a name was accepted as an identity');
const cust = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Customer', 'memoire:customer:a3f2c1d4'), 'customer');
c.check('identity', unwrap(await identity.register(s.scope, rohto.id, 'erp', 'code', 'ZZ-9999'), 'first').created === true && unwrap(await identity.register(s.scope, rohto.id, 'erp', 'code', 'ZZ-9999'), 'again').created === false, 'registering the same alias twice is not one alias');
c.check('identity', expectFail(await identity.register(s.scope, cust.id, 'erp', 'code', 'ZZ-9999'), 'conflict').code === 'integration.identity_conflict', 'an identifier another entity holds was merged instead of reported');

c.finish('source-typed observations, idempotent by content, changed values append, a bad record holds the checkpoint, breaking drift writes nothing, Source Truth ≠ Model Truth, identity is never a name');
