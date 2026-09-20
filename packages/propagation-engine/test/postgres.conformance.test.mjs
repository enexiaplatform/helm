/**
 * The SAME CalculationStore conformance suite, against PostgresCalculationStore.
 *
 * The other half of ADR-0015's two-adapter discipline. Like the Phase 1 and
 * Phase 2 suites, it needs an authenticated session against a Supabase project —
 * which cannot be fabricated here — so it SKIPS with instructions until
 * credentials are supplied.
 *
 * To run it:
 *
 *   HELM_TEST_SUPABASE_URL=...      # project URL
 *   HELM_TEST_SUPABASE_KEY=...      # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...      # a signed-in user's access token
 *   HELM_TEST_ORG_A=<uuid>          # an org that user is a member of
 *   HELM_TEST_ORG_B=<uuid>          # a second org they are NOT a member of
 *   npm test
 *
 * Use a Supabase BRANCH, never production: the suite writes and removes value
 * nodes, observations, calculation runs and traces.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.HELM_TEST_SUPABASE_URL;
const key = process.env.HELM_TEST_SUPABASE_KEY;
const token = process.env.HELM_TEST_ACCESS_TOKEN;
const orgA = process.env.HELM_TEST_ORG_A;
const orgB = process.env.HELM_TEST_ORG_B;

const configured = Boolean(url && key && token && orgA && orgB);

if (!configured) {
  describe('CalculationStore conformance — PostgresCalculationStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B ' +
          '(against a Supabase branch, not production) to run the Postgres half ' +
          'of the calculation conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry } = await import('@helm/ontology');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('@helm/graph-store/postgres');
  const { buildCanonicalScenario } = await import('@helm/graph-store');
  const { createPostgresValueGraph } = await import('@helm/value-graph/postgres');
  const { buildSeedValueRegistry, buildCanonicalValueChain } = await import('@helm/value-graph');
  const { createCalculationRegistry } = await import('../src/registry.ts');
  const { createPostgresCalculationStore } = await import('../src/postgres.ts');
  const { createPropagationEngine } = await import('../src/engine.ts');
  const { meridianValueModelV1 } = await import('../src/meridianValueModelV1.ts');
  const { runCalculationConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  const unwrap = (r, what) => {
    assert.equal(r.ok, true, `${what}: ${r.ok ? '' : r.error.code + ' — ' + r.error.message}`);
    return r.value;
  };

  const ontology = buildSeedRegistry();
  const metrics = buildSeedValueRegistry();
  const clock = { now: () => new Date() };
  const graphStore = createPostgresGraphStore({ client, registry: ontology, clock });
  const valueGraph = createPostgresValueGraph({
    client,
    metrics,
    ontology,
    graphStore,
    clock,
  });
  const store = createPostgresCalculationStore({ client, metrics, clock });
  const registry = unwrap(
    createCalculationRegistry(meridianValueModelV1, metrics),
    'calculation registry',
  );
  const engine = unwrap(
    createPropagationEngine({ registry, valueGraph, graphStore, ontology, store, clock }),
    'engine',
  );

  const mkScope = (org) => ({
    orgId: asOrgId(org),
    actorId: asUserId(actorId),
    role: 'admin',
    orgUnitIds: [],
    functions: [],
  });
  const scopeA = mkScope(orgA);
  const scopeB = mkScope(orgB);

  async function cleanup() {
    // Steps before runs before observations: children first, so a failed
    // cascade cannot leave orphans behind in a shared database.
    for (const table of [
      'helm_calculation_steps',
      'helm_calculation_runs',
      'helm_value_observations',
      'helm_value_links',
      'helm_value_nodes',
      'helm_provenance',
      'helm_relationships',
      'helm_entity_versions',
      'helm_entities',
    ]) {
      await client.from(table).delete().eq('org_id', orgA);
    }
  }

  runCalculationConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresCalculationStore',
      async create() {
        await cleanup();
        unwrap(await buildCanonicalScenario(graphStore, scopeA), 'entity graph');
        const chain = unwrap(
          await buildCanonicalValueChain(valueGraph, graphStore, scopeA),
          'value chain',
        );
        return {
          engine,
          store,
          valueGraph,
          graphStore,
          scopeA,
          scopeB,
          nodeIds: chain.nodeIds,
          asOf: new Date('2026-09-19T12:00:00.000Z'),
          cleanup,
        };
      },
      // The shared suite's cross-tenant checks arrange fixtures as scopeB. Against
      // a real database the principal is not a member of org B, so RLS refuses the
      // arrange step — which is itself the correct behaviour, verified separately
      // by the SQL-level isolation proof (see phase-3-implemented.md §Security).
      skip: ['a completed run cannot be closed from another organization'],
    },
  );

  describe('PostgresCalculationStore — RLS and append-only behaviour', () => {
    test('calculation runs scoped to a non-member organization return nothing', async () => {
      const { data, error } = await client
        .from('helm_calculation_runs')
        .select('id')
        .eq('org_id', orgB);
      assert.equal(error, null, 'the query is allowed, it just returns no rows');
      assert.equal((data ?? []).length, 0, 'RLS yields zero rows for a non-member org');
    });

    test('calculation steps cannot be updated or deleted', async () => {
      const upd = await client
        .from('helm_calculation_steps')
        .update({ output_value: '1' })
        .eq('org_id', orgA)
        .select('id');
      assert.ok(
        upd.error || (upd.data ?? []).length === 0,
        'a recorded derivation must be append-only',
      );
      const del = await client
        .from('helm_calculation_steps')
        .delete()
        .eq('org_id', orgA)
        .select('id');
      assert.ok(
        del.error || (del.data ?? []).length === 0,
        'and a recorded derivation must not be deletable',
      );
    });

    test('shipped calculation metadata is readable and not writable', async () => {
      const { data, error } = await client
        .from('helm_calculations')
        .select('id, key, version, owner, rationale, expression, status')
        .is('org_id', null);
      assert.equal(error, null);
      assert.equal((data ?? []).length, meridianValueModelV1.length, 'all nine are present');
      for (const row of data ?? []) {
        assert.ok(row.owner.length > 0, `${row.key} names an owner`);
        assert.ok(row.rationale.length >= 20, `${row.key} explains itself`);
        assert.ok(row.expression.length > 0, `${row.key} carries a readable formula`);
      }

      // A tenant cannot edit what HELM ships: is_system rows have org_id NULL,
      // and every write policy requires org_id IS NOT NULL.
      const upd = await client
        .from('helm_calculations')
        .update({ owner: 'someone else' })
        .is('org_id', null)
        .select('id');
      assert.ok(upd.error || (upd.data ?? []).length === 0, 'shipped definitions are read-only');
    });

    test('an ACTUAL observation cannot claim to have been calculated', async () => {
      // The Phase 3 CHECK: a calculation_run_id belongs on a DERIVED or
      // SCENARIO observation and on nothing else.
      const nodes = await client
        .from('helm_value_nodes')
        .select('id')
        .eq('org_id', orgA)
        .limit(1);
      const nodeId = (nodes.data ?? [])[0]?.id;
      assert.ok(nodeId, 'the canonical chain left a value node to test against');

      const runs = await client
        .from('helm_calculation_runs')
        .select('id')
        .eq('org_id', orgA)
        .limit(1);
      const runId = (runs.data ?? [])[0]?.id;

      const bad = await client.from('helm_value_observations').insert({
        org_id: orgA,
        node_id: nodeId,
        observation_type: 'ACTUAL',
        numeric_value: 1,
        unit_type: 'units',
        effective_at: new Date().toISOString(),
        source_system: 'erp',
        calculation_run_id: runId,
      });
      assert.ok(bad.error, 'an ACTUAL with a calculation run is refused');
    });
  });
}
