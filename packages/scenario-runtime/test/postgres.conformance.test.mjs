/**
 * The SAME ScenarioStore conformance suite, against PostgresScenarioStore.
 *
 * Needs an authenticated session against a Supabase project, which cannot be
 * fabricated here, so it SKIPS with instructions until credentials are given —
 * the same debt the Phase 1–3 Postgres suites carry.
 *
 *   HELM_TEST_SUPABASE_URL=...      # project URL
 *   HELM_TEST_SUPABASE_KEY=...      # anon key (RLS stays enforced)
 *   HELM_TEST_ACCESS_TOKEN=...      # a signed-in user's access token
 *   HELM_TEST_ORG_A=<uuid>          # an org that user is a member of
 *   HELM_TEST_ORG_B=<uuid>          # a second org they are NOT a member of
 *   npm test
 *
 * Use a Supabase BRANCH, never production. Scenario history is append-only by
 * design (revisions, simulations and constraint results cannot be deleted), so
 * the suite leaves its rows behind on the branch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.HELM_TEST_SUPABASE_URL;
const key = process.env.HELM_TEST_SUPABASE_KEY;
const token = process.env.HELM_TEST_ACCESS_TOKEN;
const orgA = process.env.HELM_TEST_ORG_A;
const orgB = process.env.HELM_TEST_ORG_B;

if (!(url && key && token && orgA && orgB)) {
  describe('ScenarioStore conformance — PostgresScenarioStore', () => {
    test('skipped: no test database credentials configured', (t) => {
      t.skip(
        'Set HELM_TEST_SUPABASE_URL / _KEY / _ACCESS_TOKEN / _ORG_A / _ORG_B ' +
          '(against a Supabase branch, not production) to run the Postgres half of the ' +
          'scenario store conformance suite. See the header of this file.',
      );
    });
  });
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const { buildSeedRegistry, canonicalKey } = await import('@helm/ontology');
  const { asOrgId, asUserId } = await import('@helm/shared');
  const { createPostgresGraphStore } = await import('@helm/graph-store/postgres');
  const { createPostgresValueGraph } = await import('@helm/value-graph/postgres');
  const { buildSeedValueRegistry } = await import('@helm/value-graph');
  const { createPostgresScenarioStore } = await import('../src/postgres.ts');
  const { createPostgresCalculationStore } = await import('@helm/propagation-engine/postgres');
  const { ENGINE_VERSION } = await import('@helm/propagation-engine');
  const { runScenarioStoreConformanceSuite } = await import('../src/conformance.ts');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData } = await client.auth.getUser(token);
  const actorId = userData?.user?.id;
  assert.ok(actorId, 'HELM_TEST_ACCESS_TOKEN did not resolve to a user');

  const clock = { now: () => new Date() };
  const ontology = buildSeedRegistry();
  const graphStore = createPostgresGraphStore({ client, registry: ontology, clock });
  const valueGraph = createPostgresValueGraph({
    client, metrics: buildSeedValueRegistry(), ontology, graphStore, clock,
  });
  const mk = (org) => ({ orgId: asOrgId(org), actorId: asUserId(actorId), role: 'admin', orgUnitIds: [], functions: [] });
  const run = `${Date.now()}`;

  runScenarioStoreConformanceSuite(
    { describe, it: test, assert },
    {
      name: 'PostgresScenarioStore',
      async create() {
        const scopeA = mk(orgA);
        const product = await graphStore.upsertEntity(scopeA, {
          entityTypeKey: 'Inventory', canonicalKey: canonicalKey('helm', 'inventory', `conformance-${run}`),
          name: 'Conformance stock', sourceSystem: 'helm', attributes: { ownership: 'own' },
        });
        assert.ok(product.ok, 'inventory entity');
        const node = await valueGraph.upsertValueNode(scopeA, {
          metricKey: 'AvailableInventory', subjectEntityId: product.value.entity.id,
          timeHorizon: 'current', label: 'Conformance stock',
        });
        assert.ok(node.ok, 'value node');
        return {
          store: createPostgresScenarioStore({ client, clock }),
          scopeA,
          scopeB: mk(orgB),
          async scenarioEntity(k) {
            const e = await graphStore.upsertEntity(scopeA, {
              entityTypeKey: 'Scenario', canonicalKey: canonicalKey('helm', 'scenario', `${k}-${run}`),
              name: k, sourceSystem: 'helm', attributes: { kind: 'variant' },
            });
            assert.ok(e.ok, 'scenario entity');
            return e.value.entity.id;
          },
          targetNodeId: node.value.id,
          targetMetricKey: 'AvailableInventory',
          async calculationRun(revisionId, scenarioEntityId, fork) {
            const calcStore = createPostgresCalculationStore({ client, metrics: buildSeedValueRegistry(), clock });
            const r = await calcStore.createRun(scopeA, {
              status: 'RUNNING', triggerType: 'SCENARIO',
              context: {
                effectiveAsOf: fork.effectiveAsOf, recordedThrough: fork.recordedThrough, horizon: 'quarter',
                preference: fork.policy, scenarioEntityId: revisionId ? scenarioEntityId : null,
                rootNodeIds: [], rootMetricKeys: [], subjectEntityIds: [], engineVersion: ENGINE_VERSION,
                period: null, scenarioRevisionId: revisionId,
              },
              completedAt: null, replayOfRunId: null, notes: 'conformance', createdBy: scopeA.actorId,
            });
            assert.ok(r.ok, 'calculation run');
            return r.value.id;
          },
          now: () => new Date(),
        };
      },
    },
  );
}
