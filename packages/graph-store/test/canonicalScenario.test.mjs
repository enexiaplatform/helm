/**
 * The Phase 1 canonical proof, as an executable test.
 *
 * Runs the exact six-step flow the phase was specified against:
 *   1. Find Rohto Vietnam, return its canonical HELM entity
 *   2. Traverse Rohto -> Opportunity -> SKU-X
 *   3. Continue SKU-X -> Inventory -> Warehouse
 *   4. Inspect the opportunity: source system, source id, observed_at, confidence
 *   5. Inspect relationship provenance
 *   6. Same graph, both adapters (the in-memory half runs here; the Postgres
 *      half runs in postgres.conformance.test.mjs when credentials are present)
 *
 * If this file goes green, HELM can represent an enterprise as a connected
 * semantic system. If it only proved CRUD, steps 2, 3 and the contention
 * assertions would not be expressible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRegistry } from '@helm/ontology';
import { asOrgId, asUserId, seqIdGen } from '@helm/shared';
import { createInMemoryGraphStore } from '../src/inMemory.ts';
import { buildCanonicalScenario } from '../src/canonicalScenario.ts';

const scope = {
  orgId: asOrgId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  actorId: asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

async function freshGraph() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  const store = createInMemoryGraphStore({
    registry: buildSeedRegistry(),
    clock: { now: () => new Date(base + (tick += 1) * 1000) },
    idGen: seqIdGen('e'),
  });
  const built = await buildCanonicalScenario(store, scope);
  assert.equal(built.ok, true, built.ok ? '' : JSON.stringify(built.error));
  return { store, ids: built.value.ids, built: built.value };
}

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' ' + r.error.message}`);
  return r.value;
};

describe('canonical scenario — Meridian Life Sciences Vietnam', () => {
  test('the graph builds completely', async () => {
    const { built } = await freshGraph();
    assert.equal(built.entityCount, 32, 'entity count');
    assert.equal(built.relationshipCount, 42, 'relationship count');
  });

  test('STEP 1 — find Rohto Vietnam and return its canonical entity', async () => {
    const { store } = await freshGraph();
    const found = unwrap(
      await store.findEntities(scope, { search: 'Rohto', entityTypeKeys: ['Customer'] }),
      'search',
    );
    assert.equal(found.length, 1, 'exactly one Rohto');
    const rohto = found[0];
    assert.equal(rohto.name, 'Rohto Vietnam');
    assert.equal(rohto.entityTypeKey, 'Customer');
    assert.equal(rohto.canonicalKey, 'memoire:customer:a3f2c1d4');
    assert.equal(rohto.sourceSystem, 'memoire', 'Memoire remains the system of record');
    assert.equal(rohto.sourceEntityType, 'account');
    assert.equal(rohto.sourceEntityId, 'a3f2c1d4', 'reference, not a copy');
  });

  test('STEP 1b — the same entity resolves from three external identifiers', async () => {
    const { store, ids } = await freshGraph();
    // Memoire says a3f2c1d4, ERP says C004182, Finance says ROHTO-VN-001.
    for (const [system, value] of [
      ['memoire', 'a3f2c1d4'],
      ['erp', 'C004182'],
      ['finance', 'ROHTO-VN-001'],
    ]) {
      const hits = unwrap(await store.findByAlias(scope, system, value), `alias ${value}`);
      assert.equal(hits.length, 1, `${system}:${value} resolves`);
      assert.equal(hits[0].id, ids.rohto, `${system}:${value} is the same management entity`);
    }
  });

  test('STEP 2 — traverse Rohto -> Opportunity -> SKU-X', async () => {
    const { store, ids } = await freshGraph();
    const walk = unwrap(
      await store.traverse(scope, { start: [ids.rohto], maxDepth: 2, direction: 'both' }),
      'traverse',
    );

    const byId = new Map(walk.nodes.map((n) => [n.entity.id, n]));
    const oppNow = byId.get(ids.oppNow);
    assert.ok(oppNow, 'reaches the opportunity');
    assert.equal(oppNow.depth, 1);

    const sku = byId.get(ids.skuX);
    assert.ok(sku, 'reaches SKU-X through the opportunity');
    assert.equal(sku.depth, 2);
    assert.equal(sku.entity.name, 'SKU-X Benchtop Analyzer');

    // Confidence degrades along the chain: HELD_BY (none = 1) x SELLS (0.7).
    assert.equal(
      Math.round(sku.pathConfidence * 100) / 100,
      0.7,
      'a two-hop path is no more certain than its weakest edge',
    );
  });

  test('STEP 3 — continue SKU-X -> Inventory -> Warehouse', async () => {
    const { store, ids } = await freshGraph();
    const walk = unwrap(
      await store.traverse(scope, { start: [ids.skuX], maxDepth: 2, direction: 'both' }),
      'traverse',
    );
    const byId = new Map(walk.nodes.map((n) => [n.entity.id, n]));

    assert.ok(byId.get(ids.invOwn), 'reaches company inventory position');
    assert.ok(byId.get(ids.invDist), 'reaches distributor inventory position');
    assert.equal(byId.get(ids.invOwn).depth, 1);

    const wh = byId.get(ids.whHCMC);
    assert.ok(wh, 'reaches the warehouse behind the position');
    assert.equal(wh.depth, 2);

    // The two positions are distinct assets, which is the whole point of
    // modelling InventoryPosition rather than a single stock number.
    assert.equal(byId.get(ids.invOwn).entity.attributes.stockOnHand, 4);
    assert.equal(byId.get(ids.invDist).entity.attributes.stockOnHand, 8);
    assert.equal(byId.get(ids.invOwn).entity.attributes.ownership, 'own');
    assert.equal(byId.get(ids.invDist).entity.attributes.ownership, 'distributor');
  });

  test('STEP 4 — inspect the opportunity: source, id, observed time, confidence', async () => {
    const { store, ids } = await freshGraph();
    const opp = unwrap(await store.getEntity(scope, ids.oppNow), 'get opportunity');
    assert.ok(opp);
    assert.equal(opp.sourceSystem, 'memoire');
    assert.equal(opp.sourceEntityType, 'opportunity');
    assert.equal(opp.sourceEntityId, 'opp-8821');
    assert.equal(opp.observedAt, '2026-09-18T11:02:00.000Z', 'when the source asserted it');
    assert.equal(opp.confidence, 0.7);
    assert.ok(opp.ingestedAt, 'when HELM learned it — a different fact');
    assert.notEqual(opp.observedAt, opp.ingestedAt, 'valid time and record time are distinct');
    assert.equal(opp.attributes.value, 4.2e9);
    assert.equal(opp.attributes.probability, 0.7);
  });

  test('STEP 5 — inspect entity and relationship provenance', async () => {
    const { store, ids } = await freshGraph();

    const entityProv = unwrap(
      await store.getProvenance(scope, 'entity', ids.oppNow),
      'entity provenance',
    );
    assert.equal(entityProv.length, 1);
    assert.equal(entityProv[0].method, 'ingested');
    assert.equal(entityProv[0].system, 'memoire');
    assert.equal(entityProv[0].connector, 'canonical-scenario@0.1.0');
    assert.equal(entityProv[0].sourceObjectId, 'opp-8821');
    assert.ok(entityProv[0].ingestionEventId, 'grouped into an ingestion event');
    assert.match(entityProv[0].transformation, /reference \+ snapshot/);

    const rels = unwrap(
      await store.findRelationships(scope, {
        sourceEntityId: ids.oppNow,
        relationshipTypeKeys: ['SELLS'],
      }),
      'SELLS edge',
    );
    assert.equal(rels.length, 1);
    const relProv = unwrap(
      await store.getProvenance(scope, 'relationship', rels[0].id),
      'relationship provenance',
    );
    assert.equal(relProv.length, 1, 'edges carry provenance too, not just nodes');
    assert.equal(relProv[0].method, 'seeded');
    assert.equal(relProv[0].confidence, 0.7);
  });

  // ---- the assertions that separate a value model from graph CRUD ----

  test('the enterprise is genuinely connected: opportunity reaches enterprise value', async () => {
    const { store, ids } = await freshGraph();
    const paths = unwrap(
      await store.paths(scope, ids.oppNow, ids.ev, { maxDepth: 6, direction: 'both' }),
      'paths to enterprise value',
    );
    assert.ok(paths.length > 1, 'more than one route — this is a graph, not a list');

    // The claim that matters: a commercial opportunity reaches enterprise value
    // *through the operational and financial chain*. That is the value spine, and
    // no amount of CRUD would produce it.
    const viaWorkingCapital = paths.filter(
      (p) => p.entityIds.includes(ids.wcInventory) && p.entityIds.includes(ids.cashVN),
    );
    assert.ok(
      viaWorkingCapital.length > 0,
      'a route runs opportunity -> inventory -> working capital -> cash -> enterprise value',
    );

    const spine = viaWorkingCapital[0];
    assert.ok(
      spine.entityIds.length >= 5,
      `the value spine crosses commercial, operations, finance and value (${spine.entityIds.length} nodes)`,
    );
    assert.ok(
      spine.pathConfidence > 0 && spine.pathConfidence <= 1,
      'the chain carries a computed confidence',
    );

    // Every path's confidence is the product of its edges, so a longer, weaker
    // route is never reported as more certain than a short, strong one.
    const sorted = [...paths].map((p) => p.pathConfidence);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), 'paths ranked by confidence');
  });

  test('CONTENTION: two opportunities consume the same inventory position', async () => {
    const { store, ids } = await freshGraph();
    const consumers = unwrap(
      await store.getNeighbors(scope, {
        entityId: ids.invOwn,
        direction: 'in',
        relationshipTypeKeys: ['CONSUMES'],
      }),
      'consumers of company stock',
    );
    assert.equal(consumers.length, 2, 'this month and next month both want the same 4 units');

    const names = consumers.map((c) => c.entity.name).sort();
    assert.ok(names.some((n) => n.includes('Rohto Q4')));
    assert.ok(names.some((n) => n.includes('Provincial hospital')));

    // Demanded quantity exceeds the position — the gap is visible in the graph,
    // not inferred by a reader comparing two dashboards.
    const demanded = consumers.reduce((sum, c) => sum + (c.via.weight ?? 0), 0);
    const onHand = Number(
      unwrap(await store.getEntity(scope, ids.invOwn), 'inv').attributes.stockOnHand,
    );
    assert.equal(demanded, 8);
    assert.ok(demanded > onHand, `demand ${demanded} exceeds stock ${onHand}`);

    const competes = unwrap(
      await store.findRelationships(scope, {
        eitherEndpoint: ids.oppNow,
        relationshipTypeKeys: ['COMPETES_WITH'],
      }),
      'competition edge',
    );
    assert.equal(competes.length, 1, 'the trade-off is modelled explicitly');
  });

  test('accountability resolves to a Role, and through it to a Person', async () => {
    const { store, ids } = await freshGraph();
    const owners = unwrap(
      await store.getNeighbors(scope, {
        entityId: ids.objMargin,
        direction: 'out',
        relationshipTypeKeys: ['OWNED_BY'],
      }),
      'objective owner',
    );
    assert.equal(owners.length, 1);
    assert.equal(owners[0].entity.entityTypeKey, 'Role', 'authority attaches to the role');
    assert.equal(owners[0].entity.name, 'Country GM Vietnam');

    const holders = unwrap(
      await store.getNeighbors(scope, {
        entityId: ids.roleGM,
        direction: 'in',
        relationshipTypeKeys: ['HOLDS_ROLE'],
      }),
      'role holder',
    );
    assert.equal(holders.length, 1);
    assert.equal(holders[0].entity.entityTypeKey, 'Person');
  });

  test('the structural spine is walkable from the group down to a function', async () => {
    const { store, ids } = await freshGraph();
    const walk = unwrap(
      await store.traverse(scope, {
        start: [ids.group],
        maxDepth: 4,
        direction: 'in',
        relationshipTypeKeys: ['BELONGS_TO'],
      }),
      'org spine',
    );
    const names = walk.nodes.map((n) => n.entity.name);
    for (const expected of ['Southeast Asia', 'Vietnam', 'Pharma BU', 'Commercial', 'Finance']) {
      assert.ok(names.includes(expected), `spine reaches ${expected}`);
    }
  });

  test('building twice is idempotent — no duplicate entities', async () => {
    const { store, built } = await freshGraph();
    const again = await buildCanonicalScenario(store, scope);
    assert.equal(again.ok, true);

    const all = unwrap(await store.findEntities(scope, { limit: 1000 }), 'all entities');
    assert.equal(all.length, built.entityCount, 'a second build adds no entities');

    // Every entity should still be at version 1: nothing actually changed.
    const versions = await Promise.all(
      all.map(async (e) => unwrap(await store.getEntityHistory(scope, e.id), 'history').length),
    );
    assert.ok(
      versions.every((v) => v === 1),
      'an unchanged re-ingest writes no version rows',
    );
  });

  test('subtype queries see the Tender as an Opportunity', async () => {
    const { store } = await freshGraph();
    const opps = unwrap(
      await store.findEntities(scope, { entityTypeKeys: ['Opportunity'] }),
      'opportunities',
    );
    assert.equal(opps.length, 2, 'the Tender is an Opportunity');
    const exact = unwrap(
      await store.findEntities(scope, {
        entityTypeKeys: ['Opportunity'],
        includeSubtypes: false,
      }),
      'exact',
    );
    assert.equal(exact.length, 1);
  });
});
