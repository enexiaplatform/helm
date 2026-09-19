/**
 * The GraphStore conformance suite.
 *
 * ONE contract, run against EVERY adapter. This is the mechanism that makes the
 * graph abstraction real rather than merely asserted (ADR-0004): an
 * adapter-specific assumption fails here immediately, instead of surfacing years
 * later during a migration.
 *
 * Written runner-agnostically — it takes `describe`/`it`/`assert` — so it works
 * under `node --test` today and under any future runner without edits.
 */

import {
  asOrgId,
  asUserId,
  asValidTime,
  type EntityId,
  type Result,
  type Scope,
} from '@helm/shared';
import { canonicalKey } from '@helm/ontology';
import type { GraphStore } from './index.ts';

export type TestApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
};

export type AdapterHarness = {
  name: string;
  /** Fresh, empty store per test. Deterministic clock and ids are the caller's job. */
  create(): Promise<{ store: GraphStore; cleanup?: () => Promise<void> }>;
  /** Skip tests the adapter legitimately cannot support yet. */
  skip?: readonly string[];
};

export const ORG_A = asOrgId('11111111-1111-4111-8111-111111111111');
export const ORG_B = asUserId('22222222-2222-4222-8222-222222222222');
const USER_A = asUserId('33333333-3333-4333-8333-333333333333');

