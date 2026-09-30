/**
 * Schema drift stops ingestion of a changed source; identity is never a name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMOIRE_OPPORTUNITY_CONTRACT, createIdentityMapper, detectDrift } from '../src/index.ts';
import { buildIntegrationStack, expectFail, row, unwrap } from './harness.mjs';

const rec = (fields) => ({ system: 'memoire', objectType: 'opportunity', externalId: fields.id ?? 'x', updatedAt: fields.updated_at ?? '2026-10-01T00:00:00.000Z', contentHash: 'h', fields });

describe('detectDrift is pure and never guesses', () => {
  it('no drift: the source looks like the contract', () => {
    const r = detectDrift(MEMOIRE_OPPORTUNITY_CONTRACT, [rec(row({}))]);
    assert.equal(r.status, 'NONE');
  });

  it('a required field that vanished, or changed type, is BREAKING, with the count of records that showed it', () => {
    const a = detectDrift(MEMOIRE_OPPORTUNITY_CONTRACT, [rec(row({ stage: null })), rec(row({ id: 'y', stage: null }))]);
    assert.equal(a.status, 'BREAKING');
    assert.deepEqual(a.breaking.map((f) => [f.kind, f.field, f.records]), [['MISSING_REQUIRED_FIELD', 'stage', 2]]);
    const b = detectDrift(MEMOIRE_OPPORTUNITY_CONTRACT, [rec(row({ estimated_value: { amount: 5 } }))]);
    assert.equal(b.breaking[0].kind, 'TYPE_CHANGED');
    assert.equal(b.breaking[0].field, 'estimated_value');
  });

  it('a numeric column arriving as a string is not drift; a new column is additive and named', () => {
    assert.equal(detectDrift(MEMOIRE_OPPORTUNITY_CONTRACT, [rec(row({ estimated_value: '1000000.00', pipeline_probability: '45' }))]).status, 'NONE');
    const r = detectDrift(MEMOIRE_OPPORTUNITY_CONTRACT, [rec(row({ warranty_tier: 'gold' }))]);
    assert.equal(r.status, 'ADDITIVE');
    assert.equal(r.additive[0].field, 'warranty_tier');
    assert.match(r.additive[0].detail, /not ingested/);
  });
});

describe('a changed source is stopped, not guessed at', () => {
  it('breaking drift blocks the object type, writes nothing, and leaves the checkpoint where it was', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push(row({ id: 'opp-good', account_id: 'acc-g', updated_at: '2026-10-01T02:00:00.000Z' }));
    const ok = unwrap(await s.pipeline.run(s.scope, s.adapter), 'good sync');
    assert.equal(ok.outcome, 'SUCCEEDED');
    s.reader.rows.push(row({ id: 'opp-drift', stage: null, updated_at: '2026-10-02T02:00:00.000Z' }));
    const blocked = unwrap(await s.pipeline.run(s.scope, s.adapter), 'drifted sync');
    assert.equal(blocked.outcome, 'BLOCKED_BY_DRIFT');
    assert.equal(blocked.cursorAfter, ok.cursorAfter, 'the checkpoint did not move');
    assert.equal(blocked.counts.entitiesCreated, 0);
    assert.equal(blocked.drift[0].status, 'BREAKING');
    assert.equal(unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-drift'), 'lookup'), null, 'nothing about the drifted record entered HELM');
    const checkpoint = unwrap(await s.integrationStore.checkpointOf(s.scope, 'memoire', s.adapter.connector), 'checkpoint');
    assert.equal(checkpoint.cursor, ok.cursorAfter);
  });

  it('additive drift is ingested and reported', async () => {
    const s = await buildIntegrationStack();
    s.reader.rows.push({ ...row({ id: 'opp-extra', account_id: 'acc-e' }), warranty_tier: 'gold' });
    const r = unwrap(await s.pipeline.run(s.scope, s.adapter), 'sync');
    assert.equal(r.outcome, 'SUCCEEDED');
    assert.equal(r.drift[0].status, 'ADDITIVE');
    assert.equal(r.counts.entitiesCreated, 2);
  });
});

describe('identity: source · external id · canonical identity', () => {
  it('a name is never an identity', async () => {
    const s = await buildIntegrationStack();
    const identity = createIdentityMapper(s.graph);
    const opp = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-8821'), 'opp');
    assert.equal(expectFail(await identity.register(s.scope, opp.id, 'memoire', 'name', 'Rohto Q4 tender'), 'name').code, 'integration.name_is_not_identity');
  });

  it('an identifier another entity holds is a conflict, reported and never merged; registering twice is one alias', async () => {
    const s = await buildIntegrationStack();
    const identity = createIdentityMapper(s.graph);
    const a = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Opportunity', 'memoire:opportunity:opp-8821'), 'a');
    const b = unwrap(await s.graph.getEntityByCanonicalKey(s.scope, 'Customer', 'memoire:customer:a3f2c1d4'), 'b');
    assert.equal(unwrap(await identity.register(s.scope, a.id, 'erp', 'code', 'ZZ-9999'), 'first').created, true);
    assert.equal(unwrap(await identity.register(s.scope, a.id, 'erp', 'code', 'ZZ-9999'), 'again').created, false);
    assert.equal(expectFail(await identity.register(s.scope, b.id, 'erp', 'code', 'ZZ-9999'), 'conflict').code, 'integration.identity_conflict');
    const resolved = unwrap(await identity.resolve(s.scope, 'erp', 'ZZ-9999'), 'resolve');
    assert.equal(resolved.id, a.id);
    const aliases = unwrap(await identity.aliasesOf(s.scope, a.id), 'aliases');
    assert.ok(aliases.some((x) => x.system === 'erp' && x.value === 'ZZ-9999'), 'a second system\'s identifier attaches to the same entity');
  });
});
