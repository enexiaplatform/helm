/**
 * The SAME ReviewStore conformance suite, against PostgresReviewStore.
 *
 * Needs an authenticated session against an ISOLATED Supabase environment,
 * which cannot be fabricated here, so it SKIPS with instructions until
 * credentials are given — the same debt (Blocker B) the other Postgres suites carry.
 *
 *   HELM_TEST_SUPABASE_URL=...        # project URL of a Supabase BRANCH
 *   HELM_TEST_SUPABASE_KEY=...        # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...        # a signed-in user's access token (an ADMIN of org A)
 *   HELM_TEST_ORG_A=<uuid>            # that user's org
 *   HELM_TEST_ORG_B=<uuid>            # a second org they are NOT a member of
 *   HELM_TEST_SNAPSHOT_ID=<uuid>      # a twin snapshot of org A
 *   npm test
 *
 * Never production: review records are append-only by design, so the suite leaves its rows behind.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const env = process.env;
const needed = ['HELM_TEST_SUPABASE_URL', 'HELM_TEST_SUPABASE_KEY', 'HELM_TEST_ACCESS_TOKEN', 'HELM_TEST_ORG_A', 'HELM_TEST_ORG_B', 'HELM_TEST_SNAPSHOT_ID'];

if (!needed.every((k) => env[k])) {
  describe('ReviewStore conformance — PostgresReviewStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(`Set ${needed.join(' / ')} (against a Supabase branch, not production) to run the Postgres half of the review store conformance suite. See the header of this file.`);
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresReviewStore } = await import('../src/postgres.ts');
  const { runReviewStoreConformanceSuite } = await import('../src/conformance.ts');
  const client = createClient(env.HELM_TEST_SUPABASE_URL, env.HELM_TEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${env.HELM_TEST_ACCESS_TOKEN}` } },
  });
  const { data } = await client.auth.getUser(env.HELM_TEST_ACCESS_TOKEN);
  const actorId = data?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');
  const mk = (org) => ({ orgId: asOrgId(org), actorId: asUserId(actorId), role: 'admin', orgUnitIds: [], functions: [] });
  runReviewStoreConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresReviewStore',
      async create() {
        return { store: createPostgresReviewStore({ client }), scopeA: mk(env.HELM_TEST_ORG_A), scopeB: mk(env.HELM_TEST_ORG_B), snapshotId: env.HELM_TEST_SNAPSHOT_ID, userId: asUserId(actorId), now: () => new Date() };
      },
    },
  );
}
