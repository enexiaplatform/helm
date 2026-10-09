/**
 * Derived positions — a world that arrives from a source system carries only its
 * source facts. Before positions exist, a full model run over it computes nothing;
 * after ensureDerivedPositions it computes exactly what those facts support, and
 * nothing it would have to guess.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore } from '@helm/graph-store';
import { createInMemoryValueGraph, buildSeedValueRegistry } from '@helm/value-graph';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  ensureDerivedPositions,
  meridianValueModelV1_1,
} from '../src/index.ts';

const ORG = asOrgId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const ACTOR = asUserId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
const scope = { orgId: ORG, actorId: ACTOR, role: 'member', orgUnitIds: [], functions: [] };
const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

/** Three Memoire-shaped opportunities: two with value and probability, one with a value only. */
async function memoireWorld() {
  let tick = 0;
  const base = Date.parse('2026-10-09T05:00:00.000Z');
  const clock = { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('m');
  const ontology = buildSeedRegistry();
  const metrics = buildSeedValueRegistry();
  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
  const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, metrics), 'registry');
  const engine = unwrap(createPropagationEngine({ registry, valueGraph, graphStore, ontology, store: createInMemoryCalculationStore({ clock, idGen }), clock }), 'engine');
  const at = asValidTime('2026-10-06T00:00:00.000Z');
  const opps = {};
  for (const [key, name, value, probability] of [
    ['a', 'Talin AST / Tailin / Instrument', 200000, 0.1],
    ['b', 'Osmometer x 2 / Scitek / Instrument', 30000, 0.5],
    ['c', 'Media / PMM / RTU', 2000, null],
  ]) {
    const e = unwrap(await graphStore.createEntity(scope, { entityTypeKey: 'Opportunity', canonicalKey: `memoire:opportunity:${key}`, name, sourceSystem: 'memoire' }), name).entity;
    const v = unwrap(await valueGraph.upsertValueNode(scope, { metricKey: 'OpportunityValue', subjectEntityId: e.id, timeHorizon: 'current', label: `Opportunity Value — ${name}` }), 'value node');
    unwrap(await valueGraph.recordObservation(scope, { nodeId: v.id, observationType: 'ACTUAL', numericValue: value, unitType: 'currency', currency: 'SGD', effectiveAt: at, observedAt: at, sourceSystem: 'memoire' }), 'value');
    let p = null;
    if (probability !== null) {
      p = unwrap(await valueGraph.upsertValueNode(scope, { metricKey: 'OpportunityProbability', subjectEntityId: e.id, timeHorizon: 'current', label: `Opportunity Probability — ${name}` }), 'probability node');
      unwrap(await valueGraph.recordObservation(scope, { nodeId: p.id, observationType: 'ACTUAL', numericValue: probability, unitType: 'ratio', effectiveAt: at, observedAt: at, sourceSystem: 'memoire' }), 'probability');
    }
    opps[key] = { entity: e, value: v, probability: p };
  }
  return { engine, valueGraph, graphStore, ontology, registry, opps };
}

describe('derived positions over a source-only world', () => {
  test('without positions, the whole model computes nothing — the defect the audit found', async () => {
    const w = await memoireWorld();
    const run = unwrap(await w.engine.execute(scope, { fromMetricKeys: ROOTS, horizon: 'quarter', triggerType: 'MANUAL' }), 'run');
    assert.equal(run.steps.length, 0);
  });

  test('positions appear only where every same-subject input exists, linked from those inputs; the model then computes them', async () => {
    const w = await memoireWorld();
    const deps = { registry: w.registry, valueGraph: w.valueGraph, graphStore: w.graphStore, ontology: w.ontology };
    const report = unwrap(await ensureDerivedPositions(deps, scope), 'ensure');
    const expected = report.created.filter((c) => c.metricKey === 'ExpectedRevenue');
    assert.equal(expected.length, 2, 'a and b qualify; c has no probability');
    assert.deepEqual(new Set(expected.map((c) => String(c.subjectEntityId))), new Set([String(w.opps.a.entity.id), String(w.opps.b.entity.id)]));
    assert.ok(report.notSameSubject.length > 0, 'calculations needing a related or scoped input are named, not guessed at');
    for (const c of report.created) assert.ok(c.label.includes(' — '), 'a position names its subject');

    const node = unwrap(await w.valueGraph.getValueNode(scope, expected[0].nodeId), 'position');
    assert.equal(node.timeHorizon, 'quarter');
    const links = unwrap(await w.valueGraph.findValueLinks(scope, { targetNodeId: node.id }), 'links');
    assert.equal(links.length, 2, 'DRIVES from value and probability');
    assert.ok(links.every((l) => l.linkType === 'DRIVES'));
    const none = unwrap(await w.valueGraph.getLatestObservation(scope, { nodeId: node.id, type: 'DERIVED' }), 'no observation');
    assert.equal(none, null, 'a position is structure only — no value is written by ensuring it');

    const run = unwrap(await w.engine.execute(scope, { fromMetricKeys: ROOTS, horizon: 'quarter', triggerType: 'MANUAL' }), 'run');
    const computed = run.steps.filter((s) => s.calculationKey === 'expected_revenue' && s.status === 'CALCULATED');
    assert.equal(computed.length, 2);
    const forA = computed.find((s) => s.outputNodeId === report.created.find((c) => String(c.subjectEntityId) === String(w.opps.a.entity.id) && c.metricKey === 'ExpectedRevenue').nodeId);
    assert.equal(Number(forA.outputValue), 20000, '200 000 × 0.1');
  });

  test('ensuring twice creates nothing the second time', async () => {
    const w = await memoireWorld();
    const deps = { registry: w.registry, valueGraph: w.valueGraph, graphStore: w.graphStore, ontology: w.ontology };
    const first = unwrap(await ensureDerivedPositions(deps, scope), 'first');
    const second = unwrap(await ensureDerivedPositions(deps, scope), 'second');
    assert.ok(first.created.length > 0);
    assert.equal(second.created.length, 0);
    assert.ok(second.existing >= first.created.length);
    const links = unwrap(await w.valueGraph.findValueLinks(scope, { limit: 1000 }), 'links');
    assert.equal(links.length, first.created.length * 2, 'no duplicate links');
  });
});
