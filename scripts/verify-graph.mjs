/**
 * verify:graph — the GraphStore contract holds, and tenant isolation cannot be
 * escaped through traversal.
 *
 * Runs against the in-memory adapter (no database needed), because the contract
 * is adapter-independent by construction. The Postgres adapter is held to the
 * same suite by packages/graph-store/test/postgres.conformance.test.mjs once
 * test credentials are configured, and its RLS behaviour is separately proven
 * server-side (see docs/architecture/phase-1-implemented.md).
 *
 *   1. The canonical enterprise graph builds, and builds idempotently.
 *   2. Traversal is bounded — an unbounded walk is refused, not clamped.
 *   3. Traversal cannot cross an organization boundary.
 *   4. Relationships cannot span organizations.
 *   5. Confidence degrades along a chain and never recovers.
 *   6. Provenance exists for every entity and relationship the fixture creates.
 *   7. Record-time history is preserved when a fact changes.
 */

import { buildSeedRegistry } from '../packages/ontology/src/index.ts';
import { asOrgId, asUserId, seqIdGen } from '../packages/shared/src/index.ts';
import { createInMemoryGraphStore } from '../packages/graph-store/src/inMemory.ts';
import { buildCanonicalScenario } from '../packages/graph-store/src/canonicalScenario.ts';

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const check = (rule, cond, detail) => {
  if (!cond) fail(rule, detail);
};

const mkScope = (org, user) => ({
  orgId: asOrgId(org),
  actorId: asUserId(user),
  role: 'admin',
  orgUnitIds: [],
  functions: [],
});

const scopeA = mkScope('11111111-1111-4111-8111-111111111111', 'aaaa1111-1111-4111-8111-111111111111');
const scopeB = mkScope('22222222-2222-4222-8222-222222222222', 'bbbb2222-2222-4222-8222-222222222222');

function newStore() {
  let tick = 0;
  const base = Date.parse('2026-09-19T08:00:00.000Z');
  return createInMemoryGraphStore({
    registry: buildSeedRegistry(),
    clock: { now: () => new Date(base + (tick += 1) * 1000) },
    idGen: seqIdGen('v'),
  });
}

const store = newStore();

// ------------------------------------------------- 1: canonical graph builds

