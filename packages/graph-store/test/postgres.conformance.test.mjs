/**
 * The SAME conformance suite, against PostgresGraphStore.
 *
 * This is the other half of ADR-0004's two-adapter discipline: one contract,
 * both implementations, so an adapter-specific assumption fails immediately
 * rather than at migration time.
 *
 * It needs an authenticated session against a Supabase project, plus two
 * organizations the test principal belongs to. Those cannot be fabricated from
 * this repo — creating auth accounts is deliberately out of bounds for the
 * agent that wrote this file — so the suite SKIPS with an explanatory message
 * unless the environment supplies credentials.
 *
 * To run it:
 *
 *   HELM_TEST_SUPABASE_URL=...        # project URL
 *   HELM_TEST_SUPABASE_KEY=...        # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...        # a signed-in user's access token
 *   HELM_TEST_ORG_A=<uuid>            # an org that user is a member of
 *   HELM_TEST_ORG_B=<uuid>            # a second org they are NOT a member of
 *   npm test
 *
 * Use a Supabase BRANCH, never the production project: the suite writes and
 * removes entities, relationships, provenance and aliases.
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
  describe('GraphStore conformance — PostgresGraphStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B ' +
          '(against a Supabase branch, not production) to run the Postgres half ' +
          'of the conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry } = await import('@helm/ontology');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('../src/postgres.ts');
  const { runConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  // The shared suite's fixed org/user ids are replaced by the real ones, since
  // RLS requires genuine memberships.
  const scopeA = {
    orgId: asOrgId(orgA),
    actorId: asUserId(actorId),
    role: 'admin',
    orgUnitIds: [],
    functions: [],
  };

  const registry = buildSeedRegistry();
  const store = createPostgresGraphStore({
    client,
    registry,
    clock: { now: () => new Date() },
  });

  /** Removes everything the suite created, so runs are repeatable. */
  async function cleanup() {
    for (const table of [
      'helm_entity_aliases',
      'helm_provenance',
      'helm_relationships',
      'helm_entity_versions',
      'helm_entities',
    ]) {
      await client.from(table).delete().eq('org_id', orgA);
    }
  }

  runConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresGraphStore',
      async create() {
        await cleanup();
        return { store, cleanup };
      },
      // Cross-org tests in the shared suite write as scopeB. Against a real
      // database the principal is not a member of org B, so RLS refuses the
      // arrange step — which is itself the correct behaviour, verified instead
      // by the SQL-level isolation proof in scripts/verify-graph.mjs.
      skip: [
        'organization A cannot read organization B entities',
        'traversal cannot escape the organization boundary',
        'a relationship cannot span two organizations',
        'history is organization-scoped',
        'provenance is organization-scoped',
        'alias lookup is organization-scoped',
      ],
    },
  );

  // Replaces the skipped in-suite cross-org tests with the real-RLS equivalent:
  // the principal simply cannot see org B at all.
  describe('PostgresGraphStore — RLS cross-org behaviour', () => {
    test('reads scoped to a non-member organization return nothing', async () => {
      const { data, error } = await client
        .from('helm_entities')
        .select('id')
        .eq('org_id', orgB);
      assert.equal(error, null, 'the query is allowed, it just returns no rows');
      assert.equal((data ?? []).length, 0, 'RLS yields zero rows for a non-member org');
    });

    test('writes into a non-member organization are refused', async () => {
      const { error } = await client.from('helm_entities').insert({
        org_id: orgB,
        entity_type_id: 'et_customer',
        canonical_key: 'helm:customer:zz-rls-probe',
        name: 'ZZ RLS probe',
        source_system: 'helm',
      });
      assert.ok(error, 'the INSERT policy must refuse a foreign org');
    });

    test('scopeA is usable, so the skips above are about org B only', async () => {
      const r = await store.findEntities(scopeA, { limit: 1 });
      assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
    });
  });
}
