/**
 * The SAME ValueGraph conformance suite, against PostgresValueGraph.
 *
 * The other half of ADR-0015's two-adapter discipline. Like the Phase 1
 * GraphStore suite, it needs an authenticated session against a Supabase
 * project — which cannot be fabricated here — so it SKIPS with instructions
 * until credentials are supplied.
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
 * nodes, links and observations.
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
  describe('ValueGraph conformance — PostgresValueGraph', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B ' +
          '(against a Supabase branch, not production) to run the Postgres half ' +
          'of the value-graph conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry } = await import('@helm/ontology');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('@helm/graph-store/postgres');
  const { createPostgresValueGraph } = await import('../src/postgres.ts');
  const { buildSeedValueRegistry } = await import('../src/registry.ts');
  const { runValueConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  const ontology = buildSeedRegistry();
  const clock = { now: () => new Date() };
  const graphStore = createPostgresGraphStore({ client, registry: ontology, clock });
  const valueGraph = createPostgresValueGraph({
    client,
    metrics: buildSeedValueRegistry(),
    ontology,
    graphStore,
    clock,
  });

  const scopeA = {
    orgId: asOrgId(orgA),
    actorId: asUserId(actorId),
    role: 'admin',
    orgUnitIds: [],
    functions: [],
  };
  const scopeB = {
    orgId: asOrgId(orgB),
    actorId: asUserId(actorId),
    role: 'admin',
    orgUnitIds: [],
    functions: [],
  };

  async function cleanup() {
    for (const table of [
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

  runValueConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresValueGraph',
      async create() {
        await cleanup();
        return { valueGraph, graphStore, scopeA, scopeB, cleanup };
      },
      // The shared suite arranges cross-org fixtures by writing as scopeB. Against
      // a real database the principal is not a member of org B, so RLS refuses the
      // arrange step — which is itself correct behaviour, verified separately by
      // the SQL-level isolation proof (see docs/architecture/layers/value-graph.md §Security).
      skip: [
        'organization A cannot see organization B value nodes',
        'a value link cannot span two organizations',
        'observations are organization-scoped',
        'a value node cannot attach to another organization entity',
      ],
    },
  );

  describe('PostgresValueGraph — RLS cross-org behaviour', () => {
    test('value nodes scoped to a non-member organization return nothing', async () => {
      const { data, error } = await client
        .from('helm_value_nodes')
        .select('id')
        .eq('org_id', orgB);
      assert.equal(error, null, 'the query is allowed, it just returns no rows');
      assert.equal((data ?? []).length, 0, 'RLS yields zero rows for a non-member org');
    });

    test('value observations cannot be updated or deleted', async () => {
      const upd = await client
        .from('helm_value_observations')
        .update({ numeric_value: 1 })
        .eq('org_id', orgA)
        .select('id');
      assert.ok(
        upd.error || (upd.data ?? []).length === 0,
        'observations must be append-only',
      );
      const del = await client
        .from('helm_value_observations')
        .delete()
        .eq('org_id', orgA)
        .select('id');
      assert.ok(
        del.error || (del.data ?? []).length === 0,
        'observations must not be deletable',
      );
    });
  });
}