const built = await buildCanonicalScenario(store, scopeA);
if (!built.ok) {
  fail('canonical-build', `${built.error.code}: ${built.error.message}`);
} else {
  const { ids, entityCount, relationshipCount } = built.value;
  check('canonical-build', entityCount > 25, `only ${entityCount} entities seeded`);
  check(
    'canonical-build',
    relationshipCount > 35,
    `only ${relationshipCount} relationships seeded`,
  );

  // idempotency
  const again = await buildCanonicalScenario(store, scopeA);
  check('idempotency', again.ok, 'a second build failed');
  const all = await store.findEntities(scopeA, { limit: 1000 });
  check(
    'idempotency',
    all.ok && all.value.length === entityCount,
    `rebuild changed entity count: ${all.ok ? all.value.length : 'read failed'} vs ${entityCount}`,
  );

  // ---------------------------------------- 2: traversal must be bounded
  const unbounded = await store.traverse(scopeA, {
    start: [ids.rohto],
    maxDepth: 99,
    direction: 'both',
  });
  check(
    'bounded-traversal',
    !unbounded.ok && unbounded.error.code === 'graph.depth_exceeded',
    'an excessive maxDepth was accepted instead of refused',
  );

  // ------------------------------- 5: confidence degrades along the chain
  const walk = await store.traverse(scopeA, {
    start: [ids.rohto],
    maxDepth: 4,
    direction: 'both',
  });
  if (!walk.ok) {
    fail('traversal', `${walk.error.code}: ${walk.error.message}`);
  } else {
    const deep = walk.value.nodes.filter((n) => n.depth >= 2);
    check('confidence-degrades', deep.length > 0, 'traversal reached nothing at depth >= 2');
    for (const n of walk.value.nodes) {
      check(
        'confidence-range',
        n.pathConfidence >= 0 && n.pathConfidence <= 1,
        `path confidence out of range for ${n.entity.name}: ${n.pathConfidence}`,
      );
    }
    // A node reached via a 0.7-confidence edge cannot be more certain than 0.7.
    const sku = walk.value.nodes.find((n) => n.entity.id === ids.skuX);
    check(
      'confidence-degrades',
      sku && sku.pathConfidence <= 0.7 + 1e-9,
      `SKU-X reached with confidence ${sku?.pathConfidence}, expected <= 0.7`,
    );
  }

  // --------------------------------------- 6: provenance for everything
  for (const [handle, id] of Object.entries(ids)) {
    const prov = await store.getProvenance(scopeA, 'entity', id);
    check(
      'provenance-coverage',
      prov.ok && prov.value.length > 0,
      `entity "${handle}" has no provenance record`,
    );
  }
  const rels = await store.findRelationships(scopeA, { limit: 1000 });
  if (rels.ok) {
    let missing = 0;
    for (const r of rels.value) {
      const prov = await store.getProvenance(scopeA, 'relationship', r.id);
      if (!prov.ok || prov.value.length === 0) missing += 1;
    }
    check('provenance-coverage', missing === 0, `${missing} relationships have no provenance`);
  }

  // ------------------------------ 7: record-time history on a real change
  const opp = await store.getEntity(scopeA, ids.oppNow);
  if (opp.ok && opp.value) {
    const updated = await store.updateEntity(scopeA, ids.oppNow, {
      confidence: 0.9,
      attributes: { ...opp.value.attributes, probability: 0.9 },
    });
    check('record-time', updated.ok && updated.value.outcome === 'updated', 'update did not apply');
    const hist = await store.getEntityHistory(scopeA, ids.oppNow);
    check(
      'record-time',
      hist.ok && hist.value.length === 2,
      `expected 2 versions after a change, got ${hist.ok ? hist.value.length : 'read failed'}`,
    );
    if (hist.ok && hist.value.length === 2) {
      check(
        'record-time',
        hist.value[0].snapshot.confidence === 0.7,
        'the superseded version lost the old belief',
      );
      check(
        'record-time',
        hist.value[0].recordedTo !== null && hist.value[1].recordedTo === null,
        'the record-time chain is not correctly closed',
      );
    }
  }

  // ------------------------------------------ 3 & 4: tenant isolation
  // Org B's graph goes into the SAME store on purpose: isolation that only
  // holds because the data lives elsewhere is not isolation.
  const bIn = await buildCanonicalScenario(store, scopeB);
  check('isolation-setup', bIn.ok, 'could not seed org B');
  if (bIn.ok) {
    const aOnly = await store.findEntities(scopeA, { limit: 1000 });
    check(
      'tenant-isolation',
      aOnly.ok && aOnly.value.every((e) => e.orgId === scopeA.orgId),
      'org A listing returned foreign-org rows',
    );
    check(
      'tenant-isolation',
      aOnly.ok && aOnly.value.length === entityCount,
      `org A sees ${aOnly.ok ? aOnly.value.length : '?'} entities, expected ${entityCount}`,
    );

    const crossGet = await store.getEntity(scopeA, bIn.value.ids.rohto);
    check(
      'tenant-isolation',
      crossGet.ok && crossGet.value === null,
      'org A read an org B entity by id',
    );

    const crossWalk = await store.traverse(scopeA, {
      start: [bIn.value.ids.rohto],
      maxDepth: 5,
      direction: 'both',
    });
    check(
      'tenant-isolation',
      crossWalk.ok && crossWalk.value.nodes.length === 0,
      'traversal from a foreign-org entity returned nodes',
    );

    const aWalkAll = await store.traverse(scopeA, {
      start: [ids.rohto],
      maxDepth: 6,
      direction: 'both',
    });
    check(
      'tenant-isolation',
      aWalkAll.ok && aWalkAll.value.nodes.every((n) => n.entity.orgId === scopeA.orgId),
      'traversal escaped the organization boundary',
    );

    const crossRel = await store.createRelationship(scopeA, {
      relationshipTypeKey: 'SELLS',
      sourceEntityId: ids.oppNow,
      targetEntityId: bIn.value.ids.skuX,
      weight: 1,
      sourceSystem: 'helm',
    });
    check(
      'tenant-isolation',
      !crossRel.ok,
      'a relationship spanning two organizations was accepted',
    );

    // The same alias value exists in both orgs; each must resolve only its own.
    const aliasA = await store.findByAlias(scopeA, 'erp', 'C004182');
    check(
      'tenant-isolation',
      aliasA.ok && aliasA.value.length === 1 && aliasA.value[0].orgId === scopeA.orgId,
      'alias lookup crossed the organization boundary',
    );
  }
}


// ------------------------------------------------------------------ report

if (failures.length === 0) {
  console.log('verify:graph — ok (canonical graph, bounded traversal, tenant isolation)');
  process.exit(0);
}

console.error(`verify:graph — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
process.exit(1);