export const scopeA: Scope = {
  orgId: ORG_A,
  actorId: USER_A,
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

export const scopeB: Scope = {
  orgId: asOrgId('44444444-4444-4444-8444-444444444444'),
  actorId: asUserId('55555555-5555-4555-8555-555555555555'),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
};

function expectOk<T>(r: Result<T>, what: string): T {
  if (!r.ok) {
    throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  }
  return r.value;
}

/** Convenience: create an entity and return it, failing loudly on error. */
async function mkEntity(
  store: GraphStore,
  scope: Scope,
  typeKey: string,
  ref: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<EntityId> {
  const r = await store.createEntity(scope, {
    entityTypeKey: typeKey,
    canonicalKey: canonicalKey('helm', typeKey.toLowerCase(), ref),
    name,
    sourceSystem: 'helm',
    attributes: extra,
  });
  return expectOk(r, `create ${typeKey} ${ref}`).entity.id;
}

export function runConformanceSuite(api: TestApi, harness: AdapterHarness): void {
  const { describe, it, assert } = api;
  const skip = new Set(harness.skip ?? []);

  const test = (name: string, fn: () => Promise<void>) => {
    if (skip.has(name)) return;
    it(name, fn);
  };

  describe(`GraphStore conformance — ${harness.name}`, () => {
    // ------------------------------------------------------------ entities

    test('creates an entity with provenance and temporal fields', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const r = await store.createEntity(scopeA, {
          entityTypeKey: 'Opportunity',
          canonicalKey: 'memoire:opportunity:opp-1',
          name: 'Pharma tender',
          sourceSystem: 'memoire',
          sourceEntityType: 'opportunity',
          sourceEntityId: 'opp-1',
          observedAt: asValidTime('2026-09-18T11:02:00.000Z'),
          confidence: 0.7,
          attributes: { value: 4_200_000_000, currency: 'VND', probability: 0.7 },
        });
        const { entity, outcome } = expectOk(r, 'createEntity');
        assert.equal(outcome, 'created');
        assert.equal(entity.entityTypeKey, 'Opportunity');
        assert.equal(entity.sourceSystem, 'memoire');
        assert.equal(entity.sourceEntityId, 'opp-1');
        assert.equal(entity.confidence, 0.7);
        assert.equal(entity.version, 1);
        assert.equal(entity.validTo, null, 'a new entity is currently valid');
        assert.ok(entity.ingestedAt, 'record time is stamped');
        assert.equal(entity.attributes.probability, 0.7);
      } finally {
        await cleanup?.();
      }
    });

    test('rejects an unknown entity type', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const r = await store.createEntity(scopeA, {
          entityTypeKey: 'NotARealType',
          canonicalKey: 'helm:thing:1',
          name: 'x',
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'ontology.unknown_entity_type');
      } finally {
        await cleanup?.();
      }
    });

    test('rejects a canonical key without a namespace', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const r = await store.createEntity(scopeA, {
          entityTypeKey: 'Product',
          canonicalKey: 'SKU-X',
          name: 'SKU-X',
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'ontology.invalid_canonical_key');
      } finally {
        await cleanup?.();
      }
    });

    test('rejects attributes that violate the type schema', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const r = await store.createEntity(scopeA, {
          entityTypeKey: 'Opportunity',
          canonicalKey: 'memoire:opportunity:bad',
          name: 'Bad probability',
          sourceSystem: 'memoire',
          attributes: { probability: 4 }, // schema says 0..1
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'ontology.invalid_attributes');
      } finally {
        await cleanup?.();
      }
    });

    test('upsert is idempotent — re-ingesting identical values changes nothing', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const input = {
          entityTypeKey: 'Product',
          canonicalKey: 'helm:product:sku-x',
          name: 'SKU-X',
          sourceSystem: 'helm' as const,
          attributes: { sku: 'SKU-X', listPrice: 350_000_000 },
        };
        const first = expectOk(await store.upsertEntity(scopeA, input), 'first upsert');
        const second = expectOk(await store.upsertEntity(scopeA, input), 'second upsert');

        assert.equal(first.outcome, 'created');
        assert.equal(second.outcome, 'unchanged', 'identical re-ingest must not version');
        assert.equal(second.entity.version, 1, 'version must not advance');
        assert.equal(second.entity.id, first.entity.id, 'identity is stable');

        const history = expectOk(
          await store.getEntityHistory(scopeA, first.entity.id),
          'history',
        );
        assert.equal(history.length, 1, 'no version row for an unchanged upsert');
      } finally {
        await cleanup?.();
      }
    });

    test('upsert with changed values supersedes, preserving record-time history', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const base = {
          entityTypeKey: 'Opportunity',
          canonicalKey: 'memoire:opportunity:opp-1',
          name: 'Pharma tender',
          sourceSystem: 'memoire' as const,
        };
        const first = expectOk(
          await store.upsertEntity(scopeA, { ...base, confidence: 0.7, attributes: { probability: 0.7 } }),
          'first',
        );
        const second = expectOk(
          await store.upsertEntity(scopeA, { ...base, confidence: 0.9, attributes: { probability: 0.9 } }),
          'second',
        );

        assert.equal(second.outcome, 'updated');
        assert.equal(second.entity.id, first.entity.id, 'id is stable across versions');
        assert.equal(second.entity.version, 2);
        assert.equal(second.entity.confidence, 0.9);

        const history = expectOk(await store.getEntityHistory(scopeA, first.entity.id), 'history');
        assert.equal(history.length, 2, 'both versions retained');
        assert.equal(history[0].version, 1);
        assert.equal(history[0].snapshot.confidence, 0.7, 'old belief preserved');
        assert.ok(history[0].recordedTo !== null, 'superseded version is closed');
        assert.equal(history[1].recordedTo, null, 'current version is open');
      } finally {
        await cleanup?.();
      }
    });

    test('asOf returns the graph as it was valid at a past instant', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const id = await mkEntity(store, scopeA, 'Role', 'bu-head', 'BU Head');
        // Close validity at end of June: valid Jan–Jun.
        expectOk(
          await store.updateEntity(scopeA, id, {
            validFrom: asValidTime('2026-01-01T00:00:00.000Z'),
            validTo: asValidTime('2026-07-01T00:00:00.000Z'),
          }),
          'close validity',
        );

        const inMarch = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Role'], asOf: '2026-03-15T00:00:00.000Z' }),
          'asOf March',
        );
        assert.equal(inMarch.length, 1, 'valid in March');

        const inAugust = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Role'], asOf: '2026-08-15T00:00:00.000Z' }),
          'asOf August',
        );
        assert.equal(inAugust.length, 0, 'no longer valid in August');
      } finally {
        await cleanup?.();
      }
    });

    test('getEntityAsRecordedAt answers what HELM believed at a record time', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const base = {
          entityTypeKey: 'Opportunity',
          canonicalKey: 'memoire:opportunity:opp-2',
          name: 'Deal',
          sourceSystem: 'memoire' as const,
        };
        const first = expectOk(await store.upsertEntity(scopeA, { ...base, confidence: 0.5 }), 'v1');
        const history1 = expectOk(await store.getEntityHistory(scopeA, first.entity.id), 'h1');
        const afterV1 = history1[0].recordedFrom;

        expectOk(await store.upsertEntity(scopeA, { ...base, confidence: 0.95 }), 'v2');

        const believedThen = expectOk(
          await store.getEntityAsRecordedAt(scopeA, first.entity.id, afterV1),
          'as recorded at v1',
        );
        assert.ok(believedThen, 'a version was believed at that time');
        assert.equal(believedThen!.confidence, 0.5, 'the old belief, not the new one');

        const now = expectOk(await store.getEntity(scopeA, first.entity.id), 'current');
        assert.equal(now!.confidence, 0.95, 'current state is the new belief');
      } finally {
        await cleanup?.();
      }
    });

    test('retireEntity closes validity instead of deleting', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const id = await mkEntity(store, scopeA, 'Product', 'old-sku', 'Old SKU');
        expectOk(await store.retireEntity(scopeA, id), 'retire');

        const still = expectOk(await store.getEntity(scopeA, id), 'get');
        assert.ok(still, 'row still exists');
        assert.equal(still!.status, 'retired');

        const active = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Product'] }),
          'find active',
        );
        assert.equal(active.length, 0, 'retired entities are excluded by default');

        const all = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Product'], includeInactive: true }),
          'find all',
        );
        assert.equal(all.length, 1, 'still retrievable when asked for');
      } finally {
        await cleanup?.();
      }
    });

    // ------------------------------------------------------- relationships

    test('creates a relationship and enforces category constraints', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');

        const good = await store.createRelationship(scopeA, {
          relationshipTypeKey: 'SELLS',
          sourceEntityId: opp,
          targetEntityId: product,
          weight: 12,
          sourceSystem: 'helm',
        });
        const rel = expectOk(good, 'SELLS');
        assert.equal(rel.relationshipTypeKey, 'SELLS');
        assert.equal(rel.weight, 12);

        // CONVERTS_TO is finance→finance; an Opportunity is commercial.
        const bad = await store.createRelationship(scopeA, {
          relationshipTypeKey: 'CONVERTS_TO',
          sourceEntityId: opp,
          targetEntityId: product,
          sourceSystem: 'helm',
        });
        assert.equal(bad.ok, false, 'domain constraint must reject this');
        if (!bad.ok) assert.equal(bad.error.code, 'ontology.domain_constraint_violated');
      } finally {
        await cleanup?.();
      }
    });

    test('rejects a weight on a relationship type that does not carry one', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const a = await mkEntity(store, scopeA, 'Country', 'vn', 'Vietnam');
        const b = await mkEntity(store, scopeA, 'Enterprise', 'grp', 'Group');
        const r = await store.createRelationship(scopeA, {
          relationshipTypeKey: 'BELONGS_TO',
          sourceEntityId: a,
          targetEntityId: b,
          weight: 5,
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'ontology.invalid_attributes');
      } finally {
        await cleanup?.();
      }
    });

    test('rejects a self-referencing relationship', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const a = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        const r = await store.createRelationship(scopeA, {
          relationshipTypeKey: 'DEPENDS_ON',
          sourceEntityId: a,
          targetEntityId: a,
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error.code, 'graph.self_reference');
      } finally {
        await cleanup?.();
      }
    });

    test('removeRelationship closes validity and hides it from current reads', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        const rel = expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'SELLS',
            sourceEntityId: opp,
            targetEntityId: product,
            sourceSystem: 'helm',
          }),
          'create',
        );

        expectOk(await store.removeRelationship(scopeA, rel.id), 'remove');

        const current = expectOk(
          await store.findRelationships(scopeA, { eitherEndpoint: opp }),
          'current',
        );
        assert.equal(current.length, 0, 'closed edge is not current');

        const historical = expectOk(
          await store.findRelationships(scopeA, {
            eitherEndpoint: opp,
            asOf: rel.validFrom,
          }),
          'historical',
        );
        assert.equal(historical.length, 1, 'still visible at its valid time');
      } finally {
        await cleanup?.();
      }
    });

    // ------------------------------------------------------------ traversal

    test('getNeighbors respects direction and type filters', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const customer = await mkEntity(store, scopeA, 'Customer', 'rohto', 'Rohto Vietnam');
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');

        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'HELD_BY',
            sourceEntityId: opp,
            targetEntityId: customer,
            sourceSystem: 'helm',
          }),
          'HELD_BY',
        );
        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'SELLS',
            sourceEntityId: opp,
            targetEntityId: product,
            weight: 12,
            sourceSystem: 'helm',
          }),
          'SELLS',
        );

        const out = expectOk(
          await store.getNeighbors(scopeA, { entityId: opp, direction: 'out' }),
          'out',
        );
        assert.equal(out.length, 2);

        const inbound = expectOk(
          await store.getNeighbors(scopeA, { entityId: customer, direction: 'in' }),
          'in',
        );
        assert.equal(inbound.length, 1);
        assert.equal(inbound[0].entity.id, opp);

        const filtered = expectOk(
          await store.getNeighbors(scopeA, {
            entityId: opp,
            direction: 'out',
            relationshipTypeKeys: ['SELLS'],
          }),
          'filtered',
        );
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].entity.id, product);
      } finally {
        await cleanup?.();
      }
    });

    test('traverse walks to depth and reports path confidence', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const customer = await mkEntity(store, scopeA, 'Customer', 'rohto', 'Rohto Vietnam');
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        const inv = await mkEntity(store, scopeA, 'Inventory', 'sku-x-hcmc', 'SKU-X @ HCMC');

        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'HELD_BY',
            sourceEntityId: opp,
            targetEntityId: customer,
            confidence: 1,
            sourceSystem: 'helm',
          }),
          'r1',
        );
        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'SELLS',
            sourceEntityId: opp,
            targetEntityId: product,
            confidence: 0.7,
            weight: 12,
            sourceSystem: 'helm',
          }),
          'r2',
        );
        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'POSITIONS',
            sourceEntityId: inv,
            targetEntityId: product,
            confidence: 0.5,
            sourceSystem: 'helm',
          }),
          'r3',
        );

        const depth1 = expectOk(
          await store.traverse(scopeA, { start: [customer], maxDepth: 1, direction: 'both' }),
          'depth 1',
        );
        assert.equal(depth1.nodes.length, 2, 'customer + opportunity');

        const depth3 = expectOk(
          await store.traverse(scopeA, { start: [customer], maxDepth: 3, direction: 'both' }),
          'depth 3',
        );
        assert.equal(depth3.nodes.length, 4, 'reaches inventory');

        const productNode = depth3.nodes.find((n) => n.entity.id === product);
        assert.ok(productNode, 'product reached');
        assert.equal(productNode!.depth, 2);
        // 1.0 (HELD_BY) * 0.7 (SELLS) — a chain is never more certain than its links
        assert.equal(Math.round(productNode!.pathConfidence * 1000) / 1000, 0.7);

        const invNode = depth3.nodes.find((n) => n.entity.id === inv);
        assert.equal(Math.round(invNode!.pathConfidence * 1000) / 1000, 0.35);
      } finally {
        await cleanup?.();
      }
    });

    test('traverse requires a bounded depth', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const a = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        const r = await store.traverse(scopeA, { start: [a], maxDepth: 99, direction: 'both' });
        assert.equal(r.ok, false, 'excessive depth must be refused, not silently clamped');
        if (!r.ok) assert.equal(r.error.code, 'graph.depth_exceeded');
      } finally {
        await cleanup?.();
      }
    });

    test('traverse filters by entity type', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const customer = await mkEntity(store, scopeA, 'Customer', 'rohto', 'Rohto');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        for (const [key, target] of [
          ['HELD_BY', customer],
          ['SELLS', product],
        ] as const) {
          expectOk(
            await store.createRelationship(scopeA, {
              relationshipTypeKey: key,
              sourceEntityId: opp,
              targetEntityId: target,
              weight: key === 'SELLS' ? 1 : null,
              sourceSystem: 'helm',
            }),
            key,
          );
        }

        const onlyProducts = expectOk(
          await store.traverse(scopeA, {
            start: [opp],
            maxDepth: 2,
            direction: 'out',
            entityTypeKeys: ['Product'],
          }),
          'filtered traverse',
        );
        const reached = onlyProducts.nodes.filter((n) => n.depth > 0);
        assert.equal(reached.length, 1);
        assert.equal(reached[0].entity.entityTypeKey, 'Product');
      } finally {
        await cleanup?.();
      }
    });

    test('paths enumerates distinct routes between two entities', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');
        const product = await mkEntity(store, scopeA, 'Product', 'sku-x', 'SKU-X');
        const invA = await mkEntity(store, scopeA, 'Inventory', 'wh', 'Company WH');
        const invB = await mkEntity(store, scopeA, 'Inventory', 'dist', 'Distributor');

        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'SELLS',
            sourceEntityId: opp,
            targetEntityId: product,
            weight: 12,
            confidence: 0.9,
            sourceSystem: 'helm',
          }),
          'sells',
        );
        for (const inv of [invA, invB]) {
          expectOk(
            await store.createRelationship(scopeA, {
              relationshipTypeKey: 'CONSUMES',
              sourceEntityId: opp,
              targetEntityId: inv,
              weight: 1,
              confidence: 0.8,
              sourceSystem: 'helm',
            }),
            'consumes',
          );
          expectOk(
            await store.createRelationship(scopeA, {
              relationshipTypeKey: 'POSITIONS',
              sourceEntityId: inv,
              targetEntityId: product,
              confidence: 1,
              sourceSystem: 'helm',
            }),
            'positions',
          );
        }

        const found = expectOk(
          await store.paths(scopeA, opp, product, { maxDepth: 3, direction: 'both' }),
          'paths',
        );
        assert.ok(found.length >= 3, `expected direct + two via inventory, got ${found.length}`);
        const direct = found.find((p) => p.relationshipIds.length === 1);
        assert.ok(direct, 'the direct SELLS path exists');
        assert.equal(Math.round(direct!.pathConfidence * 100) / 100, 0.9);
      } finally {
        await cleanup?.();
      }
    });

    test('undirected relationship types are walkable from either end', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const oppA = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'This month');
        const oppB = await mkEntity(store, scopeA, 'Tender', 'opp-2', 'Next month');
        expectOk(
          await store.createRelationship(scopeA, {
            relationshipTypeKey: 'COMPETES_WITH',
            sourceEntityId: oppA,
            targetEntityId: oppB,
            sourceSystem: 'helm',
          }),
          'competes',
        );

        // Written A->B, but must be reachable from B with direction 'out'.
        const fromB = expectOk(
          await store.getNeighbors(scopeA, { entityId: oppB, direction: 'out' }),
          'from B',
        );
        assert.equal(fromB.length, 1, 'undirected edge is symmetric for traversal');
        assert.equal(fromB[0].entity.id, oppA);
      } finally {
        await cleanup?.();
      }
    });

    test('subtype queries are inheritance-aware', async () => {
      const { store, cleanup } = await harness.create();
      try {
        await mkEntity(store, scopeA, 'Customer', 'rohto', 'Rohto Vietnam');
        await mkEntity(store, scopeA, 'Distributor', 'dist-d', 'Distributor D');

        const customers = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Customer'] }),
          'customers',
        );
        assert.equal(customers.length, 2, 'Distributor is a Customer');

        const exact = expectOk(
          await store.findEntities(scopeA, {
            entityTypeKeys: ['Customer'],
            includeSubtypes: false,
          }),
          'exact',
        );
        assert.equal(exact.length, 1, 'subtypes excluded on request');
      } finally {
        await cleanup?.();
      }
    });

    // ------------------------------------------------------- tenant isolation

    test('organization A cannot read organization B entities', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const bId = await mkEntity(store, scopeB, 'Customer', 'secret', 'Org B Customer');
        await mkEntity(store, scopeA, 'Customer', 'mine', 'Org A Customer');

        const direct = expectOk(await store.getEntity(scopeA, bId), 'cross-org get');
        assert.equal(direct, null, 'org A must not read an org B entity by id');

        const listed = expectOk(
          await store.findEntities(scopeA, { entityTypeKeys: ['Customer'] }),
          'list',
        );
        assert.equal(listed.length, 1, 'only org A rows');
        assert.equal(listed[0].name, 'Org A Customer');
      } finally {
        await cleanup?.();
      }
    });

    test('traversal cannot escape the organization boundary', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const aEntity = await mkEntity(store, scopeA, 'Customer', 'mine', 'Org A Customer');
        await mkEntity(store, scopeB, 'Customer', 'theirs', 'Org B Customer');

        const walked = expectOk(
          await store.traverse(scopeA, { start: [aEntity], maxDepth: 5, direction: 'both' }),
          'traverse',
        );
        assert.equal(walked.nodes.length, 1, 'only org A is reachable');
        assert.ok(
          walked.nodes.every((n) => n.entity.orgId === scopeA.orgId),
          'no foreign org rows in the result',
        );
      } finally {
        await cleanup?.();
      }
    });

    test('a relationship cannot span two organizations', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const a = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Ours');
        const b = await mkEntity(store, scopeB, 'Product', 'sku-x', 'Theirs');
        const r = await store.createRelationship(scopeA, {
          relationshipTypeKey: 'SELLS',
          sourceEntityId: a,
          targetEntityId: b,
          weight: 1,
          sourceSystem: 'helm',
        });
        assert.equal(r.ok, false, 'cross-org edge must be refused');
      } finally {
        await cleanup?.();
      }
    });

    test('history is organization-scoped', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const bId = await mkEntity(store, scopeB, 'Product', 'sku-b', 'B product');
        const hist = expectOk(await store.getEntityHistory(scopeA, bId), 'cross-org history');
        assert.equal(hist.length, 0, 'org A sees no org B history');
      } finally {
        await cleanup?.();
      }
    });

    // ------------------------------------------------------------ provenance

    test('records and retrieves provenance for an entity', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const evt = expectOk(
          await store.startIngestionEvent(scopeA, 'memoire', 'memoire-connector@0.1.0', 'cursor-1'),
          'start ingestion',
        );
        const opp = await mkEntity(store, scopeA, 'Opportunity', 'opp-1', 'Tender');

        expectOk(
          await store.recordProvenance(scopeA, {
            subjectKind: 'entity',
            subjectId: opp,
            sourceField: 'probability',
            method: 'ingested',
            system: 'memoire',
            connector: 'memoire-connector@0.1.0',
            sourceObjectType: 'opportunity',
            sourceObjectId: 'opp-1',
            ingestionEventId: evt.id,
            transformation: 'probability = stage_probability / 100',
            inputs: null,
            actorId: null,
            confidence: 0.7,
            notes: null,
            payload: { stage_probability: 70 },
            observedAt: asValidTime('2026-09-18T11:02:00.000Z'),
          }),
          'record provenance',
        );

        const rows = expectOk(await store.getProvenance(scopeA, 'entity', opp), 'get provenance');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].system, 'memoire');
        assert.equal(rows[0].method, 'ingested');
        assert.equal(rows[0].sourceField, 'probability');
        assert.equal(rows[0].ingestionEventId, evt.id);
        assert.ok(rows[0].recordedAt, 'record time stamped');

        const finished = expectOk(
          await store.finishIngestionEvent(scopeA, evt.id, 'succeeded', 1),
          'finish',
        );
        assert.equal(finished.status, 'succeeded');
        assert.equal(finished.recordCount, 1);
      } finally {
        await cleanup?.();
      }
    });

    test('provenance is organization-scoped', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const bOpp = await mkEntity(store, scopeB, 'Opportunity', 'opp-b', 'B deal');
        expectOk(
          await store.recordProvenance(scopeB, {
            subjectKind: 'entity',
            subjectId: bOpp,
            sourceField: null,
            method: 'seeded',
            system: 'helm',
            connector: null,
            sourceObjectType: null,
            sourceObjectId: null,
            ingestionEventId: null,
            transformation: null,
            inputs: null,
            actorId: null,
            confidence: null,
            notes: null,
            payload: null,
            observedAt: null,
          }),
          'B provenance',
        );
        const seen = expectOk(await store.getProvenance(scopeA, 'entity', bOpp), 'cross-org');
        assert.equal(seen.length, 0);
      } finally {
        await cleanup?.();
      }
    });

    // --------------------------------------------------------------- aliases

    test('aliases resolve external identifiers to one canonical entity', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const rohto = await mkEntity(store, scopeA, 'Customer', 'rohto-vietnam', 'Rohto Vietnam');

        for (const [system, kind, value] of [
          ['memoire', 'source_id', 'a3f2c1d4'],
          ['erp', 'code', 'C004182'],
          ['finance', 'code', 'ROHTO-VN-001'],
        ] as const) {
          expectOk(
            await store.addAlias(scopeA, {
              entityId: rohto,
              system,
              aliasKind: kind,
              aliasValue: value,
              matchMethod: 'exact',
              confidence: 1,
              evidence: null,
              createdBy: null,
            }),
            `alias ${value}`,
          );
        }

        const byErp = expectOk(await store.findByAlias(scopeA, 'erp', 'C004182'), 'by erp');
        assert.equal(byErp.length, 1);
        assert.equal(byErp[0].id, rohto, 'ERP code resolves to the same entity');

        // Normalization: case and padding must not defeat the lookup.
        const messy = expectOk(await store.findByAlias(scopeA, 'finance', '  rohto-vn-001 '), 'messy');
        assert.equal(messy.length, 1);
        assert.equal(messy[0].id, rohto);

        const all = expectOk(await store.getAliases(scopeA, rohto), 'aliases');
        assert.equal(all.length, 3);
        assert.ok(all.every((a) => a.matchMethod === 'exact'));
      } finally {
        await cleanup?.();
      }
    });

    test('adding the same alias twice is idempotent', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const rohto = await mkEntity(store, scopeA, 'Customer', 'rohto', 'Rohto Vietnam');
        const input = {
          entityId: rohto,
          system: 'erp' as const,
          aliasKind: 'code' as const,
          aliasValue: 'C004182',
          matchMethod: 'exact' as const,
          confidence: 1,
          evidence: null,
          createdBy: null,
        };
        const first = expectOk(await store.addAlias(scopeA, input), 'first');
        const second = expectOk(await store.addAlias(scopeA, input), 'second');
        assert.equal(second.id, first.id, 're-asserting an identifier must not create a row');

        const all = expectOk(await store.getAliases(scopeA, rohto), 'aliases');
        assert.equal(all.length, 1, 'exactly one alias for one identifier');

        // The resolution must still return one entity, not one per alias row.
        const hits = expectOk(await store.findByAlias(scopeA, 'erp', 'C004182'), 'lookup');
        assert.equal(hits.length, 1, 'lookup returns distinct entities');
      } finally {
        await cleanup?.();
      }
    });

    test('alias lookup is organization-scoped', async () => {
      const { store, cleanup } = await harness.create();
      try {
        const bEntity = await mkEntity(store, scopeB, 'Customer', 'theirs', 'Their customer');
        expectOk(
          await store.addAlias(scopeB, {
            entityId: bEntity,
            system: 'erp',
            aliasKind: 'code',
            aliasValue: 'SHARED-CODE',
            matchMethod: 'exact',
            confidence: 1,
            evidence: null,
            createdBy: null,
          }),
          'B alias',
        );
        const found = expectOk(await store.findByAlias(scopeA, 'erp', 'SHARED-CODE'), 'A lookup');
        assert.equal(found.length, 0, 'org A must not resolve org B aliases');
      } finally {
        await cleanup?.();
      }
    });
  });
}
