/**
 * The Phase 2 canonical demonstration, as executable tests.
 *
 * Walks the value chain the phase brief specifies:
 *
 *   Rohto → Opportunity → Expected Revenue → Demand → Inventory Requirement
 *     → { Inventory Gap, Service Level } → Working Capital → Gross Margin
 *     → Cash → Enterprise Value dimensions
 *
 * And proves the three things that separate a value graph from an ontology
 * with financial labels:
 *
 *   1. the chain is connected and traversable in both directions
 *   2. enterprise value is several competing dimensions, not one score
 *   3. two value streams contend for one constrained resource
 *
 * It also proves the negative that defines the phase boundary: changing an
 * upstream observation does NOT change anything downstream. That is Phase 3.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, asValidTime, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore, buildCanonicalScenario } from '@helm/graph-store';
import { createInMemoryValueGraph } from '../src/inMemory.ts';
import { buildSeedValueRegistry } from '../src/registry.ts';
import { buildCanonicalValueChain } from '../src/canonicalValueChain.ts';

const scope = {
  orgId: asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
  return r.value;
};

async function freshValueChain() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const clock = { now: () => new Date(base + (tick += 1) * 1000) };
  const idGen = seqIdGen('v');
  const ontology = buildSeedRegistry();

  const graphStore = createInMemoryGraphStore({ registry: ontology, clock, idGen });
  const entityGraph = unwrap(await buildCanonicalScenario(graphStore, scope), 'entity graph');

  const valueGraph = createInMemoryValueGraph({
    metrics: buildSeedValueRegistry(),
    ontology,
    graphStore,
    clock,
    idGen,
  });
  const built = unwrap(await buildCanonicalValueChain(valueGraph, graphStore, scope), 'value chain');

  return { valueGraph, graphStore, ids: built.nodeIds, scenarios: built.scenarioIds, built, entityGraph };
}

describe('canonical value chain — Meridian Life Sciences Vietnam', () => {
  test('the value layer builds over the entity graph', async () => {
    const { built } = await freshValueChain();
    assert.equal(built.nodeCount, 33, 'value nodes');
    assert.equal(built.linkCount, 39, 'value links');
    assert.equal(built.observationCount, 40, 'observations');
  });

  test('value nodes reference ontology entities rather than duplicating them', async () => {
    const { valueGraph, graphStore, ids } = await freshValueChain();
    const node = unwrap(await valueGraph.getValueNode(scope, ids.expRevenue), 'node');
    assert.ok(node.subjectEntityId, 'the node is about an entity');

    const entity = unwrap(await graphStore.getEntity(scope, node.subjectEntityId), 'entity');
    assert.equal(entity.canonicalKey, 'memoire:opportunity:opp-8821');
    assert.equal(entity.sourceSystem, 'memoire', 'Memoire remains the system of record');
    // The value node holds no copy of the opportunity's own attributes.
    assert.equal(node.metadata.value, undefined);
  });

  test('STEP: the whole canonical chain is connected, opportunity to enterprise value', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const chain = unwrap(
      await valueGraph.getValueChain(scope, {
        start: [ids.oppValue],
        maxDepth: 8,
        direction: 'downstream',
      }),
      'downstream chain',
    );
    const reached = new Set(chain.nodes.map((n) => n.node.id));

    for (const [handle, label] of [
      ['expRevenue', 'Expected Revenue'],
      ['demand', 'Product Demand'],
      ['invRequirement', 'Inventory Requirement'],
      ['invGap', 'Inventory Gap'],
      ['serviceLevel', 'Service Level'],
      ['invValue', 'Inventory Value'],
      ['workingCapital', 'Working Capital'],
      ['grossMargin', 'Gross Margin'],
      ['evCash', 'Enterprise Value — Cash'],
      ['evMargin', 'Enterprise Value — Margin'],
      ['evService', 'Enterprise Value — Service'],
    ]) {
      assert.ok(reached.has(ids[handle]), `chain reaches ${label}`);
    }
  });

  test('the chain is walkable upstream: why does enterprise value cash move?', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const up = unwrap(
      await valueGraph.findUpstreamValueNodes(scope, ids.evCash, 8),
      'upstream from EV cash',
    );
    const reached = new Set(up.nodes.map((n) => n.node.id));

    assert.ok(reached.has(ids.workingCapital), 'cash traces back to working capital');
    assert.ok(reached.has(ids.grossMargin), 'and to gross margin');
    assert.ok(reached.has(ids.invValue), 'and to the inventory that ties capital up');
    assert.ok(reached.has(ids.expRevenue), 'and all the way back to expected revenue');
    assert.ok(reached.has(ids.oppValue), 'and to the opportunity that originated it');
  });

  test('ENTERPRISE VALUE IS MULTI-DIMENSIONAL, not one score', async () => {
    const { valueGraph, graphStore, ids } = await freshValueChain();
    const evEntity = unwrap(
      await graphStore.findEntities(scope, {
        canonicalKeys: ['helm:enterprisevalue:meridian-ev'],
      }),
      'ev entity',
    )[0];

    const nodes = unwrap(
      await valueGraph.findNodesForEntity(scope, evEntity.id),
      'ev value nodes',
    );
    assert.equal(nodes.length, 6, 'enterprise value has six dimension nodes, not one number');

    const metrics = await Promise.all(
      nodes.map(async (n) => unwrap(await valueGraph.getMetricDefinition(scope, n.metricKey), n.metricKey)),
    );
    const dimensions = new Set(metrics.map((m) => m.dimension));
    for (const d of ['CAPITAL', 'FINANCIAL', 'CUSTOMER', 'RISK', 'STRATEGIC']) {
      assert.ok(dimensions.has(d), `the ${d} dimension of enterprise value exists`);
    }

    // And they genuinely trade off: one is higher-is-better, another lower.
    const directions = new Set(metrics.map((m) => m.directionality));
    assert.ok(directions.has('HIGHER_IS_BETTER'));
    assert.ok(directions.has('LOWER_IS_BETTER'), 'some dimensions pull the other way');
    assert.ok(nodes.every((n) => n.id !== ids.evCash || true));
  });

  test('the inventory trade-off is representable: service up AND capital up', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const fromAvail = unwrap(
      await valueGraph.getValueNeighborhood(scope, ids.availOwn, 'downstream'),
      'downstream of available inventory',
    );
    const linkTypes = new Map(fromAvail.map((n) => [n.node.id, n.via.linkType]));

    assert.equal(linkTypes.get(ids.serviceLevel), 'ENABLES', 'stock enables service');
    assert.equal(linkTypes.get(ids.invGap), 'CONSTRAINS', 'and constrains the gap');
    assert.equal(
      linkTypes.get(ids.futureOppRisk),
      'EXPOSES',
      'and exposes the next tender — the cost of committing it',
    );

    // The capital side of the same stock.
    const toWc = unwrap(
      await valueGraph.getValueNeighborhood(scope, ids.workingCapital, 'upstream'),
      'upstream of working capital',
    );
    assert.ok(
      toWc.some((n) => n.node.id === ids.invValue && n.via.linkType === 'CONSUMES'),
      'the same inventory consumes working capital',
    );
  });

  test('CONTENTION: two value streams consume one inventory position', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const contention = unwrap(await valueGraph.findContention(scope), 'contention');

    const onOwnStock = contention.find((c) => c.node.id === ids.availOwn);
    assert.ok(onOwnStock, 'company stock is a contended resource');
    assert.equal(onOwnStock.claimants.length, 2, 'two demands claim it');
    assert.equal(onOwnStock.totalClaimedWeight, 8, 'claiming 8 units in total');

    const claimantNodeIds = onOwnStock.claimants.map((c) => c.node.id);
    assert.ok(claimantNodeIds.includes(ids.demand), 'the Rohto Q4 tender');
    assert.ok(claimantNodeIds.includes(ids.demandNext), 'and the provincial tender');

    // Available stock is 4; demand on it is 8. The shortfall is visible
    // structurally, without anything having computed it.
    const avail = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.availOwn, type: 'ACTUAL' }),
      'available',
    );
    assert.equal(avail.numericValue, 4);
    assert.ok(
      onOwnStock.totalClaimedWeight > avail.numericValue,
      'claimed exceeds available — the trade-off is visible in the graph',
    );
  });

  test('OBSERVATION TYPES coexist on one node: actual, forecast, target, scenario', async () => {
    const { valueGraph, ids, scenarios } = await freshValueChain();

    const all = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.grossMarginPct }),
      'gross margin % observations',
    );
    const byType = new Map(all.map((o) => [`${o.observationType}:${o.scenarioEntityId ?? ''}`, o]));

    assert.equal(byType.get('ACTUAL:').numericValue, 38, 'what is');
    assert.equal(byType.get('FORECAST:').numericValue, 35, 'what we expect');
    assert.equal(byType.get('TARGET:').numericValue, 40, 'what we want');
    assert.equal(
      byType.get(`SCENARIO:${scenarios.expedite}`).numericValue,
      34,
      'what would happen if we expedite',
    );
    assert.equal(
      byType.get(`SCENARIO:${scenarios.reallocate}`).numericValue,
      37,
      'what would happen if we reallocate',
    );
    assert.equal(all.length, 5, 'five coexisting facts, none superseding another');

    // Reality must be separable from the modelled alternatives.
    const reality = unwrap(
      await valueGraph.getObservations(scope, {
        nodeId: ids.grossMarginPct,
        scenarioEntityId: null,
      }),
      'reality only',
    );
    assert.equal(reality.length, 3, 'actual, forecast and target are reality; scenarios are not');
  });

  test('a scenario view of the chain shows scenario numbers, not actuals', async () => {
    const { valueGraph, ids, scenarios } = await freshValueChain();

    const expedite = unwrap(
      await valueGraph.getValueChain(scope, {
        start: [ids.grossMarginPct],
        maxDepth: 1,
        direction: 'both',
        scenarioEntityId: scenarios.expedite,
      }),
      'expedite view',
    );
    const gmNode = expedite.nodes.find((n) => n.node.id === ids.grossMarginPct);
    assert.equal(gmNode.observations.length, 1, 'only the expedite scenario value');
    assert.equal(gmNode.observations[0].numericValue, 34);

    const reality = unwrap(
      await valueGraph.getValueChain(scope, {
        start: [ids.grossMarginPct],
        maxDepth: 1,
        direction: 'both',
        scenarioEntityId: null,
      }),
      'reality view',
    );
    const gmReal = reality.nodes.find((n) => n.node.id === ids.grossMarginPct);
    assert.equal(gmReal.observations.length, 3, 'actual, forecast, target');
    assert.ok(gmReal.observations.every((o) => o.scenarioEntityId === null));
  });

  test('units are unambiguous: 4.2B VND is not 4.2B of something', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const v = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.oppValue, type: 'ACTUAL' }),
      'opportunity value',
    );
    assert.equal(v.numericValue, 4.2e9);
    assert.equal(v.unitType, 'currency');
    assert.equal(v.currency, 'VND');

    const p = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.oppProb, type: 'ACTUAL' }),
      'probability',
    );
    assert.equal(p.numericValue, 0.7);
    assert.equal(p.unitType, 'ratio', '0.7 as a ratio, never 70 as a percentage');
    assert.equal(p.currency, null);

    const svc = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.serviceLevel, type: 'TARGET' }),
      'service target',
    );
    assert.equal(svc.numericValue, 98);
    assert.equal(svc.unitType, 'percentage', '98 as a percentage, never 0.98');
  });

  test('every observation has traceable provenance', async () => {
    const { valueGraph, ids } = await freshValueChain();
    let checked = 0;
    for (const nodeId of Object.values(ids)) {
      const obs = unwrap(await valueGraph.getObservations(scope, { nodeId }), 'observations');
      for (const o of obs) {
        assert.ok(o.provenanceId, `observation ${o.id} on ${nodeId} has no provenance reference`);
        const prov = unwrap(
          await valueGraph.getObservationProvenance(scope, o.id),
          'provenance record',
        );
        assert.ok(prov.length > 0, `no provenance record resolves for observation ${o.id}`);
        assert.ok(prov[0].system, 'provenance names a source system');
        assert.ok(prov[0].method, 'and how the fact was acquired');
        checked += 1;
      }
    }
    assert.ok(checked >= 38, `expected to check 38+ observations, checked ${checked}`);
  });

  test('a management judgement is recorded as an ASSUMPTION, not an actual', async () => {
    const { valueGraph, ids } = await freshValueChain();
    const obs = unwrap(
      await valueGraph.getObservations(scope, { nodeId: ids.strategicAlign }),
      'strategic alignment',
    );
    assert.equal(obs.length, 1);
    assert.equal(obs[0].observationType, 'ASSUMPTION', 'a judgement is not a measurement');
    const prov = unwrap(
      await valueGraph.getObservationProvenance(scope, obs[0].id),
      'provenance',
    );
    assert.equal(prov[0].method, 'human_assumption');
  });

  // ---- the negative that defines the Phase 2 / Phase 3 boundary ----

  test('PHASE BOUNDARY: changing an upstream observation does NOT move downstream', async () => {
    const { valueGraph, ids } = await freshValueChain();

    const before = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.expRevenue, type: 'FORECAST' }),
      'expected revenue before',
    );
    assert.equal(before.numericValue, 2.94e9);

    // Move probability from 0.70 to 0.90 — the classic propagation trigger.
    unwrap(
      await valueGraph.recordObservation(scope, {
        nodeId: ids.oppProb,
        observationType: 'ACTUAL',
        numericValue: 0.9,
        unitType: 'ratio',
        effectiveAt: asValidTime('2026-09-20T00:00:00.000Z'),
        observedAt: asValidTime('2026-09-20T00:00:00.000Z'),
        sourceSystem: 'memoire',
        confidence: 0.9,
      }),
      'new probability',
    );

    const prob = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.oppProb, type: 'ACTUAL' }),
      'probability after',
    );
    assert.equal(prob.numericValue, 0.9, 'the new fact is recorded');

    const after = unwrap(
      await valueGraph.getLatestObservation(scope, { nodeId: ids.expRevenue, type: 'FORECAST' }),
      'expected revenue after',
    );
    assert.equal(
      after.numericValue,
      2.94e9,
      'expected revenue is UNCHANGED — Phase 2 represents value, Phase 3 moves it',
    );

    // The dependency is nonetheless visible: the structure knows they are linked.
    const links = unwrap(
      await valueGraph.findValueLinks(scope, { sourceNodeId: ids.oppProb }),
      'links from probability',
    );
    assert.ok(
      links.some((l) => l.targetNodeId === ids.expRevenue && l.linkType === 'DRIVES'),
      'the DRIVES dependency exists, it is simply not evaluated',
    );
  });

  test('building twice is idempotent', async () => {
    const { valueGraph, graphStore, built } = await freshValueChain();
    const again = await buildCanonicalValueChain(valueGraph, graphStore, scope);
    assert.equal(again.ok, true);

    const nodes = unwrap(await valueGraph.findValueNodes(scope, { limit: 500 }), 'nodes');
    assert.equal(nodes.length, built.nodeCount, 'no duplicate value nodes');

    const links = unwrap(await valueGraph.findValueLinks(scope, { limit: 500 }), 'links');
    assert.equal(links.length, built.linkCount, 'no duplicate value links');
  });
});
