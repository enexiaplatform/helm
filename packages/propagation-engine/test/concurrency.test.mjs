/**
 * Concurrency — the steps of one topological depth may run side by side (a networked store sets this; each step is
 * several round trips). Running them so must change nothing a reader can see: the same steps, in the same recorded
 * sequence, with the same values, as the plan run strictly in order.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '@helm/shared';
import { buildCanonicalScenario, createInMemoryGraphStore } from '@helm/graph-store';
import { buildCanonicalValueChain, buildSeedValueRegistry, createInMemoryValueGraph } from '@helm/value-graph';
import {
  createCalculationRegistry,
  createInMemoryCalculationStore,
  createPropagationEngine,
  ensureDerivedPositions,
  meridianValueModelV1,
  meridianValueModelV1_1,
} from '../src/index.ts';

const scope = {
  orgId: asOrgId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  actorId: asUserId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};
const ROOTS = ['OpportunityValue', 'OpportunityProbability', 'UnitCost', 'AverageSellingPrice'];

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

function base() {
  let tick = 0;
  const start = Date.parse('2026-10-11T05:00:00.000Z');
  const clock = { now: () => new Date(start + (tick += 1) * 1000) };
  const idGen = seqIdGen('c');
  const ontology = buildSeedRegistry();
  const metrics = buildSeedValueRegistry();
  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const valueGraph = createInMemoryValueGraph({ metrics, ontology, graphStore, clock, idGen });
  return { clock, idGen, ontology, metrics, graphStore, valueGraph };
}

/** Twelve source-only opportunities with value and probability: one depth, twelve steps that do not wait on each other. */
async function wideWorld(concurrency) {
  const w = base();
  const registry = unwrap(createCalculationRegistry(meridianValueModelV1_1, w.metrics), 'registry');
  const at = asValidTime('2026-10-06T00:00:00.000Z');
  for (let i = 0; i < 12; i++) {
    const e = unwrap(await w.graphStore.createEntity(scope, { entityTypeKey: 'Opportunity', canonicalKey: `memoire:opportunity:o${i}`, name: `Opportunity ${i}`, sourceSystem: 'memoire' }), 'opportunity').entity;
    const v = unwrap(await w.valueGraph.upsertValueNode(scope, { metricKey: 'OpportunityValue', subjectEntityId: e.id, timeHorizon: 'current', label: `Opportunity Value — ${i}` }), 'value node');
    unwrap(await w.valueGraph.recordObservation(scope, { nodeId: v.id, observationType: 'ACTUAL', numericValue: 1000 * (i + 1), unitType: 'currency', currency: 'SGD', effectiveAt: at, observedAt: at, sourceSystem: 'memoire' }), 'value');
    const p = unwrap(await w.valueGraph.upsertValueNode(scope, { metricKey: 'OpportunityProbability', subjectEntityId: e.id, timeHorizon: 'current', label: `Opportunity Probability — ${i}` }), 'probability node');
    unwrap(await w.valueGraph.recordObservation(scope, { nodeId: p.id, observationType: 'ACTUAL', numericValue: (i % 10) / 10, unitType: 'ratio', effectiveAt: at, observedAt: at, sourceSystem: 'memoire' }), 'probability');
  }
  unwrap(await ensureDerivedPositions({ registry, valueGraph: w.valueGraph, graphStore: w.graphStore, ontology: w.ontology }, scope), 'positions');
  const engine = unwrap(createPropagationEngine({ registry, valueGraph: w.valueGraph, graphStore: w.graphStore, ontology: w.ontology, store: createInMemoryCalculationStore({ clock: w.clock, idGen: w.idGen }), clock: w.clock, concurrency }), 'engine');
  return { ...w, engine };
}

/** The canonical chain: one subject, many depths, each reading what the one before it wrote in the same run. */
async function deepWorld(concurrency) {
  const w = base();
  unwrap(await buildCanonicalScenario(w.graphStore, scope), 'entity graph');
  unwrap(await buildCanonicalValueChain(w.valueGraph, w.graphStore, scope), 'value chain');
  const registry = unwrap(createCalculationRegistry(meridianValueModelV1, w.metrics), 'registry');
  const engine = unwrap(createPropagationEngine({ registry, valueGraph: w.valueGraph, graphStore: w.graphStore, ontology: w.ontology, store: createInMemoryCalculationStore({ clock: w.clock, idGen: w.idGen }), clock: w.clock, concurrency }), 'engine');
  return { ...w, engine };
}

const shape = (run) => run.steps.map((s) => [s.sequence, s.calculationKey, s.outputNodeId, s.status, s.outputValue]);

describe('concurrent steps change nothing a reader can see', () => {
  test('a wide depth: the same steps, sequence and values as the plan run in order', async () => {
    const one = await wideWorld(1);
    const eight = await wideWorld(8);
    const a = unwrap(await one.engine.execute(scope, { fromMetricKeys: ROOTS, horizon: 'quarter', triggerType: 'MANUAL' }), 'in order');
    const b = unwrap(await eight.engine.execute(scope, { fromMetricKeys: ROOTS, horizon: 'quarter', triggerType: 'MANUAL' }), 'side by side');
    assert.ok(a.steps.length >= 12);
    assert.deepEqual(shape(b), shape(a));
    assert.deepEqual(b.steps.map((s) => s.sequence), b.steps.map((_, i) => i + 1), 'sequence is the place in the plan');
    assert.deepEqual(b.summary, a.summary);
  });

  test('a deep chain: every depth still reads the one before it', async () => {
    const one = await deepWorld(1);
    const eight = await deepWorld(8);
    const asOf = new Date('2026-09-19T12:00:00.000Z');
    const a = unwrap(await one.engine.execute(scope, { fromMetricKeys: ROOTS, asOf, triggerType: 'MANUAL' }), 'in order');
    const b = unwrap(await eight.engine.execute(scope, { fromMetricKeys: ROOTS, asOf, triggerType: 'MANUAL' }), 'side by side');
    assert.ok(a.summary.CALCULATED > 3, 'the chain computes through several depths');
    assert.deepEqual(shape(b), shape(a));
  });
});
